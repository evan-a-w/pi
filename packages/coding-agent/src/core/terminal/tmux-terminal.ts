/**
 * A persistent terminal backed by a tmux session.
 *
 * Deliberately separate from the agent bash tool (core/tools/bash.ts): that one
 * is a stateless one-shot per tool call, this one is a long-lived interactive
 * shell for a human. They share no state and no semantics. Terminal output
 * never enters session history and is never shown to the model.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { TmuxControlParser } from "./control-protocol.ts";
import { chunkHexArgs, requireTmux, runTmux, toSendKeysHex } from "./tmux-cli.ts";

/** Scrollback lines tmux retains, and the depth we replay to new clients. */
const HISTORY_LIMIT = 5000;
const REPLAY_LINES = 1000;

export interface TmuxTerminalOptions {
	/** Initial working directory for the shell. */
	cwd: string;
	/** Shell to run. Defaults to the user's $SHELL, then /bin/bash. Ignored when `command` is set. */
	shell?: string;
	cols?: number;
	rows?: number;
	/** Environment for the shell. Defaults to the pi process environment. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Full argv to run instead of an interactive shell (program plus its
	 * arguments, e.g. `[process.execPath, cliPath, "--session", file]`). Used by
	 * the TUI terminal to attach a real pi interactive session instead of a shell.
	 */
	command?: string[];
}

export type TmuxTerminalSubscriber = (data: Buffer) => void;

/**
 * Resolve the shell for an interactive terminal.
 *
 * Unlike the agent shell (which is non-interactive and rc-free for
 * reproducibility), a human terminal should honour $SHELL and load rc files.
 */
function resolveShell(explicit: string | undefined): string {
	if (explicit) return explicit;
	const fromEnv = process.env.SHELL;
	if (fromEnv) return fromEnv;
	return "/bin/bash";
}

export class TmuxTerminal {
	readonly id: string;
	readonly sessionName: string;
	private readonly tmuxPath: string;
	private readonly options: TmuxTerminalOptions;
	private control: ChildProcess | undefined;
	private readonly parser = new TmuxControlParser();
	private readonly subscribers = new Set<TmuxTerminalSubscriber>();
	private cols: number;
	private rows: number;
	private disposed = false;
	private exitListeners = new Set<(reason: string | undefined) => void>();
	/** Serializes send-keys invocations so concurrent writes cannot interleave. */
	private writeQueue: Promise<void> = Promise.resolve();

	private constructor(tmuxPath: string, sessionName: string, options: TmuxTerminalOptions) {
		this.tmuxPath = tmuxPath;
		this.sessionName = sessionName;
		this.id = sessionName;
		this.options = options;
		this.cols = options.cols ?? 80;
		this.rows = options.rows ?? 24;
	}

	/**
	 * Create the tmux session and attach a control-mode client.
	 * @throws TmuxUnavailableError when tmux is missing or too old
	 */
	static async create(options: TmuxTerminalOptions): Promise<TmuxTerminal> {
		const tmuxPath = await requireTmux();
		const sessionName = `pi-${process.pid}-${randomBytes(3).toString("hex")}`;
		const terminal = new TmuxTerminal(tmuxPath, sessionName, options);
		await terminal.start();
		return terminal;
	}

	private async start(): Promise<void> {
		const command = this.options.command ?? [resolveShell(this.options.shell), "-i"];

		// Create the session detached first, as a one-shot command. Combining this
		// with -C would exit immediately: a control client started with -d has
		// nothing attached to stream, so it prints %exit and dies.
		const created = await runTmux(this.tmuxPath, [
			"new-session",
			// -A makes this attach-or-create, so a name collision is not a failure.
			"-A",
			"-d",
			"-s",
			this.sessionName,
			"-x",
			String(this.cols),
			"-y",
			String(this.rows),
			"-c",
			this.options.cwd,
			"--",
			...command,
		]);
		if (created.exitCode !== 0) {
			throw new Error(`Failed to create tmux session: ${created.stderr.trim() || `exit ${created.exitCode}`}`);
		}

		// Bound scrollback so a runaway process cannot grow tmux memory without limit.
		await runTmux(this.tmuxPath, ["set-option", "-t", this.sessionName, "history-limit", String(HISTORY_LIMIT)]);

		// Then attach a long-lived control client to stream %output.
		const control = spawn(this.tmuxPath, ["-C", "attach-session", "-t", this.sessionName], {
			env: this.options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			// Detached so the tmux server is not in pi's process group; killing pi
			// must not take the shell down mid-command.
			detached: process.platform !== "win32",
		});
		this.control = control;

		control.stdout?.setEncoding("utf8");
		control.stdout?.on("data", (chunk: string) => this.handleControlChunk(chunk));
		control.stderr?.on("data", () => {});
		control.on("error", () => this.notifyExit("control-client-error"));
		control.on("exit", () => {
			if (!this.disposed) this.notifyExit("control-client-exited");
		});
	}

