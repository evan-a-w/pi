import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNamespaceAgentDir, getNamespacesRegistryPath, isValidNamespaceName } from "../src/config.ts";
import {
	createNamespace,
	DEFAULT_NAMESPACE,
	deleteNamespace,
	isDefaultNamespace,
	listNamespaces,
	namespaceAgentDirOverride,
	namespaceExists,
	normalizeNamespace,
	resolveRequestNamespace,
	storedNamespaceValue,
} from "../src/namespaces.ts";
import { loadInstances, loadNamespaces, saveNamespaces, upsertInstance } from "../src/storage.ts";
import { supervisor } from "../src/supervisor.ts";
import type { InstanceRecord } from "../src/types.ts";
import { startServerWeb } from "../src/web.ts";

let serverDir: string;
let previousServerDir: string | undefined;
let configDir: string;
let previousConfigDir: string | undefined;
let previousRadiusApiKey: string | undefined;

beforeEach(() => {
	previousServerDir = process.env.PI_SERVER_DIR;
	serverDir = mkdtempSync(join(tmpdir(), "pi-server-namespaces-test-"));
	process.env.PI_SERVER_DIR = serverDir;

	// getNamespaceAgentDir/namespaceAgentDirOverride resolve off PI_CONFIG_DIR (not
	// PI_SERVER_DIR), so tests that touch a namespace's agent/session dir on disk
	// need this isolated too, or they'd read/write the real ~/.pi.
	previousConfigDir = process.env.PI_CONFIG_DIR;
	configDir = mkdtempSync(join(tmpdir(), "pi-server-namespaces-config-test-"));
	process.env.PI_CONFIG_DIR = configDir;

	// spawnInstance/registerInstance (used by the moveInstanceNamespace tests below)
	// go through radiusPresence.registerPi, which is a no-op unless a radius
	// credential or API key is present; make sure a real dev credential never turns
	// this into a live network call.
	previousRadiusApiKey = process.env.RADIUS_API_KEY;
	delete process.env.RADIUS_API_KEY;
});

afterEach(() => {
	if (previousServerDir === undefined) {
		delete process.env.PI_SERVER_DIR;
	} else {
		process.env.PI_SERVER_DIR = previousServerDir;
	}
	rmSync(serverDir, { recursive: true, force: true });

	if (previousConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = previousConfigDir;
	}
	rmSync(configDir, { recursive: true, force: true });

	if (previousRadiusApiKey === undefined) {
		delete process.env.RADIUS_API_KEY;
	} else {
		process.env.RADIUS_API_KEY = previousRadiusApiKey;
	}
});

/** Minimal fake net.Socket for ServerSupervisor.registerInstance in tests: no real IPC needed. */
class FakeSocket extends EventEmitter {
	write(_data: string): boolean {
		return true;
	}
	destroy(): void {
		this.emit("close");
	}
}

describe("isValidNamespaceName", () => {
	it("accepts lowercase letters, digits, - and _", () => {
		expect(isValidNamespaceName("work")).toBe(true);
		expect(isValidNamespaceName("work-2_b")).toBe(true);
		expect(isValidNamespaceName("a")).toBe(true);
		expect(isValidNamespaceName("a".repeat(32))).toBe(true);
	});

	it("rejects empty, too-long, uppercase, spaces, and other punctuation", () => {
		expect(isValidNamespaceName("")).toBe(false);
		expect(isValidNamespaceName("a".repeat(33))).toBe(false);
		expect(isValidNamespaceName("Work")).toBe(false);
		expect(isValidNamespaceName("my namespace")).toBe(false);
		expect(isValidNamespaceName("my.namespace")).toBe(false);
		expect(isValidNamespaceName("my/namespace")).toBe(false);
	});
});

describe("normalizeNamespace / isDefaultNamespace / storedNamespaceValue", () => {
	it('treats undefined, empty, whitespace, and "default" as the implicit default', () => {
		for (const value of [undefined, "", "   ", DEFAULT_NAMESPACE]) {
			expect(normalizeNamespace(value)).toBe(DEFAULT_NAMESPACE);
			expect(isDefaultNamespace(value)).toBe(true);
		}
	});

	it("preserves a named namespace", () => {
		expect(normalizeNamespace("work")).toBe("work");
		expect(isDefaultNamespace("work")).toBe(false);
	});

	it("stores the default namespace as undefined on records, named namespaces as-is", () => {
		expect(storedNamespaceValue(DEFAULT_NAMESPACE)).toBeUndefined();
		expect(storedNamespaceValue("work")).toBe("work");
	});
});

