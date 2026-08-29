import { effect, type Signal } from "@preact/signals";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { RpcCommand, RpcResponse, TerminalOpenData } from "../protocol.ts";
import {
	client,
	connected,
	dataAs,
	pushToast,
	terminalOpen,
	terminalOutput,
	tuiActive,
	tuiOutput,
	tuiWaiting,
} from "../state.ts";
import { themeName } from "../theme.ts";

/** Keys a touch keyboard cannot produce, exposed as buttons on narrow screens. */
const MOBILE_KEYS: Array<{ label: string; bytes: number[] }> = [
	{ label: "Esc", bytes: [0x1b] },
	{ label: "Tab", bytes: [0x09] },
	{ label: "^C", bytes: [0x03] },
	{ label: "^D", bytes: [0x04] },
	{ label: "^Z", bytes: [0x1a] },
	{ label: "←", bytes: [0x1b, 0x5b, 0x44] },
	{ label: "↓", bytes: [0x1b, 0x5b, 0x42] },
	{ label: "↑", bytes: [0x1b, 0x5b, 0x41] },
	{ label: "→", bytes: [0x1b, 0x5b, 0x43] },
];

/** Debounce for the resize RPC: xterm's fit() stays synchronous, only the network call is delayed. */
const RESIZE_DEBOUNCE_MS = 150;

/**
 * The terminal_* and tui_* RPC command families share an identical wire shape
 * (base64 payloads, {termId, cols, rows, replay} on open); this is the only
 * thing that differs between the two xterm-backed views.
 */
interface TerminalCommandFamily {
	label: string;
	open: (cols: number, rows: number) => RpcCommand;
	input: (data: string) => RpcCommand;
	resize: (cols: number, rows: number) => RpcCommand;
	outputSignal: Signal<{ data: string; seq: number } | undefined>;
	/** Revert the view that owns this family back to its inactive state (e.g. after an open failure). */
	deactivate: () => void;
}

const terminalFamily: TerminalCommandFamily = {
	label: "Terminal",
	open: (cols, rows) => ({ type: "terminal_open", cols, rows }),
	input: (data) => ({ type: "terminal_input", data }),
	resize: (cols, rows) => ({ type: "terminal_resize", cols, rows }),
	outputSignal: terminalOutput,
	deactivate: () => {
		terminalOpen.value = false;
	},
};

const tuiFamily: TerminalCommandFamily = {
	label: "TUI",
	open: (cols, rows) => ({ type: "tui_open", cols, rows }),
	input: (data) => ({ type: "tui_input", data }),
	resize: (cols, rows) => ({ type: "tui_resize", cols, rows }),
	outputSignal: tuiOutput,
	deactivate: () => {
		tuiActive.value = false;
	},
};

/**
 * Read a theme CSS custom property. The web UI populates --pi-* from the same
 * theme JSON the TUI uses, so the terminal matches the rest of the app.
 */
function cssVar(name: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value || fallback;
}

function xtermTheme(): { background: string; foreground: string; cursor: string } {
	return {
		background: cssVar("--pi-cardBg", "#1e1e24"),
		foreground: cssVar("--pi-text", "#d4d4d4"),
		cursor: cssVar("--pi-accent", "#8abeb7"),
	};
}

function encodeUtf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decodeBase64(data: string): string {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	// stream: true keeps multi-byte characters split across chunks intact.
	return new TextDecoder("utf-8").decode(bytes, { stream: true });
}

/** Send a command, routing a rejection (e.g. disconnected) through the same toast convention as the rest of the app. */
function sendInput(command: RpcCommand, label: string): void {
	void client.command(command).catch((error: unknown) => {
		pushToast(`${label} input lost: ${error instanceof Error ? error.message : String(error)}`, "error");
	});
}

type SessionStatus = "opening" | "ready" | "reconnecting";

/**
 * Wire an xterm.js instance to a terminal_* or tui_* RPC command family:
 * open on mount, forward keystrokes as input, stream output, and resize on
 * host resize. Shared by TerminalView and TuiView.
 */
