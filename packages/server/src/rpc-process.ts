import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSessionEvent,
	ENV_AGENT_DIR,
	type RpcCommand,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { isBunBinary } from "./config.ts";
import { namespaceAgentDirOverride } from "./namespaces.ts";

interface PendingRequest {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export class RpcProcessInstance {
	readonly process: ChildProcess;

	private exited = false;
	private nextRequestId = 0;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(error?: Error) => void>();
	private uiRequestHandler: ((request: RpcExtensionUIRequest) => void) | undefined;

	constructor(options: { cwd: string; sessionFile?: string; namespace?: string }) {
		const rpcCommand = this.getSpawnCommand();
		if (options.sessionFile) {
			rpcCommand.args.push("--session", options.sessionFile);
		}
		// Non-default namespaces get their own PI_CODING_AGENT_DIR, which points
		// coding-agent's config paths (auth.json, settings.json, sessions/) at a
		// separate tree instead of the normal ~/.pi/agent. See namespaces.ts.
		const namespaceAgentDir = namespaceAgentDirOverride(options.namespace);
		// CLAUDE_CONFIG_DIR: the builtin claude-bridge provider authenticates via
		// the Claude Code CLI's own HOME-scoped credentials (~/.claude), entirely
		// outside pi's auth.json. Without scoping it per namespace, every namespace
		// silently rides the machine-global Claude login, defeating credential
		// separation. A fresh namespace therefore starts logged out of Claude too;
		// run `claude login` inside the session's terminal to opt that namespace in.
		const env = namespaceAgentDir
			? {
					...process.env,
					[ENV_AGENT_DIR]: namespaceAgentDir,
					CLAUDE_CONFIG_DIR: join(namespaceAgentDir, "claude"),
				}
			: process.env;
		this.process = spawn(rpcCommand.command, rpcCommand.args, {
			cwd: options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!this.process.stdin || !this.process.stdout) {
			throw new Error("Failed to create RPC process stdio");
		}
		this.attachListeners();
	}

	private getSpawnCommand(): { command: string; args: string[] } {
		if (isBunBinary) {
			return {
				command: join(dirname(process.execPath), process.platform === "win32" ? "pi.exe" : "pi"),
				args: ["--mode", "rpc"],
			};
		}
		// Dev mode: run via tsx so TypeScript source works without a build step.
		const srcDir = dirname(fileURLToPath(import.meta.url));
		const repoRoot = dirname(dirname(dirname(srcDir)));
		const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
		return {
			command: process.execPath,
			args: [
				tsxBin,
				"--tsconfig",
				join(repoRoot, "tsconfig.json"),
				fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")),
			],
		};
	}

	private attachListeners(): void {
		this.process.stdout?.setEncoding("utf8");
		this.process.stdout?.on("data", (chunk: string) => {
			this.stdoutBuffer += chunk;
			while (true) {
				const newlineIndex = this.stdoutBuffer.indexOf("\n");
				if (newlineIndex === -1) {
					break;
				}
				const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
				this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
				if (!line) {
					continue;
				}
				this.handleLine(line);
			}
		});

		this.process.stderr?.setEncoding("utf8");
		this.process.stderr?.on("data", (chunk: string) => {
			this.stderrBuffer += chunk;
		});

		this.process.once("error", (error) => {
			this.exited = true;
			const wrapped = new Error(`RPC process error: ${error.message}. Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(wrapped);
			this.notifyExit(wrapped);
		});

		this.process.once("exit", (code, signal) => {
			this.exited = true;
			const error = new Error(`RPC process exited (code=${code} signal=${signal}). Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(error);
			this.notifyExit(error);
		});
	}

	private handleLine(line: string): void {
		let parsed: { type?: string; id?: string };
		try {
			parsed = JSON.parse(line) as { type?: string; id?: string };
		} catch {
			// A malformed line on the child's stdout must not take the whole server
			// down; drop it and keep serving this and every other instance.
			return;
		}
		switch (parsed.type) {
			case "response": {
				if (!parsed.id) {
					return;
				}
				const pending = this.pendingRequests.get(parsed.id);
				if (!pending) {
					return;
				}
				this.pendingRequests.delete(parsed.id);
				pending.resolve(parsed as RpcResponse);
				return;
			}

			case "extension_ui_request": {
				this.uiRequestHandler?.(parsed as RpcExtensionUIRequest);
				return;
			}

			default: {
				for (const listener of this.eventListeners) {
					listener(parsed as AgentSessionEvent);
				}
			}
		}
	}

	private rejectAllPending(error: Error): void {
		for (const [id, pending] of this.pendingRequests) {
			this.pendingRequests.delete(id);
			pending.reject(error);
		}
	}

	private notifyExit(error?: Error): void {
		for (const listener of this.exitListeners) {
			listener(error);
		}
	}

	send(command: RpcCommand): Promise<RpcResponse> {
		if (this.exited) {
			throw new Error(`RPC process is not running. Stderr: ${this.stderrBuffer}`);
		}
		const id = command.id ?? `server_${++this.nextRequestId}_${randomUUID()}`;
		const fullCommand = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.process.stdin?.write(`${JSON.stringify(fullCommand)}\n`, (error) => {
				if (!error) {
					return;
				}
				this.pendingRequests.delete(id);
				reject(toError(error));
			});
		});
	}

	handleUiResponse(response: RpcExtensionUIResponse): void {
		if (this.exited) {
			return;
		}
		this.process.stdin?.write(`${JSON.stringify(response)}\n`);
	}

	setUiRequestHandler(handler?: (request: RpcExtensionUIRequest) => void): void {
		this.uiRequestHandler = handler;
	}

	onEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	onExit(listener: (error?: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	async dispose(): Promise<void> {
		this.uiRequestHandler = undefined;
		this.rejectAllPending(new Error("RPC process disposed"));
		if (this.exited) {
			return;
		}
		this.process.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			this.process.once("exit", () => resolve());
		});
	}
}

export function createRpcProcessInstance(options: {
	cwd: string;
	sessionFile?: string;
	namespace?: string;
}): RpcProcessInstance {
	return new RpcProcessInstance(options);
}
