#!/usr/bin/env node
/**
 * Validate the inline <script> blocks of the server's generated web pages.
 *
 * packages/dashboard/src/web.ts builds those pages inside template literals, so an
 * unescaped sequence like "\n" is interpreted when the page is generated and ends
 * up as a real newline inside a JS string literal, breaking the whole script at
 * runtime while the TypeScript still type-checks. Serving the pages here and
 * parsing their scripts catches that before it ships.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const webModule = resolve(repoRoot, "packages/dashboard/dist/web.js");

// dist is gitignored, so a fresh checkout has nothing to render yet.
if (!existsSync(webModule)) {
	console.log("Skipping: packages/dashboard/dist is not built.");
	process.exit(0);
}

const { startServerWeb } = await import(pathToFileURL(webModule).href);

// An isolated data directory keeps this off any real server state.
process.env.PI_SERVER_DIR = mkdtempSync(join(tmpdir(), "pi-web-scripts-state-"));

const workDir = mkdtempSync(join(tmpdir(), "pi-web-scripts-"));
let failures = 0;
let handle;

try {
	handle = await startServerWeb({ host: "127.0.0.1", port: 0 });
	const origin = `http://127.0.0.1:${handle.port}`;
	const pages = [
		["index", "/"],
		["review", "/review"],
		["terminal", "/terminal"],
		["settings", "/settings"],
	];

	for (const [name, path] of pages) {
		const response = await fetch(`${origin}${path}`);
		if (!response.ok) {
			console.error(`${name}: GET ${path} returned ${response.status}`);
			failures++;
			continue;
		}
		const html = await response.text();
		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
		if (scripts.length === 0) {
			console.error(`${name}: no inline scripts found, the page may not have rendered`);
			failures++;
			continue;
		}
		scripts.forEach((script, index) => {
			const file = join(workDir, `${name}-${index}.js`);
			writeFileSync(file, script);
			try {
				execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
			} catch (error) {
				const detail = (error.stderr?.toString() ?? String(error)).trim().split("\n").slice(0, 4).join("\n");
				console.error(`${name}: inline script #${index + 1} is not valid JavaScript\n${detail}`);
				failures++;
			}
		});
	}
} finally {
	await handle?.close();
	rmSync(workDir, { recursive: true, force: true });
	rmSync(process.env.PI_SERVER_DIR, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} generated script block(s) failed to parse.`);
	process.exit(1);
}

console.log("Server web pages OK (index, review, terminal, settings).");
