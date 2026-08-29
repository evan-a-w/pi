import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import {
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type RpcCommand,
	type RpcExtensionUICancel,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcResponse,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { normalizeNamespace, resolveRequestNamespace, storedNamespaceValue } from "./namespaces.ts";
import { radiusPresence } from "./radius.ts";
import { createRpcProcessInstance, type RpcProcessInstance } from "./rpc-process.ts";
import { getInstance, loadInstances, removeInstance, saveInstances, upsertInstance } from "./storage.ts";
import type { InstanceRecord, InstanceStatus } from "./types.ts";

/** Abstraction over an RPC transport (child process or socket). */
export interface RpcChannel {
	send(command: RpcCommand): Promise<RpcResponse>;
	handleUiResponse(response: RpcExtensionUIResponse): void;
	setUiRequestHandler(handler?: (request: RpcExtensionUIRequest) => void): void;
	onEvent(listener: (event: AgentSessionEvent) => void): () => void;
	onExit(listener: (error?: Error) => void): () => void;
	dispose(): Promise<void>;
}

/** Wraps a net.Socket as an RpcChannel for externally-registered instances. */
class SocketRpcChannel implements RpcChannel {
	private readonly socket: Socket;
	private exited = false;
	private buffer = "";
	private nextRequestId = 0;
	private readonly pendingRequests = new Map<
		string,
		{ resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
	>();
	private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(error?: Error) => void>();
	private uiRequestHandler: ((request: RpcExtensionUIRequest) => void) | undefined;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer | string) => this.onData(chunk.toString()));
		socket.once("error", (error) => this.handleExit(error));
		socket.once("close", () => this.handleExit(new Error("Socket closed")));
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (!line) continue;
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let parsed: { type?: string; id?: string };
		try {
			parsed = JSON.parse(line) as { type?: string; id?: string };
		} catch {
			return;
		}
		switch (parsed.type) {
			case "response": {
				if (!parsed.id) return;
				const pending = this.pendingRequests.get(parsed.id);
				if (!pending) return;
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

	private handleExit(error?: Error): void {
		if (this.exited) return;
		this.exited = true;
		this.rejectAllPending(error ?? new Error("RPC channel closed"));
		for (const listener of this.exitListeners) {
			listener(error);
		}
	}

	send(command: RpcCommand): Promise<RpcResponse> {
		if (this.exited) throw new Error("RPC channel is closed");
		const id = command.id ?? `srv_${++this.nextRequestId}_${randomUUID()}`;
		const fullCommand = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			if (!this.socket.write(`${JSON.stringify(fullCommand)}\n`)) {
				this.pendingRequests.delete(id);
				reject(new Error("Socket write failed"));
			}
		});
	}

	handleUiResponse(response: RpcExtensionUIResponse): void {
		if (this.exited) return;
		this.socket.write(`${JSON.stringify(response)}\n`);
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
		this.rejectAllPending(new Error("RPC channel disposed"));
		if (!this.exited) {
			this.socket.destroy();
		}
	}
}

interface LiveInstanceResources {
	rpcProcess?: RpcProcessInstance;
	rpcChannel?: RpcChannel;
	radiusPiId?: string;
	sessionId?: string;
}

/** UI messages streamed to clients: dialog requests, plus cancels synthesized on first-response-wins. */
export type UiStreamMessage = RpcExtensionUIRequest | RpcExtensionUICancel;

interface LiveInstance {
	record: InstanceRecord;
	resources: LiveInstanceResources;
	subscribers: Set<AgentSessionEventListener>;
	uiSubscribers: Set<(message: UiStreamMessage) => void>;
	/** Dialog ids already answered by some stream client; later responses are dropped. */
	answeredDialogs: Set<string>;
	unsubscribeEvents?: () => void;
	unsubscribeExit?: () => void;
}

function cloneInstance(record: InstanceRecord): InstanceRecord {
	return { ...record };
}

// Only refresh persisted session metadata after commands that can plausibly change
// the instance identity/details we store in instances.json. Most RPCs mutate transient
// runtime state only, so forcing a follow-up get_state after every command is wasted IO.
//
// - new_session / switch_session / fork / clone can change sessionId/sessionFile
// - change_cwd moves the session to another working location, changing cwd and sessionFile
// - set_session_name changes a persisted session detail we may want reflected externally
// - prompt can materialize or advance persisted session state after the child processes it
// - tui_close reloads the session from disk (the TUI is a separate process with its own
//   in-memory copy and can change cwd via /cd, or model/sessionId via /new), so the
//   instance record can go stale the same way a switch_session/change_cwd would
const SESSION_METADATA_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set([
	"new_session",
	"switch_session",
	"change_cwd",
	"fork",
	"clone",
	"set_session_name",
	"prompt",
	"tui_close",
]);

