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
let configDir: string;
let previousConfigDir: string | undefined;
let asyncScratchDir: string;
let previousTmpDir: string | undefined;
let previousRadiusApiKey: string | undefined;

beforeEach(() => {
	previousServerDir = process.env.PI_SERVER_DIR;
	serverDir = mkdtempSync(join(tmpdir(), "pi-server-subagents-test-"));
	process.env.PI_SERVER_DIR = serverDir;

	previousConfigDir = process.env.PI_CONFIG_DIR;
	configDir = mkdtempSync(join(tmpdir(), "pi-server-subagents-config-test-"));
	process.env.PI_CONFIG_DIR = configDir;

	// listSubagentRuns's subagentAsyncDir() derives from node:os tmpdir(), which
	// reads TMPDIR fresh on every call (not cached at process start). Overriding
	// it isolates these fixtures from this machine's real pi-subagents temp dir
	// (shared, uid-scoped, and outside this repo's control) instead of writing
	// fixture runs alongside real async subagent runs.
	previousTmpDir = process.env.TMPDIR;
	asyncScratchDir = mkdtempSync(join(tmpdir(), "pi-server-subagents-tmp-test-"));
	process.env.TMPDIR = asyncScratchDir;

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

	if (previousTmpDir === undefined) {
		delete process.env.TMPDIR;
	} else {
		process.env.TMPDIR = previousTmpDir;
	}
	rmSync(asyncScratchDir, { recursive: true, force: true });

	if (previousRadiusApiKey === undefined) {
		delete process.env.RADIUS_API_KEY;
	} else {
		process.env.RADIUS_API_KEY = previousRadiusApiKey;
	}
});

/** Mirrors subagentAsyncDir() in web.ts, using the overridden TMPDIR above. */
function asyncRunDir(runId: string): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	const scope = uid !== undefined ? `uid-${uid}` : "shared";
	return join(asyncScratchDir, `pi-subagents-${scope}`, "async-subagent-runs", runId);
}

function writeStatus(runId: string, status: Record<string, unknown>): void {
	const dir = asyncRunDir(runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "status.json"), JSON.stringify(status));
}

async function getJson(baseUrl: string, path: string): Promise<Record<string, unknown>> {
	const res = await fetch(`${baseUrl}${path}`);
	return (await res.json()) as Record<string, unknown>;
}