function useXtermSession(
	active: boolean,
	hostRef: RefObject<HTMLDivElement | null>,
	termRef: RefObject<XTerm | null>,
	family: TerminalCommandFamily,
): SessionStatus {
	const [status, setStatus] = useState<SessionStatus>("opening");

	useEffect(() => {
		if (!active || !hostRef.current) return;
		setStatus("opening");

		const term = new XTerm({
			cursorBlink: true,
			fontSize: 13,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			theme: xtermTheme(),
			// Scrollback lives in tmux; a modest local buffer is enough for smooth scrolling.
			scrollback: 2000,
			allowProposedApi: true,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(hostRef.current);
		fit.fit();
		termRef.current = term;
		// Focus immediately: the previously-focused element (e.g. the editor) is
		// unmounted the instant this view replaces it, so early keystrokes should
		// land in xterm's own input buffering rather than nowhere.
		term.focus();

		let disposed = false;

		// Local echo is the shell's job; forward every keystroke as raw bytes.
		const dataSub = term.onData((data) => {
			sendInput(family.input(encodeUtf8(data)), family.label);
		});

		async function openAndReplay(isReconnect: boolean): Promise<void> {
			if (isReconnect) setStatus("reconnecting");
			let response: RpcResponse;
			try {
				response = await client.command(family.open(term.cols, term.rows));
			} catch (error) {
				if (disposed) return;
				pushToast(
					`Failed to open ${family.label}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				family.deactivate();
				return;
			}
			if (disposed) return;
			if (!response.success) {
				pushToast(response.error || `Failed to open ${family.label}`, "error");
				family.deactivate();
				return;
			}
			const data = dataAs<TerminalOpenData>(response, response.command);
			// Reconnect replays are a fresh full scrollback capture; reset so it
			// doesn't append below whatever was already on screen.
			if (isReconnect) term.reset();
			if (data?.replay) {
				term.write(decodeBase64(data.replay));
			}
			term.focus();
			setStatus("ready");
		}

		void openAndReplay(false);

		// Re-open (and get a fresh replay) whenever the socket reconnects while this
		// view is active, so a dropped connection doesn't silently lose output.
		let sawDisconnect = false;
		const stopWatchingConnection = effect(() => {
			const isConnected = connected.value;
			if (!isConnected) {
				sawDisconnect = true;
				setStatus("reconnecting");
				return;
			}
			if (sawDisconnect) {
				sawDisconnect = false;
				void openAndReplay(true);
			}
		});

		// Keep the terminal's colors in sync with footer theme switching; xterm
		// does not pick up CSS variable changes on its own.
		const stopWatchingTheme = effect(() => {
			// Re-run whenever themeName changes; cssVar reads the freshly-applied CSS.
			void themeName.value;
			term.options.theme = xtermTheme();
		});

		// Stream server output into xterm.
		const unsubscribeOutput = family.outputSignal.subscribe((chunk) => {
			if (chunk) term.write(decodeBase64(chunk.data));
		});

		let resizeTimer: ReturnType<typeof setTimeout> | undefined;
		const resizeObserver = new ResizeObserver(() => {
			fit.fit();
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				resizeTimer = undefined;
				sendInput(family.resize(term.cols, term.rows), family.label);
			}, RESIZE_DEBOUNCE_MS);
		});
		resizeObserver.observe(hostRef.current);

		return () => {
			disposed = true;
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeObserver.disconnect();
			stopWatchingConnection();
			stopWatchingTheme();
			unsubscribeOutput();
			dataSub.dispose();
			term.dispose();
			termRef.current = null;
			// Reset so a later remount's fresh XTerm doesn't get this session's last
			// chunk replayed into it the instant it subscribes (signals fire their
			// current value synchronously on subscribe). Covers unmounting without an
			// explicit close, e.g. the subagents panel taking over from TuiView.
			family.outputSignal.value = undefined;
		};
		// `family` is a stable module-level constant; only `active` should retrigger this.
	}, [active]);

	return status;
}

function sendMobileKey(command: (data: string) => RpcCommand, bytes: number[], label: string): void {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	sendInput(command(btoa(binary)), label);
}

function MobileKeyRow({ family, onKey }: { family: TerminalCommandFamily; onKey?: () => void }) {
	return (
		<div class="terminal-keys">
			{MOBILE_KEYS.map((key) => (
				<button
					type="button"
					key={key.label}
					class="terminal-key"
					onClick={() => {
						sendMobileKey(family.input, key.bytes, family.label);
						onKey?.();
					}}
				>
					{key.label}
				</button>
			))}
		</div>
	);
}

function StatusOverlay({ status }: { status: SessionStatus }) {
	if (status === "ready") return null;
	return <div class="terminal-status-overlay">{status === "reconnecting" ? "Reconnecting…" : "Opening…"}</div>;
}

export function TerminalView() {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<XTerm | null>(null);
	const isOpen = terminalOpen.value;

	const status = useXtermSession(isOpen, hostRef, termRef, terminalFamily);

	if (!isOpen) return null;

	return (
		<div class="terminal-panel">
			<div class="terminal-header">
				<span class="terminal-title">terminal</span>
				<button
					type="button"
					class="terminal-close"
					title="Hide terminal (session keeps running)"
					onClick={() => {
						terminalOpen.value = false;
					}}
				>
					×
				</button>
			</div>
			<div class="terminal-host-wrap">
				<div class="terminal-host" ref={hostRef} />
				<StatusOverlay status={status} />
			</div>
			<MobileKeyRow family={terminalFamily} onKey={() => termRef.current?.focus()} />
		</div>
	);
}

/**
 * Fills the chat area with the real pi interactive TUI, in place of
 * ChatList/CommandResultCard/WidgetAreas/Editor. No close button of its own:
 * the header `tui` button (see app.tsx) owns toggling, since closing also
 * needs to send tui_close and resync the chat view.
 */
export function TuiView() {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<XTerm | null>(null);
	const isActive = tuiActive.value;
	// While the session is still streaming/compacting, attaching a second pi
	// process would fork the session file, so we wait for the run to settle
	// (state.ts clears tuiWaiting on settle) before opening the terminal.
	const isWaiting = tuiWaiting.value;

	const status = useXtermSession(isActive && !isWaiting, hostRef, termRef, tuiFamily);

	if (!isActive) return null;

	return (
		<div class="tui-view">
			<div class="terminal-host-wrap">
				<div class="tui-host" ref={hostRef} />
				{isWaiting ? (
					<div class="terminal-status-overlay">Waiting for the current response to finish…</div>
				) : (
					<StatusOverlay status={status} />
				)}
			</div>
			<MobileKeyRow family={tuiFamily} onKey={() => termRef.current?.focus()} />
		</div>
	);
}
