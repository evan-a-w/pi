import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { supervisor } from "../src/supervisor.ts";
import { startServerWeb } from "../src/web.ts";

/** Minimal fake net.Socket for ServerSupervisor.registerInstance in tests: no real IPC needed. */
class FakeSocket extends EventEmitter {
	write(_data: string): boolean {
		return true;
	}
	destroy(): void {
		this.emit("close");
	}
}

let serverDir: string;
let previousServerDir: string | undefined;
let projectDir: string;

beforeEach(() => {
	previousServerDir = process.env.PI_SERVER_DIR;
	serverDir = mkdtempSync(join(tmpdir(), "pi-server-files-test-"));
	process.env.PI_SERVER_DIR = serverDir;

	projectDir = mkdtempSync(join(tmpdir(), "pi-server-files-project-"));
});

afterEach(() => {
	if (previousServerDir === undefined) {
		delete process.env.PI_SERVER_DIR;
	} else {
		process.env.PI_SERVER_DIR = previousServerDir;
	}
	rmSync(serverDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

async function getJson(baseUrl: string, path: string): Promise<Record<string, unknown>> {
	const res = await fetch(`${baseUrl}${path}`);
	return (await res.json()) as Record<string, unknown>;
}

describe("GET /i/<id>/files and /i/<id>/files/content (read-only explorer)", () => {
	let handle: Awaited<ReturnType<typeof startServerWeb>>;
	let baseUrl: string;
	let instanceId: string;

	beforeEach(async () => {
		handle = await startServerWeb({ host: "127.0.0.1", port: 0 });
		baseUrl = `http://127.0.0.1:${handle.port}`;
		const instance = await supervisor.registerInstance(new FakeSocket() as unknown as Socket, { cwd: projectDir });
		instanceId = instance.id;
	});

	afterEach(async () => {
		await handle.close();
	});

	it("lists directory entries scoped to the instance's cwd, skipping node_modules and .git", async () => {
		writeFileSync(join(projectDir, "README.md"), "# hello\n");
		mkdirSync(join(projectDir, "src"));
		writeFileSync(join(projectDir, "src", "index.ts"), "export {};\n");
		mkdirSync(join(projectDir, "node_modules"));
		mkdirSync(join(projectDir, ".git"));

		const data = await getJson(baseUrl, `/i/${instanceId}/files?path=`);
		expect(data.ok).toBe(true);
		const entries = data.entries as Array<{ name: string; type: string; size?: number }>;
		const names = entries.map((entry) => entry.name);
		expect(names).toContain("README.md");
		expect(names).toContain("src");
		expect(names).not.toContain("node_modules");
		expect(names).not.toContain(".git");
		// Directories are listed before files.
		expect(entries.findIndex((entry) => entry.name === "src")).toBeLessThan(
			entries.findIndex((entry) => entry.name === "README.md"),
		);

		const subdirData = await getJson(baseUrl, `/i/${instanceId}/files?path=src`);
		expect(subdirData.ok).toBe(true);
		expect((subdirData.entries as Array<{ name: string }>).map((entry) => entry.name)).toEqual(["index.ts"]);
	});

	it("rejects a listing path that escapes the instance's cwd", async () => {
		const data = await getJson(baseUrl, `/i/${instanceId}/files?path=${encodeURIComponent("../../etc")}`);
		expect(data.ok).toBe(false);
		expect(data.error).toBe("Path escapes the working directory");
	});

	it("returns file content for a small text file", async () => {
		writeFileSync(join(projectDir, "notes.md"), "hello from the explorer\n");
		const data = await getJson(baseUrl, `/i/${instanceId}/files/content?path=notes.md`);
		expect(data.ok).toBe(true);
		expect(data.content).toBe("hello from the explorer\n");
	});

	it("rejects a content path that escapes the instance's cwd", async () => {
		const data = await getJson(
			baseUrl,
			`/i/${instanceId}/files/content?path=${encodeURIComponent("../../../etc/passwd")}`,
		);
		expect(data.ok).toBe(false);
		expect(data.error).toBe("Path escapes the working directory");
	});

	it("rejects a file over the 512KB size cap", async () => {
		writeFileSync(join(projectDir, "big.txt"), "x".repeat(512 * 1024 + 1));
		const data = await getJson(baseUrl, `/i/${instanceId}/files/content?path=big.txt`);
		expect(data.ok).toBe(false);
		expect(data.error).toMatch(/too large/i);
	});
});
