/**
 * RPC session bridge: speaks the pi RPC protocol (docs/rpc.md) on behalf of an
 * AgentSessionRuntime, fanning events out to any number of attached clients.
 *
 * Used by RPC mode (a single stdout client, see rpc-mode.ts) and by web mode
 * (one client per WebSocket connection, see src/web/).
 *
 * - Session events and extension UI requests are broadcast to all clients.
 * - Command responses are sent only to the requesting client.
 * - Extension UI dialogs are first-response-wins: when one client answers, all
 *   other clients receive `extension_ui_cancel` for that request id.
 */

import * as crypto from "node:crypto";
import type { FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { resolvePiSelfInvocation } from "../../core/self-invocation.ts";
import { disposeTerminal, getExistingTerminal, getOrCreateTerminal, TmuxTerminal } from "../../core/terminal/index.ts";
import { closeWatcher, watchWithErrorHandler } from "../../utils/fs-watch.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import {
	RPC_BUILTIN_COMMANDS,
	type RpcCommand,
	type RpcExtensionUICancel,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcResponse,
	type RpcSessionState,
	type RpcSlashCommand,
} from "./rpc-types.ts";

export interface RpcClientConnection {
	/** Send an outbound protocol message (event, response, or extension UI message) to this client. */
	send(message: object): void;
	/** Optional backpressure: resolves when this client is ready to accept more data. */
	drain?(): Promise<void>;
}

export interface RpcClientHandle {
	/** Handle one inbound JSON protocol line from this client. */
	receive(line: string): Promise<void>;
	/** Detach the client. No further messages are sent to it. */
	detach(): void;
}

export interface RpcBridgeCallbacks {
	/** An extension requested shutdown via its shutdown handler. */
	onShutdownRequested?(): void;
}

export interface RpcBridgeOptions {
	/**
	 * Bind extensions with the RPC UI context (default true). Set false when
	 * another frontend (e.g. the TUI) owns the extension UI context; dialogs
	 * can then still be offered to RPC clients via offerDialog().
	 */
	bindExtensions?: boolean;
	/**
	 * Override the argv used to spawn the TUI terminal (tui_open). Defaults to
	 * relaunching pi itself attached to the current session file. Tests inject
	 * a lightweight stand-in so they do not need a real model or provider.
	 */
	resolveTuiCommand?: (context: { sessionFile: string; cwd: string }) => string[];
}

function defaultResolveTuiCommand(context: { sessionFile: string }): string[] {
	const invocation = resolvePiSelfInvocation();
	return [invocation.command, ...invocation.args, "--session", context.sessionFile];
}

/**
 * How long to wait after the session file changes before reloading it while a
 * TUI is attached. The TUI writes one jsonl line per entry (messages, tool
 * calls, model/thinking changes, ...) which can arrive in quick bursts while
 * streaming; debouncing avoids tearing the session down and rebuilding it on
 * every single line.
 */
const SESSION_FILE_WATCH_DEBOUNCE_MS = 300;

function success<T extends RpcCommand["type"]>(id: string | undefined, command: T, data?: object | null): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

function error(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message };
}

/**
 * Extension event bus channels forwarded to RPC clients as `extension_event`.
 * Currently the pi-subagents namespace; extend as other extensions add
 * channels that web clients should observe.
 */
function isForwardableExtensionChannel(channel: string): boolean {
	return channel.startsWith("subagent:") || channel.startsWith("subagents:");
}