	private handleControlChunk(chunk: string): void {
		for (const notification of this.parser.push(chunk)) {
			if (notification.kind === "output") {
				this.emit(notification.data);
			} else if (notification.kind === "exit") {
				this.notifyExit(notification.reason);
			}
		}
	}

	private emit(data: Buffer): void {
		for (const subscriber of this.subscribers) {
			try {
				subscriber(data);
			} catch {
				// A failing subscriber must not stall the stream for others.
			}
		}
	}

	private notifyExit(reason: string | undefined): void {
		for (const listener of this.exitListeners) {
			try {
				listener(reason);
			} catch {
				// Ignore listener failures during teardown.
			}
		}
	}

	/** Subscribe to live output. Returns an unsubscribe function. */
	subscribe(subscriber: TmuxTerminalSubscriber): () => void {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}

	/** Listen for terminal death. Returns an unsubscribe function. */
	onExit(listener: (reason: string | undefined) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	get size(): { cols: number; rows: number } {
		return { cols: this.cols, rows: this.rows };
	}

	get isAlive(): boolean {
		return !this.disposed && this.control !== undefined && this.control.exitCode === null;
	}

	/**
	 * Write raw bytes to the shell as if typed.
	 *
	 * Sent as hex via `send-keys -H` so control characters (Ctrl-C), escape
	 * sequences and multi-byte UTF-8 all take the same path with no key-name
	 * ambiguity. Writes are serialized to preserve byte order.
	 */
	write(data: Buffer): Promise<void> {
		if (this.disposed || data.length === 0) return Promise.resolve();
		const chunks = chunkHexArgs(toSendKeysHex(data));
		this.writeQueue = this.writeQueue.then(async () => {
			for (const chunk of chunks) {
				if (this.disposed) return;
				await runTmux(this.tmuxPath, ["send-keys", "-t", this.sessionName, "-H", ...chunk]);
			}
		});
		return this.writeQueue;
	}

	/** Resize the terminal. Works with no client attached, which is our case. */
	async resize(cols: number, rows: number): Promise<void> {
		if (this.disposed) return;
		const clampedCols = Math.max(2, Math.min(1000, Math.floor(cols)));
		const clampedRows = Math.max(2, Math.min(1000, Math.floor(rows)));
		if (clampedCols === this.cols && clampedRows === this.rows) return;
		this.cols = clampedCols;
		this.rows = clampedRows;
		await runTmux(this.tmuxPath, [
			"resize-window",
			"-t",
			this.sessionName,
			"-x",
			String(clampedCols),
			"-y",
			String(clampedRows),
		]);
	}

	/**
	 * Current screen plus scrollback, with ANSI attributes preserved, so a newly
	 * attached or reconnecting client sees a coherent screen.
	 *
	 * tmux is the scrollback authority here, which is why this reads from tmux
	 * rather than replaying a server-side ring buffer.
	 */
	async captureReplay(): Promise<string> {
		if (this.disposed) return "";
		const { stdout, exitCode } = await runTmux(this.tmuxPath, [
			"capture-pane",
			"-p",
			"-e",
			"-J",
			"-t",
			this.sessionName,
			"-S",
			`-${REPLAY_LINES}`,
		]);
		if (exitCode !== 0) return "";
		// capture-pane pads to the pane height; trailing blank lines add nothing.
		return stdout.replace(/\n+$/, "");
	}

	/** Kill the tmux session and detach the control client. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.subscribers.clear();
		await runTmux(this.tmuxPath, ["kill-session", "-t", this.sessionName]);
		const control = this.control;
		this.control = undefined;
		if (control && control.exitCode === null) {
			control.stdin?.end();
			control.kill("SIGTERM");
		}
		this.exitListeners.clear();
	}
}