describe("namespaceAgentDirOverride", () => {
	it("has no override for the implicit default namespace", () => {
		expect(namespaceAgentDirOverride(undefined)).toBeUndefined();
		expect(namespaceAgentDirOverride(DEFAULT_NAMESPACE)).toBeUndefined();
	});

	it("resolves a named namespace to its own agent dir", () => {
		expect(namespaceAgentDirOverride("work")).toBe(getNamespaceAgentDir("work"));
	});
});

describe("createNamespace / listNamespaces / namespaceExists", () => {
	it("always lists the implicit default namespace first, even with an empty registry", () => {
		const namespaces = listNamespaces();
		expect(namespaces).toEqual([{ name: DEFAULT_NAMESPACE, createdAt: "" }]);
	});

	it("creates a namespace and persists it to the registry file", () => {
		const result = createNamespace("work");
		expect(result.ok).toBe(true);
		expect(namespaceExists("work")).toBe(true);
		expect(listNamespaces().map((n) => n.name)).toEqual([DEFAULT_NAMESPACE, "work"]);

		// Round-trips through storage.ts at the expected path.
		const persisted = loadNamespaces();
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.name).toBe("work");
		expect(getNamespacesRegistryPath()).toBe(join(serverDir, "namespaces.json"));
	});

	it("rejects an invalid name", () => {
		const result = createNamespace("Not Valid!");
		expect(result.ok).toBe(false);
	});

	it('rejects "default" and duplicate names', () => {
		expect(createNamespace(DEFAULT_NAMESPACE).ok).toBe(false);
		expect(createNamespace("work").ok).toBe(true);
		expect(createNamespace("work").ok).toBe(false);
	});
});

describe("deleteNamespace", () => {
	it("refuses to delete the implicit default namespace", () => {
		const result = deleteNamespace(DEFAULT_NAMESPACE);
		expect(result).toEqual({ ok: false, error: "The default namespace cannot be deleted" });
	});

	it("refuses to delete an unknown namespace", () => {
		const result = deleteNamespace("ghost");
		expect(result.ok).toBe(false);
	});

	it("refuses to delete a namespace that still has sessions, and never touches its agent dir", () => {
		createNamespace("work");
		upsertInstance({
			id: "instance-1",
			status: "stopped",
			cwd: "/tmp/project",
			createdAt: new Date().toISOString(),
			namespace: "work",
		});

		const result = deleteNamespace("work");
		expect(result).toEqual({ ok: false, error: 'Namespace "work" still has sessions; move or delete them first' });
		expect(namespaceExists("work")).toBe(true);
	});

	it("deletes an empty namespace from the registry only (agent dir is never touched)", () => {
		createNamespace("work");
		const result = deleteNamespace("work");
		expect(result).toEqual({ ok: true });
		expect(namespaceExists("work")).toBe(false);
		expect(listNamespaces().map((n) => n.name)).toEqual([DEFAULT_NAMESPACE]);
	});

	// Finding #2: a plain stop removes the InstanceRecord entirely (see
	// ServerSupervisor.stopInstance), so session FILES can outlive every record
	// referencing them. The in-use (InstanceRecord) check above must not be the
	// only guard, or deleting the namespace would silently hide those sessions
	// from the past-session scan.
	it("refuses to delete a namespace with session files on disk even when no InstanceRecord references it", () => {
		createNamespace("work");
		const sessionDir = join(getNamespaceAgentDir("work"), "sessions", "--tmp-project--");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "2024-01-01T00-00-00-000Z_abc.jsonl"), '{"type":"session_info"}\n');

		const result = deleteNamespace("work");
		expect(result).toEqual({
			ok: false,
			error: 'Namespace "work" still has session files on disk; move or delete them first',
		});
		expect(namespaceExists("work")).toBe(true);
	});

	it("deletes a namespace whose sessions directory exists but is empty", () => {
		createNamespace("work");
		mkdirSync(join(getNamespaceAgentDir("work"), "sessions"), { recursive: true });

		const result = deleteNamespace("work");
		expect(result).toEqual({ ok: true });
		expect(namespaceExists("work")).toBe(false);
	});
});

