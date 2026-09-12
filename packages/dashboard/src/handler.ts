import type { Socket } from "node:net";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type {
	ErrorResponse,
	InstanceSummary,
	ListRequest,
	ListResponse,
	RegisterRequest,
	RegisterResponse,
	RpcBridgeResponse,
	RpcReadyResponse,
	RpcRequest,
	RpcStreamRequest,
	ServerRequest,
	ServerResponse,
	SpawnRequest,
	SpawnResponse,
	StatusRequest,
	StatusResponse,
	StopRequest,
	StopResponse,
} from "./ipc/protocol.ts";
import type { UiStreamMessage } from "./supervisor.ts";
import { supervisor } from "./supervisor.ts";
import type { InstanceRecord } from "./types.ts";

function toInstanceSummary(instance: InstanceRecord, webPort?: number): InstanceSummary {
	return {
		id: instance.id,
		status: instance.status,
		cwd: instance.cwd,
		label: instance.label,
		sessionId: instance.sessionId,
		sessionFile: instance.sessionFile,
		sessionName: instance.sessionName,
		radiusPiId: instance.radiusPiId,
		webPort,
		pinned: instance.pinned,
		archived: instance.archived,
	};
}

function unknownInstanceError(instanceId: string): ErrorResponse {
	return {
		type: "error",
		ok: false,
		error: `Unknown instance: ${instanceId}`,
	};
}

// Overload declarations
export async function handleIpcRequest(request: SpawnRequest): Promise<SpawnResponse | ErrorResponse>;
export async function handleIpcRequest(request: ListRequest): Promise<ListResponse | ErrorResponse>;
export async function handleIpcRequest(request: StopRequest): Promise<StopResponse | ErrorResponse>;
export async function handleIpcRequest(request: StatusRequest): Promise<StatusResponse | ErrorResponse>;
export async function handleIpcRequest(request: RpcRequest): Promise<RpcBridgeResponse | ErrorResponse>;
export async function handleIpcRequest(request: RpcStreamRequest): Promise<RpcReadyResponse | ErrorResponse>;
export async function handleIpcRequest(request: RegisterRequest): Promise<RegisterResponse | ErrorResponse>;
export async function handleIpcRequest(request: ServerRequest): Promise<ServerResponse>;
export async function handleIpcRequest(request: ServerRequest): Promise<ServerResponse> {
	switch (request.type) {
		case "spawn": {
			const instance = await supervisor.spawnInstance({
				cwd: request.cwd,
				label: request.label,
			});
			return {
				type: "spawn_result",
				ok: true,
				instance: toInstanceSummary(instance),
			};
		}

		case "list": {
			return {
				type: "list_result",
				ok: true,
				instances: supervisor.listInstances().map((i) => toInstanceSummary(i)),
			};
		}

		case "status": {
			const instance = supervisor.getInstance(request.instanceId);
			if (!instance) {
				return unknownInstanceError(request.instanceId);
			}

			return {
				type: "status_result",
				ok: true,
				instance: toInstanceSummary(instance),
			};
		}

		case "stop": {
			const instance = await supervisor.stopInstance(request.instanceId);
			if (!instance) {
				return unknownInstanceError(request.instanceId);
			}

			return {
				type: "stop_result",
				ok: true,
				instanceId: request.instanceId,
			};
		}

		case "rpc": {
			const response = await supervisor.handleRpc(request.instanceId, request.command);
			if (!response) {
				return unknownInstanceError(request.instanceId);
			}

			return {
				type: "rpc_result",
				ok: true,
				response,
			};
		}

		case "rpc_stream": {
			const instance = supervisor.getInstance(request.instanceId);
			if (!instance) {
				return unknownInstanceError(request.instanceId);
			}
			return {
				type: "rpc_ready",
				ok: true,
				instance: toInstanceSummary(instance),
			};
		}

		case "register": {
			// register is handled directly in the IPC server (needs the socket).
			// handleIpcRequest is not called for register requests.
			return { type: "error", ok: false, error: "register is handled at the transport layer" };
		}
	}
}

/**
 * Handle a register request over an IPC socket. The socket stays open after
 * the response and becomes the bidirectional RPC channel for the instance.
 */
export async function handleRegisterInstance(
	socket: Socket,
	request: RegisterRequest,
	webPort?: number,
): Promise<RegisterResponse | ErrorResponse> {
	try {
		const instance = await supervisor.registerInstance(socket, {
			cwd: request.cwd,
			label: request.label,
			sessionId: request.sessionId,
			sessionFile: request.sessionFile,
		});
		return {
			type: "register_result",
			ok: true,
			instance: toInstanceSummary(instance, webPort),
		};
	} catch (error: unknown) {
		return {
			type: "error",
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function openRpcStream(
	instanceId: string,
	onResponse: (response: RpcResponse) => void,
	onSessionEvent: (event: AgentSessionEvent) => void,
	onUiMessage: (message: UiStreamMessage) => void,
):
	| {
			handleRequest(request: RpcCommand | RpcExtensionUIResponse): Promise<void>;
			close(): void;
	  }
	| undefined {
	const handle = supervisor.openRpcStream(instanceId, onSessionEvent, onUiMessage);
	if (!handle) {
		return undefined;
	}

	return {
		async handleRequest(request): Promise<void> {
			if (request.type === "extension_ui_response") {
				handle.handleUiResponse(request);
				return;
			}
			const response = await handle.handleRpc(request);
			onResponse(response);
		},
		close(): void {
			handle.close();
		},
	};
}
