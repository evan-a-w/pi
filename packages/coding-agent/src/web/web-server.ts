/**
 * Web server for pi web mode: serves the pi-web static assets over HTTP and the
 * pi RPC protocol (docs/rpc.md) over a WebSocket endpoint, backed by RpcBridge.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { getWebDistDir } from "../config.ts";
import { getAvailableThemesWithPaths } from "../modes/interactive/theme/theme.ts";
import type { RpcClientConnection, RpcClientHandle } from "../modes/rpc/rpc-bridge.ts";

/** Anything that can serve RPC protocol clients; RpcBridge for live sessions, SessionViewBridge for viewers. */
export interface WebBridge {
	attachClient(connection: RpcClientConnection): RpcClientHandle;
}

const WS_HIGH_WATER_BYTES = 16 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
};

export interface WebServerOptions {
	bridge: WebBridge;
	host: string;
	port: number;
	/** Static asset directory. Defaults to the @earendil-works/pi-web dist. */
	staticDir?: string;
}

export interface WebServerHandle {
	host: string;
	port: number;
	close(): Promise<void>;
}

function waitForSocketDrain(ws: WebSocket): Promise<void> {
	if (ws.readyState !== ws.OPEN || ws.bufferedAmount < WS_HIGH_WATER_BYTES) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const check = () => {
			if (ws.readyState !== ws.OPEN || ws.bufferedAmount < WS_HIGH_WATER_BYTES / 2) {
				resolve();
			} else {
				setTimeout(check, 25);
			}
		};
		check();
	});
}

function sendText(response: http.ServerResponse, statusCode: number, text: string): void {
	response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
	response.end(text);
}

function sendFile(response: http.ServerResponse, filePath: string, immutable: boolean): void {
	const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
	const cacheControl = immutable ? "public, max-age=31536000, immutable" : "no-cache";
	response.writeHead(200, { "content-type": contentType, "cache-control": cacheControl });
	fs.createReadStream(filePath).pipe(response);
}

/** Serve a theme JSON by theme name, resolved like the TUI (built-in + custom + registered). */
function resolveThemeFile(name: string): string | undefined {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return undefined;
	const theme = getAvailableThemesWithPaths().find((info) => info.name === name);
	if (!theme?.path) return undefined;
	return fs.existsSync(theme.path) && fs.statSync(theme.path).isFile() ? theme.path : undefined;
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const { bridge, host } = options;
	const staticDir = options.staticDir ?? getWebDistDir();
	const indexPath = path.join(staticDir, "index.html");
	if (!fs.existsSync(indexPath)) {
		throw new Error(
			`Web UI assets not found at ${staticDir}. Build them with: npm run build --workspace=@earendil-works/pi-web`,
		);
	}

	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");

		if (request.method !== "GET" && request.method !== "HEAD") {
			sendText(response, 405, "Method not allowed\n");
			return;
		}

		if (url.pathname === "/themes") {
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
			response.end(JSON.stringify({ themes: getAvailableThemesWithPaths().map((info) => info.name) }));
			return;
		}

		if (url.pathname.startsWith("/theme/")) {
			const requestedName = decodeURIComponent(url.pathname.slice("/theme/".length));
			// The client requests "<name>.json"; theme names themselves have no extension.
			const themeFile = resolveThemeFile(
				requestedName.endsWith(".json") ? requestedName.slice(0, -".json".length) : requestedName,
			);
			if (!themeFile) {
				sendText(response, 404, "Theme not found\n");
				return;
			}
			sendFile(response, themeFile, false);
			return;
		}

		// Static assets with SPA fallback
		const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
		const filePath = path.normalize(path.join(staticDir, relativePath));
		if (!filePath.startsWith(staticDir)) {
			sendText(response, 403, "Forbidden\n");
			return;
		}
		if (relativePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
			sendFile(response, filePath, relativePath.startsWith("assets/"));
			return;
		}
		sendFile(response, indexPath, false);
	});

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws") {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			const client = bridge.attachClient({
				send: (message) => {
					if (ws.readyState === ws.OPEN) {
						ws.send(JSON.stringify(message));
					}
				},
				drain: () => waitForSocketDrain(ws),
			});
			ws.on("message", (data) => {
				void client.receive(data.toString());
			});
			ws.on("close", () => client.detach());
			ws.on("error", () => client.detach());
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, host, () => resolve());
	});

	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;

	return {
		host,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const client of wss.clients) {
					client.terminate();
				}
				server.close(() => resolve());
			}),
	};
}