export class RpcBridge {
	private readonly runtimeHost: AgentSessionRuntime;
	private readonly callbacks: RpcBridgeCallbacks;
	private session: AgentSessionRuntime["session"];
	private readonly clients = new Set<RpcClientConnection>();
	private readonly pendingExtensionRequests = new Map<
		string,
		{ resolve: (response: RpcExtensionUIResponse) => void; reject: (error: Error) => void }
	>();
	private unsubscribe: (() => void) | undefined;
	private unsubscribeBackpressure: (() => void) | undefined;
	/** Extension event bus subscriptions (pi.events channels), unsubscribed on rebind. */
	private unsubscribeExtensionEvents: (() => void) | undefined;
	/**
	 * Terminal output subscription. The terminal itself is process-scoped and
	 * deliberately outside the session graph, so rebindSession() must not touch it.
	 */
	private unsubscribeTerminal: (() => void) | undefined;
	/**
	 * The TUI terminal (tui_open/tui_input/tui_resize/tui_close): a real pi
	 * interactive process attached to this bridge's current session file.
	 * Session-scoped and owned by this bridge, unlike the process-scoped shell
	 * terminal above, so it is not touched by rebindSession() either: switching
	 * sessions while a TUI is attached is prevented by the blocking guard on
	 * write commands, and the TUI's own exit/close paths trigger the reload.
	 */
	private tuiTerminal: TmuxTerminal | undefined;
	/**
	 * Set synchronously for the duration of TmuxTerminal.create() in tui_open, before
	 * `this.tuiTerminal` is assigned. Two purposes: dedupes concurrent tui_open calls
	 * (mirrors terminal-manager.ts's getOrCreateTerminal), and closes the TOCTOU window
	 * where a write command could slip in between the streaming/compacting check and the
	 * terminal actually being attached (isBlockedByTui treats this the same as a live
	 * tuiTerminal).
	 */
	private tuiCreating: Promise<TmuxTerminal> | undefined;
	private unsubscribeTui: (() => void) | undefined;
	/**
	 * Watches the session file while the TUI is attached, so the bridge's
	 * in-memory state (and clients following it) catches up as the TUI writes to
	 * it, rather than only on tui_close/tui_exit. Debounced; alive only while
	 * tuiTerminal is alive.
	 */
	private sessionFileWatcher: FSWatcher | undefined;
	private sessionFileWatchTimer: ReturnType<typeof setTimeout> | undefined;
	/** Serializes reloadSessionFromDisk() calls so a watch-triggered reload never overlaps a tui_close/tui_exit one. */
	private sessionReloadQueue: Promise<void> = Promise.resolve();

	private readonly options: RpcBridgeOptions;

	constructor(runtimeHost: AgentSessionRuntime, callbacks: RpcBridgeCallbacks = {}, options: RpcBridgeOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.callbacks = callbacks;
		this.options = options;
		this.session = runtimeHost.session;
	}

	get clientCount(): number {
		return this.clients.size;
	}

	async start(): Promise<void> {
		if (this.options.bindExtensions !== false) {
			this.runtimeHost.setRebindSession(async () => {
				await this.rebindSession();
			});
		}
		await this.rebindSession();
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribeBackpressure?.();
		this.unsubscribeTerminal?.();
		this.unsubscribeTerminal = undefined;
		this.unsubscribeTui?.();
		this.unsubscribeTui = undefined;
		this.stopWatchingSessionFile();
		this.clients.clear();
		// The terminal is scoped to the pi run; a graceful shutdown ends it so a
		// tmux session is not leaked per run.
		await disposeTerminal();
		const tuiTerminal = this.tuiTerminal;
		this.tuiTerminal = undefined;
		await tuiTerminal?.dispose();
	}

	/**
	 * Stream terminal output to all clients. Attached once per terminal, not per
	 * client: every client shares the one terminal, like `tmux attach`.
	 */
	private attachTerminalStream(terminal: TmuxTerminal): void {
		if (this.unsubscribeTerminal) return;
		const unsubscribeOutput = terminal.subscribe((data) => {
			this.broadcast({ type: "terminal_output", data: data.toString("base64") });
		});
		const unsubscribeExit = terminal.onExit((reason) => {
			this.broadcast({ type: "terminal_exit", reason });
			this.unsubscribeTerminal?.();
			this.unsubscribeTerminal = undefined;
		});
		this.unsubscribeTerminal = () => {
			unsubscribeOutput();
			unsubscribeExit();
		};
	}

