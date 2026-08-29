import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUICancel,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "./protocol.ts";

export interface RpcClientCallbacks {
	onEvent(event: AgentSessionEvent): void;
	onUiRequest(request: RpcExtensionUIRequest): void;
	/** A dialog was answered by another client, timed out, or was aborted. */
	onUiCancel(id: string): void;
	/**
	 * `closeCode` is the WebSocket close code when this transition came from a close
	 * event (undefined on the initial/synthetic states). 4404 means the server-side
	 * instance is definitively gone (see packages/server/src/web.ts); any other code
	 * is a transient drop worth retrying.
	 */
	onConnectionChange(connected: boolean, closeCode?: number): void;
}

/** WS close code the server uses when the instance id does not resolve to a live instance. */
export const INSTANCE_UNREACHABLE_CLOSE_CODE = 4404;

const RESPONSE_TIMEOUT_MS = 60_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * WebSocket client for the pi RPC protocol. Commands are correlated to
 * responses via an `id` field; events stream unsolicited.
 */
export class RpcClient {
	private ws: WebSocket | undefined;
	private nextRequestId = 1;
	private generation = 0;
	private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
	private stopped = false;
	private readonly pending = new Map<
		string,
		{ resolve: (response: RpcResponse) => void; timer: ReturnType<typeof setTimeout> }
	>();

	private readonly url: string;
	private readonly callbacks: RpcClientCallbacks;

	constructor(url: string, callbacks: RpcClientCallbacks) {
		this.url = url;
		this.callbacks = callbacks;
	}

	start(): void {
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.ws?.close();
	}

	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	command(command: RpcCommand): Promise<RpcResponse> {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("Not connected"));
		}
		const id = `req-${this.nextRequestId++}`;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Command "${command.type}" timed out`));
			}, RESPONSE_TIMEOUT_MS);
			this.pending.set(id, { resolve, timer });
			ws.send(JSON.stringify({ ...command, id }));
		});
	}

	sendUiResponse(response: RpcExtensionUIResponse): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(response));
		}
	}

	private connect(): void {
		const generation = ++this.generation;
		const ws = new WebSocket(this.url);
		this.ws = ws;

		ws.onopen = () => {
			if (generation !== this.generation) {
				ws.close();
				return;
			}
			this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
			this.callbacks.onConnectionChange(true);
		};
		ws.onmessage = (event) => this.handleMessage(event);
		ws.onerror = () => ws.close();
		ws.onclose = (event) => {
			if (generation !== this.generation) return;
			this.callbacks.onConnectionChange(false, event.code);
			for (const [id, entry] of this.pending) {
				clearTimeout(entry.timer);
				this.pending.delete(id);
			}
			// The instance is definitively gone server-side; further reconnect attempts
			// would just be closed with the same code forever.
			if (event.code === INSTANCE_UNREACHABLE_CLOSE_CODE) {
				this.stopped = true;
				return;
			}
			if (!this.stopped) {
				setTimeout(() => this.connect(), this.reconnectDelayMs);
				this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
			}
		};
	}

	private handleMessage(event: MessageEvent): void {
		let message: { type?: string; id?: string };
		try {
			message = JSON.parse(String(event.data)) as { type?: string; id?: string };
		} catch {
			return;
		}
		if (message.type === "response") {
			const response = message as unknown as RpcResponse;
			if (response.id) {
				const entry = this.pending.get(response.id);
				if (entry) {
					this.pending.delete(response.id);
					clearTimeout(entry.timer);
					entry.resolve(response);
				}
			}
			return;
		}
		if (message.type === "extension_ui_request") {
			this.callbacks.onUiRequest(message as unknown as RpcExtensionUIRequest);
			return;
		}

		if (message.type === "extension_ui_cancel") {
			this.callbacks.onUiCancel((message as unknown as RpcExtensionUICancel).id);
			return;
		}
		this.callbacks.onEvent(message as unknown as AgentSessionEvent);
	}
}