describe("resolveRequestNamespace", () => {
	it('resolves undefined/empty/"default" to the default namespace', () => {
		for (const value of [undefined, "", "   ", DEFAULT_NAMESPACE]) {
			expect(resolveRequestNamespace(value)).toEqual({ ok: true, namespace: DEFAULT_NAMESPACE });
		}
	});

	it("resolves an existing named namespace", () => {
		createNamespace("work");
		expect(resolveRequestNamespace("work")).toEqual({ ok: true, namespace: "work" });
	});

	// Finding #1 (web.ts): every REST entry point that accepts a client-supplied
	// namespace must reject unknown/never-registered names through this helper
	// before the value can reach ensureRecordForSessionFile -> spawnInstance ->
	// getNamespaceAgentDir. A path-traversal-shaped name is just an unknown
	// namespace as far as the registry is concerned, so it is rejected the same way.
	it("rejects a namespace that was never registered, including path-traversal-shaped names", () => {
		for (const value of ["ghost", "../../etc", "..", "/etc/passwd", "a/../../b"]) {
			expect(resolveRequestNamespace(value)).toEqual({ ok: false, error: `Unknown namespace: ${value}` });
		}
	});
});

describe("getNamespaceAgentDir defense-in-depth", () => {
	// Finding #1: even if some caller ever forgets to validate/normalize a
	// namespace before this point, getNamespaceAgentDir itself must never turn an
	// invalid name into a path.join escape out of ~/.pi/namespaces.
	it("throws for names that fail NAMESPACE_NAME_PATTERN instead of joining them into a path", () => {
		for (const value of ["../../etc", "..", "/etc/passwd", "a/../../b", "", "Not Valid!"]) {
			expect(() => getNamespaceAgentDir(value)).toThrow(/Invalid namespace name/);
		}
	});

	it("still resolves a valid name normally", () => {
		expect(getNamespaceAgentDir("work")).toContain(join("namespaces", "work", "agent"));
	});
});

describe("storage round-trip", () => {
	it("loadNamespaces returns [] when no registry file exists yet", () => {
		expect(loadNamespaces()).toEqual([]);
	});

	it("saveNamespaces followed by loadNamespaces round-trips exactly", () => {
		const records = [
			{ name: "work", createdAt: "2024-01-01T00:00:00.000Z" },
			{ name: "personal", createdAt: "2024-02-02T00:00:00.000Z" },
		];
		saveNamespaces(records);
		expect(loadNamespaces()).toEqual(records);
	});
});

describe("ServerSupervisor.moveInstanceNamespace", () => {
	// Finding #3: spawnInstance upserts its own new InstanceRecord as soon as it
	// starts, before the failure that triggers failSpawn. If the post-move respawn
	// then fails, that upserted record is stray and must not be left behind
	// alongside the original (already updated to "stopped" + the new namespace) -
	// otherwise the dashboard shows two rows for one session file.
	it("leaves exactly one stopped record with the new namespace when the post-move respawn fails", async () => {
		createNamespace("work");
		const sessionFile = join(serverDir, "fake-session.jsonl");
		const socket = new FakeSocket() as unknown as Socket;
		const instance = await supervisor.registerInstance(socket, {
			cwd: "/tmp/project",
			sessionFile,
		});

		const originalSpawnInstance = supervisor.spawnInstance.bind(supervisor);
		// Simulate spawnInstance's real behavior on a failed respawn: it upserts a
		// brand new record for the attempt, then throws.
		supervisor.spawnInstance = (async (options: {
			cwd: string;
			label?: string;
			sessionFile?: string;
			namespace?: string;
		}) => {
			const strayRecord: InstanceRecord = {
				id: "stray-respawn-attempt",
				status: "starting",
				cwd: options.cwd,
				createdAt: new Date().toISOString(),
				sessionFile: options.sessionFile,
				namespace: options.namespace,
			};
			upsertInstance(strayRecord);
			throw new Error("simulated respawn failure");
		}) as typeof supervisor.spawnInstance;

		try {
			const result = await supervisor.moveInstanceNamespace(instance.id, "work");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toMatch(/Namespace updated but restart failed/);
			}

			const recordsForSessionFile = loadInstances().filter((record) => record.sessionFile === sessionFile);
			expect(recordsForSessionFile).toHaveLength(1);
			expect(recordsForSessionFile[0]).toMatchObject({
				id: instance.id,
				status: "stopped",
				namespace: "work",
			});
			expect(loadInstances().some((record) => record.id === "stray-respawn-attempt")).toBe(false);
		} finally {
			supervisor.spawnInstance = originalSpawnInstance;
		}
	});
});