function shouldRefreshSessionMetadata(command: RpcCommand): boolean {
	return SESSION_METADATA_COMMANDS.has(command.type);
}

function isGetStateSuccess(response: RpcResponse): response is Extract<
	RpcResponse,
	{
		success: true;
		command: "get_state";
		data: { sessionId: string; sessionFile?: string; cwd: string; sessionName?: string };
	}
> {
	return response.success === true && response.command === "get_state" && "data" in response;
}

export class ServerSupervisor {
	private readonly liveInstances = new Map<string, LiveInstance>();

	private setStatus(live: LiveInstance, status: InstanceStatus): void {
		live.record = {
			...live.record,
			status,
			lastSeenAt: new Date().toISOString(),
		};
		upsertInstance(live.record);
	}

	private updateRecord(live: LiveInstance, updates: Partial<InstanceRecord>): void {
		live.record = {
			...live.record,
			...updates,
			lastSeenAt: new Date().toISOString(),
		};
		if (updates.radiusPiId !== undefined) {
			live.resources.radiusPiId = updates.radiusPiId;
		}
		if (updates.sessionId !== undefined) {
			live.resources.sessionId = updates.sessionId;
		}
		upsertInstance(live.record);
	}

	private clearBindings(live: LiveInstance): void {
		live.unsubscribeEvents?.();
		live.unsubscribeExit?.();
		live.unsubscribeEvents = undefined;
		live.unsubscribeExit = undefined;
		live.uiSubscribers.clear();
		live.answeredDialogs.clear();
		live.resources.rpcProcess?.setUiRequestHandler(undefined);
		live.resources.rpcChannel?.setUiRequestHandler(undefined);
	}

	private bindRpcChannel(live: LiveInstance, channel: RpcChannel): void {
		this.clearBindings(live);
		if (channel instanceof SocketRpcChannel) {
			live.resources.rpcChannel = channel;
		} else {
			live.resources.rpcProcess = channel as RpcProcessInstance;
		}
		live.unsubscribeEvents = channel.onEvent((event) => {
			for (const subscriber of live.subscribers) {
				subscriber(event);
			}
			// session_reloaded is a bridge-level push (rpc-bridge.ts), not part of the
			// AgentSessionEvent union handleRpc's shouldRefreshSessionMetadata gates on,
			// fired while a TUI is attached and writes to the session file (e.g. /cd or
			// /new from inside the TUI). Refresh the instance record here too, or the
			// dashboard/review link stays stale until the TUI is closed.
			if ((event as { type?: string }).type === "session_reloaded") {
				void this.syncInstanceRecord(live);
			}
		});
		live.unsubscribeExit = channel.onExit((error) => {
			void this.handleUnexpectedRpcExit(live, error);
		});
		channel.setUiRequestHandler((request) => {
			live.answeredDialogs.delete(request.id);
			for (const subscriber of live.uiSubscribers) {
				subscriber(request);
			}
		});
	}

	private async handleUnexpectedRpcExit(live: LiveInstance, _error?: Error): Promise<void> {
		if (this.liveInstances.get(live.record.id) !== live) {
			return;
		}
		if (live.record.status === "stopping" || live.record.status === "stopped") {
			return;
		}
		this.setStatus(live, "error");
		this.clearBindings(live);
		live.resources.rpcProcess = undefined;
		if (live.resources.radiusPiId) {
			try {
				await radiusPresence.disconnectPi(live.record);
				this.updateRecord(live, { radiusPiId: undefined });
			} catch (error) {
				console.error(`Failed to disconnect Radius Pi ${live.record.id}: ${String(error)}`);
			}
		}
		this.liveInstances.delete(live.record.id);
		if (live.record.pinned) {
			this.scheduleRespawn(live.record);
		}
	}

	private getRpcChannel(live: LiveInstance): RpcChannel | undefined {
		return live.resources.rpcChannel ?? live.resources.rpcProcess;
	}

