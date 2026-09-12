/**
 * Server registration: connects to the local pi server IPC socket, registers
 * the current session as an instance, and returns a bidirectional RPC channel
 * that proxies between the server's WS clients and the local RpcBridge.
 *
 * If the server is not running, auto-starts it (in Bun binary mode or dev mode).
 */

import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, isBunBinary } from "../config.ts";

function getServerSocketPath(): string {
	const piDir = process.env.PI_CONFIG_DIR || join(homedir(), CONFIG_DIR_NAME);
	const serverDir = process.env.PI_SERVER_DIR || join(piDir, "server");
	return join(serverDir, "server.sock");
}

function spawnServer(webHost?: string, webPort?: number): ReturnType<typeof spawn> {
	const cliArgs = ["serve", "--web"];
	if (webPort !== undefined) {
		cliArgs.push("--web-port", String(webPort));
	}
	if (webHost !== undefined) {
		cliArgs.push("--web-host", webHost);
	}

	if (isBunBinary) {
		// Bun binary: the main pi binary delegates subcommands
		return spawn(
			join(dirname(process.execPath), process.platform === "win32" ? "pi.exe" : "pi"),
			["pi-server", ...cliArgs],
			{ stdio: "ignore" },
		);
	}

	// Dev mode: run the server CLI directly via tsx.
	// server-registration.ts is at packages/coding-agent/src/web/, so go up 4 levels to repo root.
	const srcDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot = dirname(dirname(dirname(dirname(srcDir))));
	const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
	const serverCli = join(repoRoot, "packages", "dashboard", "src", "cli.ts");
	return spawn(process.execPath, [tsxBin, serverCli, ...cliArgs], {
		stdio: "ignore",
	});
}

export interface RegistrationResult {
	instanceId: string;
	webPort?: number;
	socket: Socket;
}

interface RegisterResponse {
	ok: boolean;
	error?: string;
	instance?: {
		id: string;
		webPort?: number;
	};
}

/**
 * Low-level connect + register. Rejects with the underlying error on connect
 * failures (ENOENT, ECONNREFUSED) or with an Error on registration rejection.
 */
function connectAndRegister(options: {
	cwd: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
}): Promise<RegistrationResult> {
	return new Promise((resolve, reject) => {
		const socketPath = getServerSocketPath();
		const socket = createConnection(socketPath);
		let buffer = "";
		let settled = false;

		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			if (error) {
				socket.destroy();
				// Re-wrap connect errors with the socket path for caller detection
				if ("code" in (error as NodeJS.ErrnoException)) {
					reject(
						Object.assign(new Error(`connect ${(error as NodeJS.ErrnoException).code} ${socketPath}`), {
							code: (error as NodeJS.ErrnoException).code,
						}),
					);
				} else {
					reject(error);
				}
			}
		};

		socket.on("connect", () => {
			socket.write(
				`${JSON.stringify({
					type: "register",
					cwd: options.cwd,
					label: options.label,
					sessionId: options.sessionId,
					sessionFile: options.sessionFile,
				})}\n`,
			);
		});

		socket.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;

			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) return;
			if (settled) return;
			settled = true;
			socket.removeAllListeners();

			let response: RegisterResponse;
			try {
				response = JSON.parse(line) as RegisterResponse;
			} catch (error) {
				socket.destroy();
				reject(new Error(`Invalid register response: ${String(error)}`));
				return;
			}

			if (!response.ok || !response.instance) {
				socket.destroy();
				reject(new Error(response.error || "Registration failed"));
				return;
			}

			// Success: socket stays open as the RPC channel
			resolve({
				instanceId: response.instance.id,
				webPort: response.instance.webPort,
				socket,
			});
		});

		socket.on("error", (error) => settle(error));
	});
}

function isConnectError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ECONNREFUSED";
}

/**
 * Register the current session with the local pi server. If the server is not
 * running, auto-starts it first. Returns the instance ID, web port, and the
 * socket that serves as the bidirectional RPC channel.
 */
export async function registerWithServer(options: {
	cwd: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	/** Optional server config for auto-start. */
	webHost?: string;
	webPort?: number;
}): Promise<RegistrationResult> {
	try {
		return await connectAndRegister(options);
	} catch (error) {
		if (!isConnectError(error)) throw error;
	}

	// Auto-start the server and poll until ready (up to 15 seconds)
	spawnServer(options.webHost, options.webPort);

	const maxRetries = 50;
	for (let i = 0; i < maxRetries; i++) {
		await new Promise((resolve) => setTimeout(resolve, 300));
		try {
			return await connectAndRegister(options);
		} catch (error) {
			if (!isConnectError(error)) throw error;
		}
	}

	throw new Error(
		`pi server is not running and could not be auto-started. ` + `Start it manually with: pi-server serve --web`,
	);
}