describe("listSubagentRuns / resolveSubagentArtifact (via GET /i/<id>/subagents)", () => {
	let handle: Awaited<ReturnType<typeof startServerWeb>>;
	let baseUrl: string;

	beforeEach(async () => {
		handle = await startServerWeb({ host: "127.0.0.1", port: 0 });
		baseUrl = `http://127.0.0.1:${handle.port}`;
	});

	afterEach(async () => {
		await handle.close();
	});

	// Root session file + its companion directory layout, matching the real
	// pi-subagents extension: <sessionRoot>/<stepRunId>/run-N/session.jsonl,
	// sibling to <sessionRoot>/forks/ and <sessionRoot>/subagent-artifacts/.
	function makeSessionRoot(basename: string): { sessionFile: string; companionDir: string } {
		const sessionsDir = join(configDir, "sessions", "--fake-project--");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = join(sessionsDir, `${basename}.jsonl`);
		writeFileSync(sessionFile, '{"type":"session","version":3,"id":"root","timestamp":"2024-01-01T00:00:00.000Z"}\n');
		const companionDir = join(sessionsDir, basename);
		mkdirSync(companionDir, { recursive: true });
		return { sessionFile, companionDir };
	}

	function writeChildSessionFile(companionDir: string, runId: string, text: string): string {
		const dir = join(companionDir, runId, "run-0");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "session.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"session","version":3,"id":"child","timestamp":"2024-01-01T00:00:01.000Z"}',
				`{"type":"message","id":"m1","parentId":null,"timestamp":"2024-01-01T00:00:02.000Z","message":{"role":"user","content":[{"type":"text","text":"${text}"}]}}`,
				"",
			].join("\n"),
		);
		return file;
	}

	// Finding 1 (P0): workflow-mode steps never carry transcriptPath, only their
	// own sessionFile; listSubagentRuns must fall back to it so the Transcript tab
	// isn't permanently empty for workflow runs.
	it("falls back to a workflow step's own sessionFile as the transcript when transcriptPath is absent", async () => {
		const { sessionFile, companionDir } = makeSessionRoot("2024-01-01T00-00-00-000Z_root");
		const runId = "11111111-1111-1111-1111-111111111111";
		const childSessionFile = writeChildSessionFile(companionDir, runId, "hello from workflow child");

		writeStatus(runId, {
			runId,
			sessionId: sessionFile,
			mode: "workflow",
			state: "complete",
			startedAt: 1000,
			steps: [{ agent: "worker", status: "completed", sessionFile: childSessionFile }],
		});

		const instance = await supervisor.registerInstance(new FakeSocket() as unknown as Socket, {
			cwd: "/tmp/fake-project",
			sessionFile,
		});

		const listData = await getJson(baseUrl, `/i/${instance.id}/subagents`);
		expect(listData.ok).toBe(true);
		const runs = listData.runs as Array<Record<string, unknown>>;
		const run = runs.find((r) => r.runId === runId);
		expect(run).toBeDefined();
		expect(run?.transcriptPath).toBe(`session-dir/${runId}/run-0/session.jsonl`);
		expect(run?.transcriptBytes).toBeGreaterThan(0);

		const fileData = await getJson(
			baseUrl,
			`/i/${instance.id}/subagents/file?path=${encodeURIComponent(run?.transcriptPath as string)}`,
		);
		expect(fileData.ok).toBe(true);
		expect(fileData.content as string).toContain("hello from workflow child");
	});

	// Finding 2 (P1): the run dir's own orchestration logs must be globbed
	// (output-N.log for every child), not hardcoded to output-0.log only.
	it("globs every output-N.log in the async run dir instead of only output-0.log", async () => {
		const { sessionFile } = makeSessionRoot("2024-02-01T00-00-00-000Z_root");
		const runId = "22222222-2222-2222-2222-222222222222";
		writeStatus(runId, {
			runId,
			sessionId: sessionFile,
			mode: "chain",
			state: "complete",
			startedAt: 2000,
			steps: [{ agent: "worker", status: "completed" }],
		});
		const dir = asyncRunDir(runId);
		// Numeric order should win over lexical (10 sorts after 2, not before).
		writeFileSync(join(dir, "output-0.log"), "child 0 log");
		writeFileSync(join(dir, "output-2.log"), "child 2 log");
		writeFileSync(join(dir, "output-10.log"), "child 10 log");
		writeFileSync(join(dir, "not-an-output.log"), "should be ignored");
		writeFileSync(join(dir, `subagent-log-${runId}.md`), "orchestration summary");

		const instance = await supervisor.registerInstance(new FakeSocket() as unknown as Socket, {
			cwd: "/tmp/fake-project",
			sessionFile,
		});

		const listData = await getJson(baseUrl, `/i/${instance.id}/subagents`);
		const runs = listData.runs as Array<Record<string, unknown>>;
		const run = runs.find((r) => r.runId === runId);
		expect(run).toBeDefined();
		const outputNames = (run?.outputs as Array<{ name: string }>).map((o) => o.name);
		expect(outputNames).toEqual(["output-0.log", "output-2.log", "output-10.log", `subagent-log-${runId}.md`]);
	});

	// Finding 4 (P1): a fork/new-session/change-cwd updates instance.sessionFile,
	// which must not orphan a still-running async run recorded against the
	// original session file in the same session directory tree.
	it("matches an async run recorded against the session root even when the instance's sessionFile is now a fork", async () => {
		const { sessionFile, companionDir } = makeSessionRoot("2024-03-01T00-00-00-000Z_root");
		const forksDir = join(companionDir, "forks");
		mkdirSync(forksDir, { recursive: true });
		const forkSessionFile = join(forksDir, "2024-03-01T00-05-00-000Z_fork.jsonl");
		writeFileSync(
			forkSessionFile,
			'{"type":"session","version":3,"id":"fork","timestamp":"2024-03-01T00:05:00.000Z"}\n',
		);

		const runId = "33333333-3333-3333-3333-333333333333";
		writeStatus(runId, {
			runId,
			sessionId: sessionFile, // recorded against the pre-fork root session file
			mode: "chain",
			state: "running",
			startedAt: 3000,
			steps: [{ agent: "worker", status: "running" }],
		});

		const instance = await supervisor.registerInstance(new FakeSocket() as unknown as Socket, {
			cwd: "/tmp/fake-project",
			sessionFile: forkSessionFile, // instance has since forked
		});

		const listData = await getJson(baseUrl, `/i/${instance.id}/subagents`);
		const runs = listData.runs as Array<Record<string, unknown>>;
		const run = runs.find((r) => r.runId === runId);
		expect(run).toBeDefined();
		expect(run?.fromEarlierSession).toBe(true);
	});
});