	private async syncInstanceRecord(live: LiveInstance): Promise<void> {
		const channel = this.getRpcChannel(live);
		if (!channel) {
			this.updateRecord(live, {});
			return;
		}
		const response = await channel.send({ type: "get_state" });
		if (!isGetStateSuccess(response)) {
			this.updateRecord(live, {});
			return;
		}
		// cwd follows the session: /cd moves the instance's working location, and the
		// dashboard review link is built from the record's cwd.
		//
		// sessionName is only applied when non-empty: get_state can transiently report
		// no name (e.g. auto-naming is still generating in the background, fire-and-
		// forget from agent-session.ts _maybeAutoNameSession, well after this command's
		// response already returned) even though a name was set moments earlier. There is
		// no supported way to clear a session's name from the dashboard today, so an
		// explicit clear does not need to flow through here; never regress the cached
		// name to a worse fallback (see resolveInstanceDisplayName in web.ts).
		this.updateRecord(live, {
			sessionId: response.data.sessionId,
			sessionFile: response.data.sessionFile,
			...(response.data.sessionName ? { sessionName: response.data.sessionName } : {}),
			...(response.data.cwd ? { cwd: response.data.cwd } : {}),
		});
	}

	private async cleanupAcquiredResources(live: LiveInstance): Promise<void> {
		const channel = live.resources.rpcChannel ?? live.resources.rpcProcess;
		this.clearBindings(live);
		if (live.resources.radiusPiId) {
			await radiusPresence.disconnectPi(live.record);
			live.resources.radiusPiId = undefined;
			live.record = {
				...live.record,
				radiusPiId: undefined,
				lastSeenAt: new Date().toISOString(),
			};
		}
		live.resources.sessionId = undefined;
		if (channel) {
			live.resources.rpcChannel = undefined;
			live.resources.rpcProcess = undefined;
			await channel.dispose();
		}
	}

	private async failSpawn(live: LiveInstance, error: unknown): Promise<never> {
		this.setStatus(live, "error");
		try {
			await this.cleanupAcquiredResources(live);
		} finally {
			this.setStatus(live, "stopped");
			this.liveInstances.delete(live.record.id);
		}
		throw error;
	}

	updateInstance(instance: InstanceRecord): void {
		const live = this.liveInstances.get(instance.id);
		if (live) {
			live.record = instance;
			live.resources.radiusPiId = instance.radiusPiId;
			live.resources.sessionId = instance.sessionId;
		}
		upsertInstance(instance);
	}

	openRpcStream(
		instanceId: string,
		onEvent: (event: AgentSessionEvent) => void,
		onUiMessage: (message: UiStreamMessage) => void,
	):
		| {
				handleRpc(command: RpcCommand): Promise<RpcResponse>;
				handleUiResponse(response: RpcExtensionUIResponse): void;
				close(): void;
		  }
		| undefined {
		const live = this.liveInstances.get(instanceId);
		const channel = live ? this.getRpcChannel(live) : undefined;
		if (!live || !channel) {
			return undefined;
		}
		live.subscribers.add(onEvent);
		live.uiSubscribers.add(onUiMessage);
		return {
			handleRpc: async (command) => {
				const response = await channel.send(command);
				if (shouldRefreshSessionMetadata(command)) {
					await this.syncInstanceRecord(live);
				}
				return response;
			},
			handleUiResponse: (response) => {
				if (live.answeredDialogs.has(response.id)) {
					return;
				}
				live.answeredDialogs.add(response.id);
				channel.handleUiResponse(response);
				const cancel: RpcExtensionUICancel = { type: "extension_ui_cancel", id: response.id };
				for (const subscriber of live.uiSubscribers) {
					if (subscriber !== onUiMessage) {
						subscriber(cancel);
					}
				}
			},
			close: () => {
				live.uiSubscribers.delete(onUiMessage);
				live.subscribers.delete(onEvent);
			},
		};
	}

	getLiveInstance(instanceId: string): InstanceRecord | undefined {
		const live = this.liveInstances.get(instanceId);
		return live ? cloneInstance(live.record) : undefined;
	}

	/**
	 * Bump lastSeenAt for activity that doesn't otherwise touch the record, e.g.
	 * opening a session's WS stream to view it. Used for the dashboard's
	 * last-accessed sort order.
	 */
	touchInstance(instanceId: string): void {
		const live = this.liveInstances.get(instanceId);
		if (live) {
			this.updateRecord(live, {});
			return;
		}
		const record = getInstance(instanceId);
		if (!record) {
			return;
		}
		upsertInstance({ ...record, lastSeenAt: new Date().toISOString() });
	}