	/**
	 * Stream TUI output to all clients, same broadcast model as the shell
	 * terminal above. Unlike the shell terminal, exit reloads the session from
	 * disk: the TUI writes to the same session file this bridge holds open, so
	 * in-memory state must catch up with whatever happened while it was attached.
	 */
	private attachTuiStream(terminal: TmuxTerminal): void {
		if (this.unsubscribeTui) return;
		const unsubscribeOutput = terminal.subscribe((data) => {
			this.broadcast({ type: "tui_output", data: data.toString("base64") });
		});
		const unsubscribeExit = terminal.onExit((reason) => {
			this.stopWatchingSessionFile();
			this.broadcast({ type: "tui_exit", reason });
			this.unsubscribeTui?.();
			this.unsubscribeTui = undefined;
			this.tuiTerminal = undefined;
			void this.reloadSessionFromDisk();
		});
		this.unsubscribeTui = () => {
			unsubscribeOutput();
			unsubscribeExit();
		};
	}

	/**
	 * Watch the session file while the TUI is attached, so writes the TUI makes
	 * (model/thinking changes, messages, ...) are picked up live instead of only
	 * on tui_close/tui_exit. Watches the containing directory rather than the
	 * file itself: a brand-new session's file does not exist on disk yet (it is
	 * created lazily on first append), which would make `fs.watch` on the file
	 * throw immediately, and watching the directory also survives the file being
	 * replaced outright rather than appended to. Idempotent; a no-op if already
	 * watching.
	 */
	private startWatchingSessionFile(sessionFile: string): void {
		if (this.sessionFileWatcher) return;
		const dir = dirname(sessionFile);
		const fileName = basename(sessionFile);
		this.sessionFileWatcher =
			watchWithErrorHandler(
				dir,
				(_event, changedName) => {
					// changedName is null on some platforms; reload rather than miss a change.
					if (!changedName || changedName === fileName) this.scheduleSessionFileReload();
				},
				() => this.stopWatchingSessionFile(),
			) ?? undefined;
	}

	private stopWatchingSessionFile(): void {
		closeWatcher(this.sessionFileWatcher);
		this.sessionFileWatcher = undefined;
		if (this.sessionFileWatchTimer) {
			clearTimeout(this.sessionFileWatchTimer);
			this.sessionFileWatchTimer = undefined;
		}
	}

	private scheduleSessionFileReload(): void {
		if (this.sessionFileWatchTimer) {
			clearTimeout(this.sessionFileWatchTimer);
		}
		this.sessionFileWatchTimer = setTimeout(() => {
			this.sessionFileWatchTimer = undefined;
			void this.reloadSessionWhileTuiAttached();
		}, SESSION_FILE_WATCH_DEBOUNCE_MS);
	}

	/**
	 * Reload triggered by the session file watcher, i.e. the TUI wrote to the
	 * session while it is still attached (not exiting/closing). Broadcasts
	 * `session_reloaded` so clients know to re-sync; tui_close/tui_exit already
	 * have their own signal for that, so this only fires for the live case.
	 */
	private async reloadSessionWhileTuiAttached(): Promise<void> {
		if (!this.tuiTerminal?.isAlive) return;
		await this.reloadSessionFromDisk();
		if (this.tuiTerminal?.isAlive) {
			this.broadcast({ type: "session_reloaded" });
		}
	}

	/**
	 * Reload the current session from disk after the TUI (a separate process
	 * with its own in-memory copy) exits, is closed, or writes to the session
	 * file while still attached, so this bridge's state reflects whatever it
	 * wrote. Reuses the same internal path as the `switch_session` command,
	 * pointed at the same file. Calls are serialized so a watch-triggered reload
	 * can never overlap the tui_close/tui_exit reload.
	 */
	private async reloadSessionFromDisk(): Promise<void> {
		const run = this.sessionReloadQueue.then(() => this.performSessionReloadFromDisk());
		this.sessionReloadQueue = run.catch(() => {});
		return run;
	}

	private async performSessionReloadFromDisk(): Promise<void> {
		const sessionFile = this.session.sessionFile;
		if (!sessionFile) return;
		const result = await this.runtimeHost.switchSession(sessionFile);
		if (!result.cancelled) {
			await this.rebindSession();
		}
	}

