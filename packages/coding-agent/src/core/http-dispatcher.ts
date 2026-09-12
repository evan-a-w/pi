import { EventEmitter } from "node:events";
import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

// undici's ProxyAgent accepts socks5:/socks: URIs and tunnels through them. It rejects
// socks5h:, so we normalize it away. The distinction does not change behaviour here:
// undici always sends the target hostname to the proxy and lets it resolve, which is
// socks5h semantics (no local DNS lookup, so DNS does not leak around the tunnel).
const SOCKS_PROTOCOLS = new Set(["socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:", ...SOCKS_PROTOCOLS]);

/**
 * Validates a proxy URL and normalizes SOCKS5 variants to the scheme undici accepts.
 * Returns undefined for empty input. Throws on unusable values so misconfiguration
 * surfaces at startup instead of as a confusing per-request connection failure.
 */
export function normalizeProxyUrl(proxyUrl: string | undefined): string | undefined {
	const proxy = proxyUrl?.trim();
	if (!proxy) return undefined;

	let url: URL;
	try {
		url = new URL(proxy);
	} catch {
		throw new Error(`Invalid proxy URL: ${proxy}. Expected a URL such as http://host:port or socks5://host:1080.`);
	}

	if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol)) {
		throw new Error(
			`Unsupported proxy protocol "${url.protocol}" in ${proxy}. Supported: http, https, socks5, socks5h.`,
		);
	}

	// SOCKS4 predates hostname addressing and username/password auth, and undici does not
	// implement it. Reject explicitly rather than letting it fail at connect time.
	if (url.protocol === "socks4:" || url.protocol === "socks4a:") {
		throw new Error(`SOCKS4 proxies are not supported (${proxy}). Use a SOCKS5 proxy (socks5:// or socks5h://).`);
	}

	// Only SOCKS URLs need rewriting. Returning http(s) inputs untouched avoids gratuitous
	// churn from URL round-tripping (which would append a root path).
	if (!SOCKS_PROTOCOLS.has(url.protocol)) {
		return proxy;
	}

	if (url.protocol === "socks5h:") {
		url.protocol = "socks5:";
	}
	if (!url.port) {
		url.port = "1080";
	}
	return url.toString();
}

export function isSocksProxyUrl(proxyUrl: string | undefined): boolean {
	const proxy = proxyUrl?.trim();
	if (!proxy) return false;
	try {
		return SOCKS_PROTOCOLS.has(new URL(proxy).protocol);
	} catch {
		return false;
	}
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = normalizeProxyUrl(httpProxy);
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

let socks5WarningSuppressed = false;

// undici emits an ExperimentalWarning on first SOCKS5 use. It is written straight to
// stderr, which corrupts the TUI. The CLI entry points already stub process.emitWarning
// wholesale, but the SDK is also embedded by other hosts, so filter it here and leave
// every other warning intact.
function suppressSocks5ExperimentalWarning(): void {
	if (socks5WarningSuppressed) return;
	socks5WarningSuppressed = true;
	const original = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
		const message = typeof warning === "string" ? warning : warning?.message;
		if (message?.includes("SOCKS5 proxy support is experimental")) {
			return;
		}
		(original as (warning: string | Error, ...args: unknown[]) => void)(warning, ...rest);
	}) as typeof process.emitWarning;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

/**
 * Re-applies idle timeouts as per-request dispatch options.
 *
 * undici's Socks5ProxyAgent builds its own internal Pool per origin and forwards only
 * `pipelining` and `connections`, so the agent-level bodyTimeout/headersTimeout are
 * dropped and a stalled SOCKS5 connection would hang forever. The Pool does honour
 * these when they arrive on the dispatch options, so we stamp them there. Callers that
 * set their own timeouts (e.g. a provider SDK) still win via the spread order.
 */
class TimeoutOptionsDispatcher extends undici.Dispatcher {
	#inner: undici.Dispatcher;
	#timeoutMs: number;

	constructor(inner: undici.Dispatcher, timeoutMs: number) {
		super();
		this.#inner = inner;
		this.#timeoutMs = timeoutMs;
	}

	dispatch(options: undici.Dispatcher.DispatchOptions, handler: undici.Dispatcher.DispatchHandler): boolean {
		return this.#inner.dispatch(
			{ bodyTimeout: this.#timeoutMs, headersTimeout: this.#timeoutMs, ...options },
			handler,
		);
	}

	// Mirror undici's overloads so both the promise and callback forms keep working.
	close(): Promise<void>;
	close(callback: () => void): void;
	close(callback?: () => void): Promise<void> | void {
		return callback ? this.#inner.close(callback) : this.#inner.close();
	}

	destroy(): Promise<void>;
	destroy(err: Error | null): Promise<void>;
	destroy(callback: () => void): void;
	destroy(err: Error | null, callback: () => void): void;
	destroy(errOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
		if (typeof errOrCallback === "function") {
			return this.#inner.destroy(errOrCallback);
		}
		if (callback) {
			return this.#inner.destroy(errOrCallback ?? null, callback);
		}
		return this.#inner.destroy(errOrCallback ?? null);
	}
}

// HTTP_PROXY/HTTPS_PROXY may hold socks5h:// from the user's shell rather than from
// settings, so normalize in place before EnvHttpProxyAgent reads them.
const PROXY_ENV_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;

function normalizeProxyEnvVars(): void {
	for (const name of PROXY_ENV_VARS) {
		const value = process.env[name];
		if (!value?.trim()) continue;
		// A bad value in the environment should not prevent startup, so drop it and fall
		// back to a direct connection. Leaving it in place is not an option: undici parses
		// these vars itself and throws out of the EnvHttpProxyAgent constructor.
		let normalized: string | undefined;
		try {
			normalized = normalizeProxyUrl(value);
		} catch {
			normalized = undefined;
		}
		if (normalized === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = normalized;
		}
	}
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	normalizeProxyEnvVars();
	const usesSocksProxy = PROXY_ENV_VARS.some((name) => isSocksProxyUrl(process.env[name]));
	if (usesSocksProxy) {
		suppressSocks5ExperimentalWarning();
	}
	const proxyAgent = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
			proxyTunnel: true,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	// Only wrap on the SOCKS5 path: the plain HTTP path already honours agent-level
	// timeouts, and the wrapper would hide EnvHttpProxyAgent's own dispatcher type.
	const dispatcher =
		usesSocksProxy && normalizedTimeoutMs > 0
			? new TimeoutOptionsDispatcher(proxyAgent, normalizedTimeoutMs)
			: proxyAgent;
	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