	listLiveInstances(): InstanceRecord[] {
		return [...this.liveInstances.values()].map((live) => cloneInstance(live.record));
	}

	async recoverAfterRestart(): Promise<void> {
		const recoveredAt = new Date().toISOString();
		const instances = loadInstances().map((instance) => ({
			...instance,
			status: instance.status === "online" || instance.status === "starting" ? "stopped" : instance.status,
			lastSeenAt: recoveredAt,
		}));
		for (const instance of instances) {
			await radiusPresence.disconnectPi(instance);
		}
		saveInstances(instances);
	}

	listInstances(): InstanceRecord[] {
		return loadInstances().map(cloneInstance);
	}

	getInstance(instanceId: string): InstanceRecord | undefined {
		const live = this.liveInstances.get(instanceId);
		if (live) {
			return cloneInstance(live.record);
		}
		const stored = getInstance(instanceId);
		return stored ? cloneInstance(stored) : undefined;
	}

	async spawnInstance(options: {
		cwd: string;
		label?: string;
		sessionFile?: string;
		namespace?: string;
	}): Promise<InstanceRecord> {
		const now = new Date().toISOString();
		const namespace = storedNamespaceValue(normalizeNamespace(options.namespace));
		const live: LiveInstance = {
			record: {
				id: randomUUID(),
				status: "starting",
				cwd: options.cwd,
				createdAt: now,
				lastSeenAt: now,
				label: options.label,
				namespace,
			},
			resources: {},
			subscribers: new Set(),
			uiSubscribers: new Set(),
			answeredDialogs: new Set(),
		};
		this.liveInstances.set(live.record.id, live);
		upsertInstance(live.record);

		try {
			const rpcProcess = createRpcProcessInstance({
				cwd: options.cwd,
				sessionFile: options.sessionFile,
				namespace,
			});
			this.bindRpcChannel(live, rpcProcess);
			await this.syncInstanceRecord(live);
			const registeredRecord = await radiusPresence.registerPi(live.record);
			this.updateRecord(live, { radiusPiId: registeredRecord.radiusPiId });
			this.setStatus(live, "online");
			return cloneInstance(live.record);
		} catch (error) {
			return await this.failSpawn(live, error);
		}
	}

	/** Register an externally-owned session via an IPC socket. The socket becomes the RPC channel. */
	async registerInstance(
		socket: Socket,
		options: { cwd: string; label?: string; sessionId?: string; sessionFile?: string },
	): Promise<InstanceRecord> {
		const now = new Date().toISOString();
		const live: LiveInstance = {
			record: {
				id: randomUUID(),
				status: "starting",
				cwd: options.cwd,
				createdAt: now,
				lastSeenAt: now,
				label: options.label,
				sessionId: options.sessionId,
				sessionFile: options.sessionFile,
			},
			resources: {},
			subscribers: new Set(),
			uiSubscribers: new Set(),
			answeredDialogs: new Set(),
		};
		this.liveInstances.set(live.record.id, live);
		upsertInstance(live.record);

		try {
			const channel = new SocketRpcChannel(socket);
			this.bindRpcChannel(live, channel);
			const registeredRecord = await radiusPresence.registerPi(live.record);
			this.updateRecord(live, { radiusPiId: registeredRecord.radiusPiId });
			this.setStatus(live, "online");
			return cloneInstance(live.record);
		} catch (error) {
			return await this.failSpawn(live, error);
		}
	}

	async stopInstance(instanceId: string): Promise<InstanceRecord | undefined> {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			return undefined;
		}