	/**
	 * Command types that mutate the session (its content, its file, or which file
	 * this bridge points at) and therefore race with a TUI process writing to the
	 * same session file. Reads (get_state, get_messages, ...) and bridge-local
	 * settings (set_model, set_thinking_level, ...) are left open.
	 */
	private static readonly TUI_BLOCKED_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set<RpcCommand["type"]>([
		"prompt",
		"steer",
		"follow_up",
		"new_session",
		"switch_session",
		"fork",
		"clone",
		"change_cwd",
		"compact",
		"set_session_name",
	]);

	/** True while a TUI is attached (or being created) and `type` would race writes with it. */
	private isBlockedByTui(type: RpcCommand["type"]): boolean {
		const tuiAttached = Boolean(this.tuiTerminal?.isAlive) || this.tuiCreating !== undefined;
		return tuiAttached && RpcBridge.TUI_BLOCKED_COMMANDS.has(type);
	}

	attachClient(connection: RpcClientConnection): RpcClientHandle {
		this.clients.add(connection);
		return {
			receive: (line) => this.handleInputLine(connection, line),
			detach: () => {
				this.clients.delete(connection);
			},
		};
	}

	private broadcast(message: object, except?: RpcClientConnection): void {
		for (const client of this.clients) {
			if (client !== except) {
				client.send(message);
			}
		}
	}

	private broadcastCancel(id: string, except?: RpcClientConnection): void {
		const message: RpcExtensionUICancel = { type: "extension_ui_cancel", id };
		this.broadcast(message, except);
	}

