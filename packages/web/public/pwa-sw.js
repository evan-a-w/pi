// Bump on any change to caching behavior so old caches are dropped on activate.
const CACHE_VERSION = "pi-web-v2";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

function scopeUrl(path) {
	return new URL(path, self.registration.scope).href;
}

async function cacheCoreAssets() {
	const cache = await caches.open(STATIC_CACHE);
	await cache.addAll([
		scopeUrl("."),
		scopeUrl("manifest.webmanifest"),
		scopeUrl("icons/pi.svg"),
		scopeUrl("icons/pi-180.png"),
		scopeUrl("icons/pi-192.png"),
		scopeUrl("icons/pi-512.png"),
	]);
}

self.addEventListener("install", (event) => {
	event.waitUntil(cacheCoreAssets().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names
						.filter((name) => name.startsWith("pi-web-") && name !== STATIC_CACHE && name !== RUNTIME_CACHE)
						.map((name) => caches.delete(name)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

/**
 * Only the app shell (navigations) and hashed static assets are handled.
 * Everything else - REST under /api/, instance-scoped JSON endpoints like
 * /i/<id>/files, /subagents, /ws - goes straight to the network: serving the
 * cached HTML shell for a failed JSON request is what produced
 * `Unexpected token '<', "<!doctype"...` errors in the file explorer.
 */
function shouldHandle(request) {
	if (request.method !== "GET") return false;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return false;
	if (request.mode === "navigate") return true;
	return isStaticAsset(url);
}

async function networkFirst(request, { shellFallback }) {
	const cache = await caches.open(RUNTIME_CACHE);
	try {
		const response = await fetch(request);
		if (response.ok) {
			await cache.put(request, response.clone());
		}
		return response;
	} catch (error) {
		const cached = await cache.match(request);
		if (cached) return cached;
		if (shellFallback) {
			const shell = await caches.match(scopeUrl("."));
			if (shell) return shell;
		}
		throw error;
	}
}

function isStaticAsset(url) {
	return (
		url.pathname.includes("/assets/") ||
		url.pathname.includes("/icons/") ||
		url.pathname.endsWith("/manifest.webmanifest") ||
		url.pathname.endsWith(".js") ||
		url.pathname.endsWith(".css") ||
		url.pathname.endsWith(".png") ||
		url.pathname.endsWith(".svg")
	);
}

self.addEventListener("fetch", (event) => {
	if (!shouldHandle(event.request)) return;
	// Network-first for assets too: Vite emits content-hashed filenames, but
	// index.html itself was cache-first-adjacent via the shell entry, and a
	// cache-first policy meant a deploy could leave clients on a stale bundle
	// until the cache was cleared by hand. Network-first keeps offline
	// fallback while always preferring the freshly deployed files.
	event.respondWith(networkFirst(event.request, { shellFallback: event.request.mode === "navigate" }));
});
