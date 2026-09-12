import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { getSocketPath } from "./config.ts";
import { handleIpcRequest, handleRegisterInstance, openRpcStream } from "./handler.ts";
import { startIpcServer } from "./ipc/server.ts";
import { getRadiusServerBaseUrl, isRadiusEnabled, radiusPresence } from "./radius.ts";
import { supervisor } from "./supervisor.ts";
import { type ServerWebHandle, startServerWeb } from "./web.ts";

export interface ServeOptions {
	web?: {
		host?: string;
		port?: number;
	};
}

export async function serve(options: ServeOptions = {}): Promise<void> {
	const socketPath = getSocketPath();
	mkdirSync(dirname(socketPath), { recursive: true });

	let webPort: number | undefined;
	const server = await startIpcServer(
		Object.assign(handleIpcRequest, {
			openRpcStream,
			registerInstance: (
				socket: Parameters<typeof handleRegisterInstance>[0],
				request: Parameters<typeof handleRegisterInstance>[1],
			) => handleRegisterInstance(socket, request, webPort),
		}),
	);

	try {
		await supervisor.recoverAfterRestart();
		await supervisor.spawnPinnedInstances();
		// Idle reaper: unpinned sessions untouched for PI_SERVER_IDLE_MINUTES (default
		// 120; 0 disables) are stopped to free memory. See reapIdleInstances.
		const idleMinutes = Number(process.env.PI_SERVER_IDLE_MINUTES ?? "120");
		if (Number.isFinite(idleMinutes) && idleMinutes > 0) {
			const reaper = setInterval(() => {
				void supervisor.reapIdleInstances(idleMinutes * 60_000).catch((error: unknown) => {
					console.error(`idle reaper failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			}, 60_000);
			reaper.unref();
		}
		if (isRadiusEnabled()) {
			const machine = await radiusPresence.start();
			console.log(`radius integration enabled: ${socketPath} -> ${getRadiusServerBaseUrl()}`);
			if (machine) {
				console.log(`radius machine id: ${machine.id}`);
			}
		} else {
			console.log("radius integration disabled: login radius in ~/.pi/agent/auth.json or set RADIUS_API_KEY");
		}
	} catch (error) {
		server.close();
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
		throw error;
	}

	console.log(`server listening on ${socketPath}`);

	let webHandle: ServerWebHandle | undefined;
	if (options.web) {
		const host = options.web.host ?? "127.0.0.1";
		webHandle = await startServerWeb({ host, port: options.web.port ?? 0 });
		webPort = webHandle.port;
		const displayHost = host === "0.0.0.0" || host === "::" ? "<this-machine>" : host;
		console.log(`web UI: http://${displayHost}:${webHandle.port}/`);
	}

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = async (exitCode: number) => {
		if (shutdownPromise) {
			await shutdownPromise;
			process.exit(exitCode);
		}

		shutdownPromise = (async () => {
			server.close();
			await webHandle?.close();
			await supervisor.shutdown();
			await radiusPresence.stop();
			if (existsSync(socketPath)) {
				unlinkSync(socketPath);
			}
		})();

		await shutdownPromise;
		process.exit(exitCode);
	};

	process.on("SIGINT", () => {
		void shutdown(0);
	});
	process.on("SIGTERM", () => {
		void shutdown(0);
	});
	process.on("uncaughtException", (error) => {
		console.error(error);
		void shutdown(1);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(reason);
		void shutdown(1);
	});

	await new Promise<void>(() => {
		// Keep the process alive until a signal or fatal error triggers shutdown.
	});
}