	/** Helper for dialog methods with signal/timeout support */
	private createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				this.broadcastCancel(id);
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					this.broadcastCancel(id);
					resolve(defaultValue);
				}, opts.timeout);
			}

			this.pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			this.broadcast({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		const bridge = this;
		return {
			select: (title, options, opts) =>
				this.createDialogPromise(
					opts,
					undefined,
					{ method: "select", title, options, timeout: opts?.timeout },
					(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				),

			confirm: (title, message, opts) =>
				this.createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
					"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
				),

			input: (title, placeholder, opts) =>
				this.createDialogPromise(
					opts,
					undefined,
					{ method: "input", title, placeholder, timeout: opts?.timeout },
					(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				),

			notify(message: string, type?: "info" | "warning" | "error"): void {
				// Fire and forget - no response needed
				bridge.broadcast({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "notify",
					message,
					notifyType: type,
				} as RpcExtensionUIRequest);
			},

			onTerminalInput(): () => void {
				// Raw terminal input not supported over RPC
				return () => {};
			},

			setStatus(key: string, text: string | undefined): void {
				// Fire and forget - no response needed
				bridge.broadcast({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setStatus",
					statusKey: key,
					statusText: text,
				} as RpcExtensionUIRequest);
			},

			setWorkingMessage(_message?: string): void {
				// Working message not supported over RPC - requires TUI loader access
			},

			setWorkingVisible(_visible: boolean): void {
				// Working visibility not supported over RPC - requires TUI loader access
			},

			setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
				// Working indicator customization not supported over RPC - requires TUI loader access
			},

			setHiddenThinkingLabel(_label?: string): void {
				// Hidden thinking label not supported over RPC - requires TUI message rendering access
			},

			setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
				// Only support string arrays over RPC - factory functions are ignored
				if (content === undefined || Array.isArray(content)) {
					bridge.broadcast({
						type: "extension_ui_request",
						id: crypto.randomUUID(),
						method: "setWidget",
						widgetKey: key,
						widgetLines: content as string[] | undefined,
						widgetPlacement: options?.placement,
					} as RpcExtensionUIRequest);
				}
				// Component factories are not supported over RPC - would need TUI access
			},

			setFooter(_factory: unknown): void {
				// Custom footer not supported over RPC - requires TUI access
			},

			setHeader(_factory: unknown): void {
				// Custom header not supported over RPC - requires TUI access
			},

			setTitle(title: string): void {
				// Fire and forget - host can implement terminal title control
				bridge.broadcast({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setTitle",
					title,
				} as RpcExtensionUIRequest);
			},

			async custom() {
				// Custom UI not supported over RPC
				return undefined as never;
			},

			pasteToEditor(text: string): void {
				// Paste handling not supported over RPC - falls back to setEditorText
				this.setEditorText(text);
			},

			setEditorText(text: string): void {
				// Fire and forget - host can implement editor control
				bridge.broadcast({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "set_editor_text",
					text,
				} as RpcExtensionUIRequest);
			},

			getEditorText(): string {
				// Synchronous method can't wait for RPC response
				// Host should track editor state locally if needed
				return "";
			},

			async editor(title: string, prefill?: string): Promise<string | undefined> {
				const id = crypto.randomUUID();
				return new Promise((resolve, reject) => {
					bridge.pendingExtensionRequests.set(id, {
						resolve: (response: RpcExtensionUIResponse) => {
							if ("cancelled" in response && response.cancelled) {
								resolve(undefined);
							} else if ("value" in response) {
								resolve(response.value);
							} else {
								resolve(undefined);
							}
						},
						reject,
					});
					bridge.broadcast({
						type: "extension_ui_request",
						id,
						method: "editor",
						title,
						prefill,
					} as RpcExtensionUIRequest);
				});
			},

			addAutocompleteProvider(): void {
				// Autocomplete provider composition is not supported over RPC
			},

			setEditorComponent(): void {
				// Custom editor components not supported over RPC
			},

			getEditorComponent() {
				// Custom editor components not supported over RPC
				return undefined;
			},

			get theme() {
				return theme;
			},

			getAllThemes() {
				return [];
			},

			getTheme(_name: string) {
				return undefined;
			},

			setTheme(_theme: string | Theme) {
				// Theme switching not supported over RPC
				return { success: false, error: "Theme switching not supported over RPC" };
			},

			getToolsExpanded() {
				// Tool expansion not supported over RPC - no TUI
				return false;
			},

			setToolsExpanded(_expanded: boolean) {
				// Tool expansion not supported over RPC - no TUI
			},
		};
	}

	async rebindSession(): Promise<void> {
		this.session = this.runtimeHost.session;
		const session = this.session;
		if (this.options.bindExtensions === false) {
			this.resubscribe(session);
			return;
		}
		await session.bindExtensions({
			uiContext: this.createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => this.runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await this.runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return this.runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				this.callbacks.onShutdownRequested?.();
			},
			onError: (err) => {
				this.broadcast({
					type: "extension_error",
					extensionPath: err.extensionPath,
					event: err.event,
					error: err.error,
				});
			},
		});

		this.resubscribe(session);
	}

	private resubscribe(session: AgentSessionRuntime["session"]): void {
		this.unsubscribe?.();
		this.unsubscribeBackpressure?.();
		this.unsubscribeExtensionEvents?.();
		this.unsubscribe = session.subscribe((event) => {
			this.broadcast(event);
		});
		this.unsubscribeBackpressure = session.agent.subscribe(async () => {
			const drains: Promise<void>[] = [];
			for (const client of this.clients) {
				if (client.drain) drains.push(client.drain());
			}
			await Promise.all(drains);
		});
		// Forward extension-emitted events to clients (e.g. pi-subagents run
		// lifecycle: subagent:async-started, subagent:foreground-complete, ...).
		const extensionEvents = session.extensionEvents;
		if (extensionEvents) {
			this.unsubscribeExtensionEvents = extensionEvents.on("*", (channel, data) => {
				if (isForwardableExtensionChannel(channel)) {
					this.broadcast({ type: "extension_event", channel, data });
				}
			});
		}
	}

	/**
	 * Offer a dialog to all attached clients. First response wins; other clients
	 * are cancelled automatically by the response path. Used when the extension
	 * UI context is owned elsewhere (e.g. the TUI) and dialogs are multiplexed.
	 */
	offerDialog(request: Record<string, unknown>, onResponse: (response: RpcExtensionUIResponse) => void): string {
		const id = crypto.randomUUID();
		this.pendingExtensionRequests.set(id, { resolve: onResponse, reject: () => {} });
		this.broadcast({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		return id;
	}

	/** Dismiss a dialog previously offered via offerDialog on all clients (e.g. answered locally). */
	dismissDialog(id: string): void {
		this.pendingExtensionRequests.delete(id);
		this.broadcastCancel(id);
	}

	/** Broadcast a fire-and-forget extension UI request (notify, setStatus, setWidget, ...). */
	broadcastUiRequest(request: Record<string, unknown>): void {
		this.broadcast({ type: "extension_ui_request", id: crypto.randomUUID(), ...request } as RpcExtensionUIRequest);
	}

	private async handleCommand(command: RpcCommand, client: RpcClientConnection): Promise<RpcResponse | undefined> {
		const id = command.id;
		const session = this.session;

		if (this.isBlockedByTui(command.type)) {
			return error(id, command.type, "TUI is attached to this session");
		}

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								client.send(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							client.send(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await this.runtimeHost.newSession(options);
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					cwd: session.sessionManager.getCwd(),
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRuntime.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRuntime.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Terminal
			//
			// A persistent interactive shell, separate from `bash` above: it keeps
			// cwd, environment and running processes across commands, and its output
			// never enters session history or the model's context.
			// =================================================================

			case "terminal_open": {
				try {
					const terminal = await getOrCreateTerminal({
						cwd: session.sessionManager.getCwd(),
						cols: command.cols,
						rows: command.rows,
					});
					// Resize to this client's viewport; last writer wins across clients.
					if (command.cols !== undefined && command.rows !== undefined) {
						await terminal.resize(command.cols, command.rows);
					}
					this.attachTerminalStream(terminal);
					// Replay scrollback so a reconnecting client sees a coherent screen.
					const replay = await terminal.captureReplay();
					const { cols, rows } = terminal.size;
					return success(id, "terminal_open", {
						termId: terminal.id,
						cols,
						rows,
						replay: Buffer.from(replay, "utf8").toString("base64"),
					});
				} catch (e) {
					return error(id, "terminal_open", e instanceof Error ? e.message : String(e));
				}
			}

			case "terminal_input": {
				const terminal = getExistingTerminal();
				if (!terminal) {
					return error(id, "terminal_input", "No terminal is open");
				}
				await terminal.write(Buffer.from(command.data, "base64"));
				return success(id, "terminal_input");
			}

			case "terminal_resize": {
				const terminal = getExistingTerminal();
				if (!terminal) {
					return error(id, "terminal_resize", "No terminal is open");
				}
				await terminal.resize(command.cols, command.rows);
				return success(id, "terminal_resize");
			}

			case "terminal_close": {
				this.unsubscribeTerminal?.();
				this.unsubscribeTerminal = undefined;
				await disposeTerminal();
				return success(id, "terminal_close");
			}

			// =================================================================
			// TUI
			//
			// The real pi interactive TUI, attached to this same session file and
			// running as a separate process in a tmux session (like the terminal
			// above). Only one writer may touch the session at a time, so `prompt`,
			// `steer` and `follow_up` are rejected while this is alive (see
			// isBlockedByTui). Closing or exiting reloads the session from disk.
			// =================================================================

			case "tui_open": {
				try {
					if (this.tuiTerminal?.isAlive) {
						// Reattach: resize to this client's viewport and replay scrollback.
						if (command.cols !== undefined && command.rows !== undefined) {
							await this.tuiTerminal.resize(command.cols, command.rows);
						}
						this.attachTuiStream(this.tuiTerminal);
						const replay = await this.tuiTerminal.captureReplay();
						const { cols, rows } = this.tuiTerminal.size;
						return success(id, "tui_open", {
							termId: this.tuiTerminal.id,
							cols,
							rows,
							replay: Buffer.from(replay, "utf8").toString("base64"),
						});
					}

					// A creation is already in flight (concurrent tui_open calls, e.g. two tabs
					// racing to attach): await the same terminal instead of spawning a second one.
					if (this.tuiCreating) {
						const terminal = await this.tuiCreating;
						if (command.cols !== undefined && command.rows !== undefined) {
							await terminal.resize(command.cols, command.rows);
						}
						this.attachTuiStream(terminal);
						const replay = await terminal.captureReplay();
						const { cols, rows } = terminal.size;
						return success(id, "tui_open", {
							termId: terminal.id,
							cols,
							rows,
							replay: Buffer.from(replay, "utf8").toString("base64"),
						});
					}

					if (session.isStreaming || session.isCompacting) {
						return error(id, "tui_open", "Cannot open the TUI while the session is streaming or compacting");
					}

					const sessionFile = session.sessionFile;
					if (!sessionFile) {
						return error(id, "tui_open", "TUI requires a persisted session (this session has no session file)");
					}
					const cwd = session.sessionManager.getCwd();
					const resolveTuiCommand = this.options.resolveTuiCommand ?? defaultResolveTuiCommand;

					// Set before the await so a second tui_open (or a write command gated by
					// isBlockedByTui) landing before this resolves sees the in-flight creation
					// rather than racing it. No await happens between here and the assignment
					// below, so this is race-free despite the lack of a lock.
					const creating = TmuxTerminal.create({
						cwd,
						cols: command.cols,
						rows: command.rows,
						env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
						command: resolveTuiCommand({ sessionFile, cwd }),
					}).then((terminal) => {
						this.tuiTerminal = terminal;
						this.attachTuiStream(terminal);
						this.startWatchingSessionFile(sessionFile);
						return terminal;
					});
					this.tuiCreating = creating;
					let terminal: TmuxTerminal;
					try {
						terminal = await creating;
					} finally {
						if (this.tuiCreating === creating) this.tuiCreating = undefined;
					}
					const replay = await terminal.captureReplay();
					const { cols, rows } = terminal.size;
					return success(id, "tui_open", {
						termId: terminal.id,
						cols,
						rows,
						replay: Buffer.from(replay, "utf8").toString("base64"),
					});
				} catch (e) {
					return error(id, "tui_open", e instanceof Error ? e.message : String(e));
				}
			}

			case "tui_input": {
				if (!this.tuiTerminal?.isAlive) {
					return error(id, "tui_input", "No TUI is open");
				}
				await this.tuiTerminal.write(Buffer.from(command.data, "base64"));
				return success(id, "tui_input");
			}

			case "tui_resize": {
				if (!this.tuiTerminal?.isAlive) {
					return error(id, "tui_resize", "No TUI is open");
				}
				await this.tuiTerminal.resize(command.cols, command.rows);
				return success(id, "tui_resize");
			}

			case "tui_close": {
				const terminal = this.tuiTerminal;
				this.stopWatchingSessionFile();
				this.unsubscribeTui?.();
				this.unsubscribeTui = undefined;
				this.tuiTerminal = undefined;
				if (terminal) {
					await terminal.dispose();
				}
				await this.reloadSessionFromDisk();
				// Tell every other attached client (e.g. a second tab) that the TUI is gone
				// and the session was reloaded, mirroring the exit path in attachTuiStream.
				// The requesting client already knows from this response and handles it
				// locally (see toggleTui in the web client), so it is excluded to avoid a
				// duplicate toast/resync there.
				this.broadcast({ type: "tui_exit", reason: "closed" }, client);
				return success(id, "tui_close");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await this.runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "change_cwd": {
				try {
					const result = await this.runtimeHost.changeCwd(command.cwd);
					if (!result.cancelled) {
						await this.rebindSession();
					}
					return success(id, "change_cwd", result);
				} catch (e) {
					return error(id, "change_cwd", e instanceof Error ? e.message : String(e));
				}
			}

			case "fork": {
				const result = await this.runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await this.runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await this.rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				for (const builtin of RPC_BUILTIN_COMMANDS) {
					commands.push({ ...builtin, source: "builtin" });
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	}

	private async handleInputLine(client: RpcClientConnection, line: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			client.send(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await client.drain?.();
			return;
		}

		// Handle extension UI responses (first response wins, others are cancelled)
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = this.pendingExtensionRequests.get(response.id);
			if (pending) {
				this.pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
				this.broadcastCancel(response.id, client);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await this.handleCommand(command, client);
			if (response) {
				client.send(response);
				await client.drain?.();
			}
		} catch (commandError: unknown) {
			client.send(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await client.drain?.();
		}
	}
}