// Finding #1 (web.ts): end-to-end proof that the REST entry points which accept a
// client-supplied namespace reject an unknown/never-registered one - including a
// path-traversal-shaped name - before it can reach ensureRecordForSessionFile ->
// spawnInstance -> getNamespaceAgentDir. Exercises the real HTTP handlers, not just
// the resolveRequestNamespace unit above.
describe("REST namespace validation (web.ts)", () => {
	let handle: Awaited<ReturnType<typeof startServerWeb>>;
	let baseUrl: string;
	let sessionPath: string;

	beforeEach(async () => {
		handle = await startServerWeb({ host: "127.0.0.1", port: 0 });
		baseUrl = `http://127.0.0.1:${handle.port}`;
		sessionPath = join(serverDir, "crafted-session.jsonl");
	});

	afterEach(async () => {
		await handle.close();
	});

	async function postJson(
		path: string,
		body: unknown,
	): Promise<{ status: number; data: { ok: boolean; error?: string } }> {
		const res = await fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: res.status, data: (await res.json()) as { ok: boolean; error?: string } };
	}

	const maliciousNamespace = "../../etc";

	it("rejects an unknown/traversal-shaped namespace on /api/sessions/rename instead of creating a record for it", async () => {
		const { status, data } = await postJson("/api/sessions/rename", {
			path: sessionPath,
			cwd: "/tmp",
			name: "pwned",
			namespace: maliciousNamespace,
		});
		expect(status).toBe(200);
		expect(data).toEqual({ ok: false, error: `Unknown namespace: ${maliciousNamespace}` });
		expect(loadInstances()).toEqual([]);
	});

	it("rejects an unknown/traversal-shaped namespace on /api/sessions/pin instead of spawning under it", async () => {
		const { status, data } = await postJson("/api/sessions/pin", {
			path: sessionPath,
			cwd: "/tmp",
			pinned: true,
			namespace: maliciousNamespace,
		});
		expect(status).toBe(200);
		expect(data).toEqual({ ok: false, error: `Unknown namespace: ${maliciousNamespace}` });
		// The vulnerable path: setPinned's immediate-spawn branch would have called
		// spawnInstance -> getNamespaceAgentDir(maliciousNamespace) had a record with
		// this namespace ever been created.
		expect(loadInstances()).toEqual([]);
	});

	it("rejects an unknown/traversal-shaped namespace on /api/sessions/archive instead of creating a record for it", async () => {
		const { status, data } = await postJson("/api/sessions/archive", {
			path: sessionPath,
			cwd: "/tmp",
			archived: true,
			namespace: maliciousNamespace,
		});
		expect(status).toBe(200);
		expect(data).toEqual({ ok: false, error: `Unknown namespace: ${maliciousNamespace}` });
		expect(loadInstances()).toEqual([]);
	});

	it("rejects an unknown/traversal-shaped fromNamespace on /api/sessions/move instead of creating a record for it", async () => {
		const { status, data } = await postJson("/api/sessions/move", {
			path: sessionPath,
			cwd: "/tmp",
			namespace: DEFAULT_NAMESPACE,
			fromNamespace: maliciousNamespace,
		});
		expect(status).toBe(200);
		expect(data).toEqual({ ok: false, error: `Unknown namespace: ${maliciousNamespace}` });
		expect(loadInstances()).toEqual([]);
	});

	it("still accepts the implicit default namespace on these endpoints", async () => {
		const { status, data } = await postJson("/api/sessions/rename", {
			path: sessionPath,
			cwd: "/tmp",
			name: "ok",
		});
		expect(status).toBe(200);
		expect(data.ok).toBe(true);
		expect(loadInstances()).toHaveLength(1);
	});
});