		this.setStatus(live, "stopping");
		try {
			await this.cleanupAcquiredResources(live);
		} finally {
			live.record = {
				...live.record,
				status: "stopped",
				lastSeenAt: new Date().toISOString(),
			};
			this.liveInstances.delete(instanceId);
			// Pinned/archived instances keep their persisted record after stopping (pinned
			// so it can be found and respawned; archived so it stays listed under
			// "Archived"). A plain stop forgets the instance, matching prior behavior.
			if (live.record.pinned || live.record.archived) {
				upsertInstance(live.record);
			} else {
				removeInstance(instanceId);
			}
		}
		return cloneInstance(live.record);
	}

	/**
	 * Find or create a persisted (non-live) record for a session file that has no
	 * InstanceRecord yet (a "past" session in the dashboard's merged listing, found
	 * only by scanning session files on disk). Lets rename/pin/archive/delete
	 * address such sessions the same way as a tracked instance.
	 */
	ensureRecordForSessionFile(
		sessionFile: string,
		cwd: string,
		sessionName?: string,
		namespace?: string,
	): InstanceRecord {
		const existing = loadInstances().find((record) => record.sessionFile === sessionFile);
		if (existing) {
			return existing;
		}
		const now = new Date().toISOString();
		const created: InstanceRecord = {
			id: randomUUID(),
			status: "stopped",
			cwd,
			createdAt: now,
			lastSeenAt: now,
			sessionFile,
			sessionName,
			namespace: storedNamespaceValue(normalizeNamespace(namespace)),
		};
		upsertInstance(created);
		return created;
	}

	/**
	 * Rename a session's display name. Live instances go through the RPC
	 * `set_session_name` command (rejected while a TUI is attached, since that
	 * command races with the TUI's own writes to the session file). Stopped
	 * instances write directly to the session file via SessionManager, the same
	 * append-only session_info entry that set_session_name uses internally.
	 */
	async renameInstance(instanceId: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const trimmed = name.trim();
		if (!trimmed) {
			return { ok: false, error: "Name cannot be empty" };
		}

		const live = this.liveInstances.get(instanceId);
		if (live) {
			const channel = this.getRpcChannel(live);
			if (!channel) {
				return { ok: false, error: "Instance has no active RPC channel" };
			}
			const response = await channel.send({ type: "set_session_name", name: trimmed });
			if (!response.success) {
				return { ok: false, error: "error" in response ? response.error : "Failed to rename session" };
			}
			await this.syncInstanceRecord(live);
			return { ok: true };
		}

		const record = getInstance(instanceId);
		if (!record) {
			return { ok: false, error: "Unknown instance" };
		}
		if (!record.sessionFile) {
			return { ok: false, error: "Session has no file to rename" };
		}
		try {
			SessionManager.open(record.sessionFile).appendSessionInfo(trimmed);
			upsertInstance({ ...record, sessionName: trimmed, lastSeenAt: new Date().toISOString() });
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Pin or unpin a session. Pinned and archived are mutually exclusive. Pinning
	 * a currently-stopped session spawns it immediately ("pinned sessions are
	 * always up" holds right away, not just after the next restart or crash).
	 */
	async setPinned(instanceId: string, pinned: boolean): Promise<InstanceRecord | undefined> {
		if (pinned) {
			// Re-pinning resets the crash-loop guard so a manually restored session gets
			// a fresh set of respawn attempts.
			const target = this.liveInstances.get(instanceId)?.record ?? getInstance(instanceId);
			if (target?.sessionFile) {
				this.pinnedRespawnAttempts.delete(target.sessionFile);
			}
		}

		const live = this.liveInstances.get(instanceId);
		if (live) {
			this.updateRecord(live, { pinned, archived: pinned ? false : live.record.archived });
			return cloneInstance(live.record);
		}

		const record = getInstance(instanceId);
		if (!record) {
			return undefined;
		}
		const updated: InstanceRecord = {
			...record,
			pinned,
			archived: pinned ? false : record.archived,
			lastSeenAt: new Date().toISOString(),
		};
		upsertInstance(updated);

		if (pinned && updated.sessionFile) {
			try {
				const spawned = await this.spawnInstance({
					cwd: updated.cwd,
					label: updated.label,
					sessionFile: updated.sessionFile,
					namespace: updated.namespace,
				});
				const spawnedLive = this.liveInstances.get(spawned.id);
				if (spawnedLive) {
					this.updateRecord(spawnedLive, { pinned: true, archived: false });
				}
				removeInstance(updated.id);
				return this.liveInstances.get(spawned.id)?.record ?? spawned;
			} catch (error) {
				console.error(
					`Failed to spawn newly pinned session ${updated.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return updated;
	}

	/**
	 * Archive or unarchive a session. Archiving a live instance stops it first
	 * (keeping the record, unlike a plain stop). Pinned and archived are
	 * mutually exclusive.
	 */
	async setArchived(instanceId: string, archived: boolean): Promise<InstanceRecord | undefined> {
		const live = this.liveInstances.get(instanceId);
		if (live) {
			if (archived) {
				try {
					await this.cleanupAcquiredResources(live);
				} finally {
					this.liveInstances.delete(instanceId);
				}
				live.record = {
					...live.record,
					status: "stopped",
					archived: true,
					pinned: false,
					lastSeenAt: new Date().toISOString(),
				};
				upsertInstance(live.record);
				return cloneInstance(live.record);
			}
			this.updateRecord(live, { archived: false });
			return cloneInstance(live.record);
		}

		const record = getInstance(instanceId);
		if (!record) {
			return undefined;
		}
		const updated: InstanceRecord = {
			...record,
			archived,
			pinned: archived ? false : record.pinned,
			lastSeenAt: new Date().toISOString(),
		};
		upsertInstance(updated);
		return updated;
	}

	/**
	 * Move a session to another namespace: the session FILE stays exactly where
	 * it is, only which PI_CODING_AGENT_DIR (credentials/settings) a live child
	 * uses changes. A live instance is stopped and, if it has a sessionFile,
	 * respawned (resumed) under the new namespace's env - the same session file
	 * continuing under different provider credentials. A stopped instance just
	 * has its record updated; the next spawn/resume picks up the new namespace.
	 */
	async moveInstanceNamespace(
		instanceId: string,
		namespaceRaw: string | undefined,
	): Promise<{ ok: true; instance: InstanceRecord } | { ok: false; error: string }> {
		const resolved = resolveRequestNamespace(namespaceRaw);
		if (!resolved.ok) {
			return resolved;
		}
		const target = resolved.namespace;
		const namespace = storedNamespaceValue(target);

		const live = this.liveInstances.get(instanceId);
		const current = live ? live.record : getInstance(instanceId);
		if (!current) {
			return { ok: false, error: "Unknown instance" };
		}
		if (normalizeNamespace(current.namespace) === target) {
			return { ok: true, instance: cloneInstance(current) };
		}

		if (live) {
			const wasPinned = live.record.pinned;
			const { cwd, label, sessionFile } = live.record;
			await this.cleanupAcquiredResources(live);
			this.liveInstances.delete(instanceId);
			live.record = {
				...live.record,
				status: "stopped",
				namespace,
				lastSeenAt: new Date().toISOString(),
			};
			upsertInstance(live.record);
			if (!sessionFile) {
				return { ok: true, instance: cloneInstance(live.record) };
			}
			// spawnInstance below upserts its own new InstanceRecord as soon as it starts,
			// before the failure that can trigger failSpawn; if it throws, that record is
			// stray (the original record above, already updated to "stopped" + the new
			// namespace, is what should remain as the single record for this session
			// file). Diff instance ids before/after to find and remove it, rather than
			// relying on failSpawn (which only clears the in-memory live entry, not the
			// persisted record).
			const idsBeforeRespawn = new Set(loadInstances().map((instance) => instance.id));
			try {
				const spawned = await this.spawnInstance({ cwd, label, sessionFile, namespace });
				const spawnedLive = this.liveInstances.get(spawned.id);
				if (spawnedLive && wasPinned) {
					this.updateRecord(spawnedLive, { pinned: true, archived: false });
				}
				removeInstance(live.record.id);
				return { ok: true, instance: spawnedLive ? cloneInstance(spawnedLive.record) : spawned };
			} catch (error) {
				for (const instance of loadInstances()) {
					if (instance.id !== live.record.id && !idsBeforeRespawn.has(instance.id)) {
						removeInstance(instance.id);
					}
				}
				return {
					ok: false,
					error: `Namespace updated but restart failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		const updated: InstanceRecord = { ...current, namespace, lastSeenAt: new Date().toISOString() };
		upsertInstance(updated);
		return { ok: true, instance: updated };
	}

	/**
	 * Delete a session entirely: stop it if live, remove its persisted record,
	 * and delete its session .jsonl file from disk. Sessions are stored as flat
	 * files in a per-cwd directory shared by every session for that cwd (see
	 * SessionManager.getDefaultSessionDir), not per-session directories, so only
	 * the one file is removed; the shared directory is left alone.
	 */
	async deleteInstance(instanceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const record = this.getInstance(instanceId);
		if (!record) {
			return { ok: false, error: "Unknown instance" };
		}

		const live = this.liveInstances.get(instanceId);
		if (live) {
			try {
				await this.cleanupAcquiredResources(live);
			} finally {
				this.liveInstances.delete(instanceId);
			}
		}
		removeInstance(instanceId);
		if (record.sessionFile) {
			this.pinnedRespawnAttempts.delete(record.sessionFile);
		}

		if (record.sessionFile) {
			try {
				if (existsSync(record.sessionFile)) {
					rmSync(record.sessionFile);
				}
			} catch (error) {
				return {
					ok: false,
					error: `Removed instance but failed to delete session file: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		return { ok: true };
	}

	/**
	 * Auto-spawn every pinned session from its sessionFile. Called once after
	 * recoverAfterRestart() on server startup, so pinned sessions are always up.
	 */
	async spawnPinnedInstances(): Promise<void> {
		const pinnedRecords = loadInstances().filter((record) => record.pinned);
		for (const record of pinnedRecords) {
			if (!record.sessionFile) {
				console.error(`Skipping pinned session ${record.id}: no session file to resume from`);
				continue;
			}
			try {
				const spawned = await this.spawnInstance({
					cwd: record.cwd,
					label: record.label,
					sessionFile: record.sessionFile,
					namespace: record.namespace,
				});
				const live = this.liveInstances.get(spawned.id);
				if (live) {
					this.updateRecord(live, { pinned: true, archived: false });
				}
				if (record.id !== spawned.id) {
					removeInstance(record.id);
				}
			} catch (error) {
				console.error(
					`Failed to auto-spawn pinned session ${record.id} (${record.sessionFile}): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	// Bounds automatic respawn of a pinned instance after its process exits
	// unexpectedly, keyed by sessionFile (stable across respawns, unlike instance
	// id). Prevents crash loops: after PINNED_RESPAWN_MAX_ATTEMPTS, the session is
	// left in "error" status until a person intervenes (re-pin, resume, restart).
	private readonly pinnedRespawnAttempts = new Map<string, number>();
	private static readonly PINNED_RESPAWN_MAX_ATTEMPTS = 3;
	private static readonly PINNED_RESPAWN_BACKOFF_MS = 5000;

	private scheduleRespawn(record: InstanceRecord): void {
		const sessionFile = record.sessionFile;
		if (!sessionFile) {
			console.error(`Pinned session ${record.id} exited but has no session file to respawn from`);
			return;
		}
		const attempts = this.pinnedRespawnAttempts.get(sessionFile) ?? 0;
		if (attempts >= ServerSupervisor.PINNED_RESPAWN_MAX_ATTEMPTS) {
			console.error(`Pinned session ${sessionFile} exceeded respawn attempts (${attempts}); leaving stopped`);
			return;
		}
		this.pinnedRespawnAttempts.set(sessionFile, attempts + 1);
		setTimeout(() => {
			void this.respawnPinned(record);
		}, ServerSupervisor.PINNED_RESPAWN_BACKOFF_MS);
	}

	private async respawnPinned(record: InstanceRecord): Promise<void> {
		try {
			const spawned = await this.spawnInstance({
				cwd: record.cwd,
				label: record.label,
				sessionFile: record.sessionFile,
				namespace: record.namespace,
			});
			const live = this.liveInstances.get(spawned.id);
			if (live) {
				this.updateRecord(live, { pinned: true, archived: false });
			}
			if (record.id !== spawned.id) {
				removeInstance(record.id);
			}
			if (record.sessionFile) {
				this.pinnedRespawnAttempts.delete(record.sessionFile);
			}
		} catch (error) {
			console.error(
				`Auto-respawn failed for pinned session ${record.sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.scheduleRespawn(record);
		}
	}

	async handleRpc(instanceId: string, command: RpcCommand): Promise<RpcResponse | undefined> {
		const live = this.liveInstances.get(instanceId);
		const channel = live ? this.getRpcChannel(live) : undefined;
		if (!live || !channel) {
			return undefined;
		}

		const response = await channel.send(command);
		if (shouldRefreshSessionMetadata(command)) {
			await this.syncInstanceRecord(live);
		}
		return response;
	}

	async shutdown(): Promise<void> {
		for (const instanceId of [...this.liveInstances.keys()]) {
			await this.stopInstance(instanceId);
		}
	}
}

export const supervisor = new ServerSupervisor();

radiusPresence.setCoordinator({
	getLiveInstance(instanceId) {
		return supervisor.getLiveInstance(instanceId);
	},
	listLiveInstances() {
		return supervisor.listLiveInstances();
	},
	updateInstance(instance) {
		supervisor.updateInstance(instance);
	},
});
