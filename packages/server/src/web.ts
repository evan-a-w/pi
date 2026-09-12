/**
 * Web hosting for supervised instances: serves the pi web UI (static assets
 * from @earendil-works/pi-web) and proxies each instance's RPC protocol over a
 * WebSocket endpoint (same JSON messages as docs/rpc.md, one per frame).
 *
 * Layout:
 * - GET /                     instance index (links to each instance)
 * - GET /i/<id>/              the pi web UI for that instance (SPA)
 * - WS  /i/<id>/ws            RPC protocol stream for that instance
 * - GET /i/<id>/subagents     subagent runs for that instance (pi-subagents artifacts)
 * - GET /i/<id>/subagents/file?path=<rel>  a subagent transcript/output artifact
 * - GET /i/<id>/files?path=<rel>           read-only directory listing under that instance's cwd
 * - GET /i/<id>/files/content?path=<rel>   read-only file content (text files ≤ 512KB)
 * - GET /review               cranium code review UI
 * - GET /themes, /theme/*     TUI theme files, shared by all instances
 * - GET  /api/dashboard-sessions       merged live/stopped/past session list (dashboard), tagged by namespace
 * - POST /api/sessions/rename          rename a session (by instance id or session file path)
 * - POST /api/sessions/pin             pin/unpin a session ("always up")
 * - POST /api/sessions/archive         archive/unarchive a session
 * - POST /api/sessions/delete          stop (if live), forget, and delete a session's file
 * - POST /api/sessions/move            move a session to another namespace (session file stays put)
 * - GET  /api/namespaces               list account namespaces (always includes "default")
 * - POST /api/namespaces               create a namespace: { name }
 * - POST /api/namespaces/delete        remove an empty namespace from the registry
 * - GET  /api/fs/dirs?prefix=<path>    directory-only path completions for the spawn form
 * - GET  /settings                     dashboard settings page (default cwd + snippets)
 * - GET  /api/settings                 full dashboard settings object
 * - PUT  /api/settings                 update dashboard settings (partial: omitted fields unchanged)
 * - GET  /api/snippets                 lightweight snippet list, for the chat composer's snippet picker
 */

import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import {
	getAgentDir,
	getCustomThemesDir,
	getThemesDir,
	getWebDistDir,
	type RpcCommand,
	type RpcExtensionUIResponse,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";
import { getNamespaceAgentDir } from "./config.ts";
import {
	createNamespace,
	DEFAULT_NAMESPACE,
	deleteNamespace,
	listNamespaces,
	resolveRequestNamespace,
} from "./namespaces.ts";
import { getDashboardSettings, updateDashboardSettings } from "./settings.ts";
import { supervisor } from "./supervisor.ts";
import type { InstanceRecord } from "./types.ts";

const CRANIUM_BIN = process.env.PI_CRANIUM_BIN || path.join(homedir(), "dev", "cranium", "dist", "src", "cli.js");

function runCranium(
	args: string[],
	opts?: { input?: string; cwd?: string },
): { ok: true; data: unknown } | { ok: false; error: string } {
	try {
		const stdout = execFileSync(process.execPath, [CRANIUM_BIN, ...args], {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
			cwd: opts?.cwd,
			input: opts?.input,
		});
		return parseCraniumOutput(stdout);
	} catch (error) {
		const stdout = (error as { stdout?: string }).stdout;
		if (stdout) {
			const parsed = parseCraniumOutput(stdout);
			if (!parsed.ok) return parsed;
		}
		const stderr = (error as { stderr?: string }).stderr || String(error);
		return { ok: false, error: stderr };
	}
}

function parseCraniumOutput(stdout: string): { ok: true; data: unknown } | { ok: false; error: string } {
	try {
		const parsed = JSON.parse(stdout);
		if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
			return { ok: false, error: parsed.error };
		}
		return { ok: true, data: parsed };
	} catch {
		return { ok: true, data: stdout };
	}
}

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
	".woff2": "font/woff2",
	".ico": "image/x-icon",
};

export interface ServerWebOptions {
	host: string;
	port: number;
}

export interface ServerWebHandle {
	host: string;
	port: number;
	close(): Promise<void>;
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

function listThemeNames(): string[] {
	const names = new Set<string>();
	for (const dir of [getThemesDir(), getCustomThemesDir()]) {
		try {
			for (const file of fs.readdirSync(dir)) {
				if (file.endsWith(".json") && !file.startsWith("theme-schema")) {
					names.add(file.slice(0, -".json".length));
				}
			}
		} catch {
			// dir does not exist
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

function resolveThemeFile(name: string): string | undefined {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return undefined;
	// Built-in themes take precedence on name conflicts, matching the TUI
	for (const dir of [getThemesDir(), getCustomThemesDir()]) {
		const candidate = path.join(dir, `${name}.json`);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return undefined;
}

// ============================================================================
// Subagent inspection (pi-subagents extension artifacts)
//
// The pi-subagents extension persists per-run data under <cwd>/.pi-subagents/:
//   artifacts/<runId>_<agent>_<index>_transcript.jsonl  live child event stream
//   artifacts/<runId>_<agent>_<index>_meta.json         written when the run ends
//   artifacts/<runId>_<agent>_<index>_output.md         final output
//   artifacts/outputs/<runId>/<file>                    named output artifacts
// Async (background) runs live in the user-scoped temp dir with status.json
// files that carry the originating sessionId.
// ============================================================================

const SUBAGENT_ARTIFACTS_DIR = ".pi-subagents/artifacts";
const MAX_SUBAGENT_FILE_BYTES = 4 * 1024 * 1024;

interface SubagentRunSummary {
	key: string;
	source: "foreground" | "async";
	runId: string;
	agent: string;
	status: "running" | "done" | "failed";
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	model?: string;
	task?: string;
	exitCode?: number;
	error?: string;
	usage?: Record<string, unknown>;
	toolCount?: number;
	transcriptPath?: string;
	transcriptBytes?: number;
	outputPath?: string;
	outputs?: Array<{ name: string; path: string; bytes: number }>;
	/**
	 * True when this async run was only matched via the same-session-directory-tree
	 * fallback (its status.sessionId is a fork/prior session file under the same
	 * session root as the instance's current sessionFile), not an exact match. The
	 * UI surfaces these separately since they may be stale relative to the active
	 * session state.
	 */
	fromEarlierSession?: boolean;
}

function readJsonFile<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function fileBytes(filePath: string): number | undefined {
	try {
		return fs.statSync(filePath).size;
	} catch {
		return undefined;
	}
}

/** Read at most maxBytes from the start of a file, instead of the whole thing. */
function readBoundedFile(filePath: string, totalBytes: number, maxBytes: number): string {
	if (totalBytes <= maxBytes) return fs.readFileSync(filePath, "utf-8");
	const buffer = Buffer.alloc(maxBytes);
	const fd = fs.openSync(filePath, "r");
	try {
		const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.toString("utf-8", 0, bytesRead);
	} finally {
		fs.closeSync(fd);
	}
}

function subagentStatus(exitCode: unknown): "running" | "done" | "failed" {
	if (typeof exitCode !== "number") return "running";
	return exitCode === 0 ? "done" : "failed";
}

/**
 * Root session file for a session path, collapsing forks to the session they were
 * forked from. Fork files live at "<sessionRoot>/forks/<fork>.jsonl", where
 * "<sessionRoot>" is the original session file's own companion directory (same
 * basename, no ".jsonl" extension) — e.g.
 *   .../sessions/<ns>/TS_ID.jsonl                    (original)
 *   .../sessions/<ns>/TS_ID/forks/OTHER_ID.jsonl      (fork)
 * both resolve to ".../sessions/<ns>/TS_ID.jsonl" here, so runs recorded against
 * either one are recognized as belonging to the same session tree.
 */
function sessionTreeRoot(sessionFilePath: string): string {
	const dir = path.dirname(sessionFilePath);
	if (path.basename(dir) === "forks") {
		return `${path.dirname(dir)}.jsonl`;
	}
	return sessionFilePath;
}

/**
 * The session root's companion directory (same basename as its root session file,
 * without the ".jsonl" extension), which holds forks/, subagent-artifacts/, and
 * per-workflow-step run dirs. Normalizes through sessionTreeRoot first so this
 * resolves the same directory whether sessionFilePath is the root session file or
 * one of its forks.
 */
function sessionCompanionDir(sessionFilePath: string): string {
	const root = sessionTreeRoot(sessionFilePath);
	return root.endsWith(".jsonl") ? root.slice(0, -".jsonl".length) : root;
}

/** Temp dir used by the pi-subagents extension for async runs (mirrors its scoping). */
function subagentAsyncDir(): string {
	const getuid = process.getuid?.bind(process);
	let scope: string;
	if (typeof getuid === "function") {
		scope = `uid-${getuid()}`;
	} else {
		const user = process.env.USERNAME ?? process.env.USER ?? process.env.LOGNAME;
		scope = user ? `user-${user.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown"}` : "shared";
	}
	return path.join(tmpdir(), `pi-subagents-${scope}`, "async-subagent-runs");
}

/** List subagent runs visible to an instance, newest first. */
function listSubagentRuns(cwd: string, sessionFile?: string): SubagentRunSummary[] {
	const runs = new Map<string, SubagentRunSummary>();
	const artifactsDir = path.join(cwd, SUBAGENT_ARTIFACTS_DIR);
	const foregroundRunIds = new Set<string>();

	if (fs.existsSync(artifactsDir)) {
		let files: string[];
		try {
			files = fs.readdirSync(artifactsDir);
		} catch {
			files = [];
		}

		// Meta files (written at run end) carry authoritative metadata.
		const metas = new Map<string, Record<string, unknown>>();
		for (const file of files) {
			const match = /^(.+)_meta\.json$/.exec(file);
			if (!match) continue;
			const meta = readJsonFile<Record<string, unknown>>(path.join(artifactsDir, file));
			if (meta) metas.set(match[1], meta);
		}

		// Transcript files exist for the whole run (including live runs).
		for (const file of files) {
			const match = /^(.+)_transcript\.jsonl$/.exec(file);
			if (!match) continue;
			const base = match[1];
			const transcriptPath = path.join("artifacts", file);
			const bytes = fileBytes(path.join(artifactsDir, file));
			const meta = metas.get(base);
			const runId = (meta?.runId as string | undefined) ?? base.split("_")[0] ?? base;
			// Basename shape is "<runId>_<agent>" or "<runId>_<agent>_<index>"; only drop the
			// trailing segment when it is actually a numeric index, so a 2-segment agent
			// name (no index suffix) isn't mistaken for one and dropped entirely.
			const nameParts = base.split("_").slice(1);
			const hasIndexSuffix = /^\d+$/.test(nameParts.at(-1) ?? "");
			const agent =
				(meta?.agent as string | undefined) ??
				((hasIndexSuffix ? nameParts.slice(0, -1) : nameParts).join("_") || "subagent");
			foregroundRunIds.add(runId);
			runs.set(`foreground:${base}`, {
				key: `foreground:${base}`,
				source: "foreground",
				runId,
				agent,
				status: subagentStatus(meta?.exitCode),
				startedAt: typeof meta?.timestamp === "number" ? (meta.timestamp as number) : undefined,
				durationMs: meta?.durationMs as number | undefined,
				model: meta?.model as string | undefined,
				task: meta?.task as string | undefined,
				exitCode: meta?.exitCode as number | undefined,
				error: meta?.error as string | undefined,
				usage: meta?.usage as Record<string, unknown> | undefined,
				toolCount: meta?.toolCount as number | undefined,
				transcriptPath,
				transcriptBytes: bytes,
				outputPath: fs.existsSync(path.join(artifactsDir, `${base}_output.md`))
					? path.join("artifacts", `${base}_output.md`)
					: undefined,
			});
		}

		// Named outputs per runId (outputs/<runId>/).
		if (fs.existsSync(path.join(artifactsDir, "outputs"))) {
			try {
				for (const runDir of fs.readdirSync(path.join(artifactsDir, "outputs"))) {
					const outputs: SubagentRunSummary["outputs"] = [];
					const outputsPath = path.join(artifactsDir, "outputs", runDir);
					if (!fs.statSync(outputsPath).isDirectory()) continue;
					for (const file of fs.readdirSync(outputsPath)) {
						const bytes = fileBytes(path.join(outputsPath, file));
						if (bytes === undefined) continue;
						outputs.push({ name: file, path: path.join("artifacts", "outputs", runDir, file), bytes });
					}
					if (outputs.length === 0) continue;
					const run = [...runs.values()].find((candidate) => candidate.runId === runDir);
					if (run) {
						run.outputs = outputs;
					} else {
						runs.set(`foreground:outputs:${runDir}`, {
							key: `foreground:outputs:${runDir}`,
							source: "foreground",
							runId: runDir,
							agent: "subagent",
							status: "done",
							outputs,
						});
					}
				}
			} catch {
				// outputs dir unreadable: skip
			}
		}
	}

	// Async (background) runs: status.json per dir under the user-scoped temp dir.
	// The extension records the originating session FILE PATH in status.sessionId,
	// and async runs that also write project artifacts are already listed above.
	//
	// The child agent's own transcript/output/meta for each step are NOT under the
	// temp run dir: they live next to the session file, in
	// <sessionDir>/subagent-artifacts/ (see status.steps[i].transcriptPath, an
	// absolute path written by the pi-subagents extension; getArtifactPaths() in
	// its shared/artifacts.ts derives the sibling _output.md the same way). The
	// run dir itself additionally holds orchestration-level logs (output-N.log,
	// subagent-log-<runId>.md) which are exposed as named "Files" so they are
	// reachable even when a step transcript/output is missing (e.g. a run that
	// failed before the child agent produced one).
	//
	// "workflow" mode steps never get a transcriptPath (the extension only writes
	// that field for single/chain-mode steps), but every sampled step does carry
	// its own sessionFile: the child's own session .jsonl, at
	// <sessionRoot>/<stepRunId>/run-N/session.jsonl, sibling to <sessionRoot>/forks/
	// and <sessionRoot>/subagent-artifacts/. Fall back to that as the transcript
	// source so the Transcript tab isn't permanently empty for workflow runs.
	if (sessionFile) {
		const asyncDir = subagentAsyncDir();
		const currentTreeRoot = sessionTreeRoot(sessionFile);
		if (fs.existsSync(asyncDir)) {
			try {
				for (const dirName of fs.readdirSync(asyncDir)) {
					const dir = path.join(asyncDir, dirName);
					if (!fs.statSync(dir).isDirectory()) continue;
					const status = readJsonFile<Record<string, unknown>>(path.join(dir, "status.json"));
					const runSessionId = typeof status?.sessionId === "string" ? status.sessionId : undefined;
					if (!status || !runSessionId) continue;
					const isExactSessionMatch = runSessionId === sessionFile;
					// A fork/new/switch/cd/tui-reload updates instance.sessionFile, which would
					// otherwise orphan a still-running async run keyed to the old file: also
					// accept runs whose sessionId lives under the same session directory tree
					// (forks live under the original session's own companion directory).
					const isSameSessionTree = !isExactSessionMatch && sessionTreeRoot(runSessionId) === currentTreeRoot;
					if (!isExactSessionMatch && !isSameSessionTree) continue;
					const runId = (status.runId as string | undefined) ?? dirName;
					if (foregroundRunIds.has(runId)) continue;
					const state = status.state as string | undefined;
					const steps = Array.isArray(status.steps) ? (status.steps as Array<Record<string, unknown>>) : [];
					const agents =
						steps.length > 0
							? steps.map((step) => (step.agent as string | undefined) ?? "subagent")
							: [(status.mode as string | undefined) ?? "subagent"];
					// The active step for a running chain, or the last step once finished; that
					// step's own artifacts are what the Transcript/Output tabs show.
					const stepIndex = typeof status.currentStep === "number" ? status.currentStep : steps.length - 1;
					const activeStep = steps[stepIndex] ?? steps[steps.length - 1];
					const stepTranscriptAbsolute =
						typeof activeStep?.transcriptPath === "string" ? activeStep.transcriptPath : undefined;
					const stepSessionFileAbsolute =
						typeof activeStep?.sessionFile === "string" ? activeStep.sessionFile : undefined;

					let transcriptPath: string | undefined;
					let transcriptBytes: number | undefined;
					let outputPath: string | undefined;
					if (stepTranscriptAbsolute && fs.existsSync(stepTranscriptAbsolute)) {
						const stepArtifactsDir = path.dirname(stepTranscriptAbsolute);
						const transcriptBase = path.basename(stepTranscriptAbsolute);
						transcriptPath = path.join("session-artifacts", transcriptBase);
						transcriptBytes = fileBytes(stepTranscriptAbsolute);
						const outputBase = transcriptBase.replace(/_transcript\.jsonl$/, "_output.md");
						if (outputBase !== transcriptBase && fs.existsSync(path.join(stepArtifactsDir, outputBase))) {
							outputPath = path.join("session-artifacts", outputBase);
						}
					} else if (stepSessionFileAbsolute && fs.existsSync(stepSessionFileAbsolute)) {
						// Matches resolveSubagentArtifact's "session-dir" root below: the session
						// root's companion directory, not necessarily the current (possibly forked)
						// sessionFile's own directory.
						const relToSessionDir = path.relative(sessionCompanionDir(sessionFile), stepSessionFileAbsolute);
						if (relToSessionDir && !relToSessionDir.startsWith("..") && !path.isAbsolute(relToSessionDir)) {
							transcriptPath = path.join("session-dir", relToSessionDir);
							transcriptBytes = fileBytes(stepSessionFileAbsolute);
						}
					}

					const outputs: NonNullable<SubagentRunSummary["outputs"]> = [];
					let dirEntries: string[];
					try {
						dirEntries = fs.readdirSync(dir);
					} catch {
						dirEntries = [];
					}
					const outputLogFiles = dirEntries
						.filter((entry) => /^output-\d+\.log$/.test(entry))
						.sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
					for (const runLevelFile of [...outputLogFiles, `subagent-log-${runId}.md`]) {
						const absolute = path.join(dir, runLevelFile);
						const bytes = fileBytes(absolute);
						if (bytes === undefined) continue;
						outputs.push({ name: runLevelFile, path: path.join("async", dirName, runLevelFile), bytes });
					}

					runs.set(`async:${dirName}`, {
						key: `async:${dirName}`,
						source: "async",
						runId,
						agent: agents.join(" -> "),
						status:
							state === "complete" ? "done" : state === "failed" || state === "stopped" ? "failed" : "running",
						startedAt: status.startedAt as number | undefined,
						endedAt: status.endedAt as number | undefined,
						durationMs: activeStep?.durationMs as number | undefined,
						model: activeStep?.model as string | undefined,
						exitCode: activeStep?.exitCode as number | undefined,
						toolCount: activeStep?.toolCount as number | undefined,
						usage: activeStep?.tokens as Record<string, unknown> | undefined,
						error: status.error as string | undefined,
						task: status.description as string | undefined,
						transcriptPath,
						transcriptBytes,
						outputPath,
						outputs: outputs.length > 0 ? outputs : undefined,
						fromEarlierSession: isSameSessionTree ? true : undefined,
					});
				}
			} catch {
				// async dir unreadable: skip
			}
		}
	}

	return [...runs.values()].sort((left, right) => {
		const leftAt = left.startedAt ?? 0;
		const rightAt = right.startedAt ?? 0;
		return rightAt - leftAt || left.key.localeCompare(right.key);
	});
}

function resolveWithinBase(base: string, relative: string): string | undefined {
	const resolved = path.resolve(base, relative);
	if (resolved !== base && !resolved.startsWith(base + path.sep)) return undefined;
	return resolved;
}

/**
 * Resolve an artifact path returned by listSubagentRuns to an absolute file path,
 * rejecting any escape from the relevant root. Four roots, matched by prefix
 * (see listSubagentRuns for what writes into each):
 * - "session-artifacts/...": async run child transcripts/outputs, next to the
 *   session file (<sessionDir>/subagent-artifacts/). Requires a sessionFile.
 * - "session-dir/...": a workflow-mode step's own session .jsonl, under the
 *   session's companion directory (<sessionFile-without-.jsonl>/), used as the
 *   transcript fallback when no _transcript.jsonl artifact exists. Requires a
 *   sessionFile.
 * - "async/<runId>/...": the async run's own orchestration-level logs, under the
 *   user-scoped temp dir.
 * - anything else: foreground run artifacts under <cwd>/.pi-subagents/.
 */
function resolveSubagentArtifact(cwd: string, sessionFile: string | undefined, relative: string): string | undefined {
	if (relative.startsWith("session-artifacts/")) {
		if (!sessionFile) return undefined;
		const base = path.join(path.dirname(sessionFile), "subagent-artifacts");
		return resolveWithinBase(base, relative.slice("session-artifacts/".length));
	}
	if (relative.startsWith("session-dir/")) {
		if (!sessionFile) return undefined;
		return resolveWithinBase(sessionCompanionDir(sessionFile), relative.slice("session-dir/".length));
	}
	if (relative.startsWith("async/")) {
		return resolveWithinBase(subagentAsyncDir(), relative.slice("async/".length));
	}
	return resolveWithinBase(path.join(cwd, ".pi-subagents"), relative);
}

// ============================================================================
// Read-only file explorer (GET /i/<id>/files, GET /i/<id>/files/content)
// Scoped strictly to the instance's cwd; every path is resolved and prefix-
// checked against it (see resolveWithinExplorerRoot) before any fs access.
// ============================================================================

const EXPLORER_MAX_ENTRIES = 500;
const EXPLORER_MAX_FILE_BYTES = 512 * 1024;
const EXPLORER_SKIPPED_NAMES = new Set(["node_modules", ".git"]);

const EXPLORER_TEXT_EXTENSIONS = new Set([
	".js",
	".jsx",
	".ts",
	".tsx",
	".mjs",
	".cjs",
	".json",
	".jsonc",
	".md",
	".mdx",
	".txt",
	".css",
	".scss",
	".less",
	".html",
	".htm",
	".xml",
	".yml",
	".yaml",
	".toml",
	".ini",
	".cfg",
	".conf",
	".sh",
	".bash",
	".zsh",
	".fish",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".kt",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".cs",
	".php",
	".sql",
	".graphql",
	".vue",
	".svelte",
	".env",
	".csv",
	".log",
	".lock",
	".gradle",
	".properties",
]);

const EXPLORER_TEXT_BASENAMES = new Set([
	"dockerfile",
	"makefile",
	"license",
	"readme",
	"changelog",
	"authors",
	"contributing",
	".gitignore",
	".gitattributes",
	".npmrc",
	".env",
	".editorconfig",
]);

function isExplorerTextFile(filePath: string): boolean {
	if (EXPLORER_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true;
	return EXPLORER_TEXT_BASENAMES.has(path.basename(filePath).toLowerCase());
}

/** Resolve a relative explorer path against an instance's cwd, rejecting any escape (../, symlink-free path.resolve check). */
function resolveWithinExplorerRoot(cwd: string, relative: string): string | undefined {
	const base = path.resolve(cwd);
	const resolved = path.resolve(base, relative || ".");
	if (resolved !== base && !resolved.startsWith(base + path.sep)) return undefined;
	return resolved;
}

interface ExplorerEntry {
	name: string;
	type: "dir" | "file";
	size?: number;
}

type ExplorerResult<T> = ({ ok: true } & T) | { ok: false; error: string };

function listExplorerDir(cwd: string, relative: string): ExplorerResult<{ entries: ExplorerEntry[] }> {
	const dirPath = resolveWithinExplorerRoot(cwd, relative);
	if (!dirPath) return { ok: false, error: "Path escapes the working directory" };
	let names: string[];
	try {
		if (!fs.statSync(dirPath).isDirectory()) return { ok: false, error: "Not a directory" };
		names = fs.readdirSync(dirPath).sort((a, b) => a.localeCompare(b));
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const dirs: ExplorerEntry[] = [];
	const files: ExplorerEntry[] = [];
	for (const name of names) {
		if (EXPLORER_SKIPPED_NAMES.has(name)) continue;
		if (dirs.length + files.length >= EXPLORER_MAX_ENTRIES) break;
		let entryStat: fs.Stats;
		try {
			entryStat = fs.statSync(path.join(dirPath, name));
		} catch {
			continue;
		}
		if (entryStat.isDirectory()) {
			dirs.push({ name, type: "dir" });
		} else if (entryStat.isFile()) {
			files.push({ name, type: "file", size: entryStat.size });
		}
	}
	return { ok: true, entries: [...dirs, ...files] };
}

function readExplorerFile(cwd: string, relative: string): ExplorerResult<{ content: string }> {
	const filePath = resolveWithinExplorerRoot(cwd, relative);
	if (!filePath) return { ok: false, error: "Path escapes the working directory" };
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!stat.isFile()) return { ok: false, error: "Not a file" };
	if (stat.size > EXPLORER_MAX_FILE_BYTES) {
		return { ok: false, error: `File too large (${stat.size} bytes, limit ${EXPLORER_MAX_FILE_BYTES})` };
	}
	if (!isExplorerTextFile(filePath)) return { ok: false, error: "Not a text file" };
	try {
		return { ok: true, content: fs.readFileSync(filePath, "utf-8") };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Display-name precedence for a session: the session's own name (stored in the
 * session .jsonl via set_session_name / the dashboard rename control) wins over
 * the instance's label, which wins over a fallback (id prefix).
 */
function resolveInstanceDisplayName(instance: InstanceRecord): string {
	return instance.sessionName?.trim() || instance.label?.trim() || instance.id.slice(0, 8);
}

type DashboardSessionStatus = InstanceRecord["status"] | "past";

interface DashboardSessionSummary {
	id?: string;
	sessionFile?: string;
	cwd: string;
	name: string;
	status: DashboardSessionStatus;
	pinned: boolean;
	// Sort key for the pinned group (ascending, i.e. first-pinned-first, never
	// reshuffled by activity). undefined for unpinned sessions.
	pinnedAt?: string;
	archived: boolean;
	// Account namespace this session belongs to; undefined means the implicit
	// "default" namespace. See namespaces.ts.
	namespace?: string;
	messageCount?: number;
	modified?: string;
}

/**
 * Merge tracked instances (live, stopped, or errored - anything with a
 * persisted InstanceRecord) with past sessions found only by scanning session
 * files on disk, deduplicated by session file so a tracked session doesn't
 * show up twice. This is the dashboard's single session list.
 */
async function listDashboardSessions(): Promise<DashboardSessionSummary[]> {
	const instances = supervisor.listInstances();
	const trackedSessionFiles = new Set(
		instances.filter((instance) => instance.sessionFile).map((instance) => instance.sessionFile as string),
	);

	const instanceSummaries: DashboardSessionSummary[] = instances.map((instance) => ({
		id: instance.id,
		sessionFile: instance.sessionFile,
		cwd: instance.cwd,
		name: resolveInstanceDisplayName(instance),
		status: instance.status,
		pinned: Boolean(instance.pinned),
		// Records pinned before pinnedAt existed fall back to createdAt so they still
		// get a stable (if arbitrary) position instead of sorting as "most recent".
		pinnedAt: instance.pinned ? (instance.pinnedAt ?? instance.createdAt) : undefined,
		archived: Boolean(instance.archived),
		namespace: instance.namespace,
		modified: instance.lastSeenAt ?? instance.createdAt,
	}));

	// Past sessions (no InstanceRecord) are scanned per namespace: the default
	// namespace's sessions live under the normal ~/.pi/agent/sessions, and each
	// named namespace has its own tree under its own agent dir. See namespaces.ts.
	const namespaceSessionDirs: Array<{ namespace: string | undefined; sessionDir: string | undefined }> = [
		{ namespace: undefined, sessionDir: undefined },
		...listNamespaces()
			.filter((namespace) => namespace.name !== DEFAULT_NAMESPACE)
			.map((namespace) => ({
				namespace: namespace.name,
				sessionDir: path.join(getNamespaceAgentDir(namespace.name), "sessions"),
			})),
	];

	const pastSummaries: DashboardSessionSummary[] = [];
	for (const { namespace, sessionDir } of namespaceSessionDirs) {
		const pastSessions = await SessionManager.listAll(sessionDir);
		for (const session of pastSessions) {
			if (trackedSessionFiles.has(session.path)) continue;
			pastSummaries.push({
				sessionFile: session.path,
				cwd: session.cwd,
				name: session.name?.trim() || session.firstMessage || session.id.slice(0, 8),
				status: "past",
				pinned: false,
				archived: false,
				namespace,
				messageCount: session.messageCount,
				modified: session.modified instanceof Date ? session.modified.toISOString() : String(session.modified),
			});
		}
	}

	// Pinned sessions always sort first, as a group in a FIXED order by pinnedAt
	// ascending (first-pinned-first) - never by last-accessed, so using a pinned
	// session doesn't reshuffle the group. Everyone else sorts by last-accessed.
	const merged = [...instanceSummaries, ...pastSummaries];
	merged.sort((left, right) => {
		const rank = (left.pinned ? 0 : 1) - (right.pinned ? 0 : 1);
		if (rank !== 0) return rank;
		if (left.pinned && right.pinned) {
			return (left.pinnedAt ?? "").localeCompare(right.pinnedAt ?? "");
		}
		return (right.modified ?? "").localeCompare(left.modified ?? "");
	});
	return merged;
}

/**
 * Resolve the instance id a session action (rename/pin/archive/move) targets:
 * the tracked instance id directly, or - for a past session with no
 * InstanceRecord yet - a record created for its session file path. The
 * namespace is only validated (via resolveRequestNamespace) when it is
 * actually going to be used, i.e. when creating that record; it must never
 * reach ensureRecordForSessionFile (and from there spawnInstance ->
 * getNamespaceAgentDir) unvalidated.
 */
function resolveSessionActionInstanceId(parsed: {
	id?: string;
	path?: string;
	cwd?: string;
	namespace?: string;
}): { ok: true; instanceId: string } | { ok: false; error: string } {
	if (parsed.id) {
		return { ok: true, instanceId: parsed.id };
	}
	if (!parsed.path) {
		return { ok: false, error: "Missing id or path" };
	}
	const namespaceResult = resolveRequestNamespace(parsed.namespace);
	if (!namespaceResult.ok) {
		return namespaceResult;
	}
	const instanceId = supervisor.ensureRecordForSessionFile(
		parsed.path,
		parsed.cwd ?? path.dirname(parsed.path),
		undefined,
		namespaceResult.namespace,
	).id;
	return { ok: true, instanceId };
}

/** Session .jsonl files live under a per-cwd directory below an agent dir (default or a namespace's); reject anything else. */
function isSafeSessionFilePath(candidate: string): boolean {
	const resolved = path.resolve(candidate);
	if (!resolved.endsWith(".jsonl")) return false;
	const roots = [
		path.join(getAgentDir(), "sessions"),
		...listNamespaces()
			.filter((namespace) => namespace.name !== DEFAULT_NAMESPACE)
			.map((namespace) => path.join(getNamespaceAgentDir(namespace.name), "sessions")),
	];
	return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

const MAX_DIR_COMPLETIONS = 20;

/** Expand a leading ~ (and ~/...) to the current user's home directory. */
function expandHomePrefix(candidate: string): string {
	if (candidate === "~") return homedir();
	if (candidate.startsWith("~/")) return path.join(homedir(), candidate.slice(2));
	return candidate;
}

/**
 * Directory-only completions for a path prefix (the dashboard's "working
 * directory" field). Splits the prefix into an existing directory to scan and
 * a partial last segment to match; unreadable directories and entries yield no
 * matches rather than erroring, since this only powers a best-effort dropdown.
 */
function listDirCompletions(prefixRaw: string): string[] {
	const prefix = expandHomePrefix(prefixRaw.trim());
	if (!prefix) return [];

	const endsWithSep = prefix.endsWith(path.sep);
	const base = path.resolve(prefix);
	const dir = endsWithSep ? base : path.dirname(base);
	const partial = endsWithSep ? "" : path.basename(base);

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const matches: string[] = [];
	for (const entry of entries) {
		if (matches.length >= MAX_DIR_COMPLETIONS * 4) break; // bound the scan before sorting/truncating
		if (!entry.name.startsWith(partial)) continue;
		if (partial === "" && entry.name.startsWith(".")) continue;
		const fullPath = path.join(dir, entry.name);
		try {
			if (!fs.statSync(fullPath).isDirectory()) continue;
		} catch {
			continue; // unreadable or broken symlink
		}
		matches.push(fullPath);
	}
	matches.sort((a, b) => a.localeCompare(b));
	return matches.slice(0, MAX_DIR_COMPLETIONS);
}

/**
 * Directory-only autocomplete dropdown backed by GET /api/fs/dirs, shared
 * (by generating the same inline JS) between the dashboard's spawn form and
 * the settings page's default working directory field. Requires an `esc`
 * function already defined in the page's own <script> block.
 */
function dirSuggestScript(inputId: string, listId: string): string {
	return `(function() {
		var input = document.getElementById(${JSON.stringify(inputId)});
		var list = document.getElementById(${JSON.stringify(listId)});
		if (!input || !list) return;
		var debounceTimer;
		function hide() { list.style.display = "none"; list.innerHTML = ""; }
		function render(dirs) {
			if (!dirs || dirs.length === 0) { hide(); return; }
			list.innerHTML = dirs.map(function(d) {
				return '<div data-dir="' + esc(d) + '">' + esc(d) + '</div>';
			}).join("");
			list.style.display = "";
			list.querySelectorAll("[data-dir]").forEach(function(item) {
				item.onclick = function() {
					input.value = item.getAttribute("data-dir");
					hide();
					input.focus();
				};
			});
		}
		input.addEventListener("input", function() {
			clearTimeout(debounceTimer);
			var value = input.value;
			debounceTimer = setTimeout(function() {
				fetch("/api/fs/dirs?prefix=" + encodeURIComponent(value))
					.then(function(res) { return res.json(); })
					.then(function(data) { if (data.ok) render(data.dirs); })
					.catch(function() { hide(); });
			}, 200);
		});
		input.addEventListener("blur", function() {
			// Let a click on a suggestion register before the list disappears.
			setTimeout(hide, 150);
		});
	})();`;
}

/**
 * Shared design tokens + base element styles for the server-rendered dashboard
 * pages (index, settings). Kept as one constant so the two pages never drift
 * into inconsistent spacing/color scales; page-specific rules are appended
 * after this in each page's own <style> block.
 */
const DASHBOARD_BASE_CSS = `
		:root,
		:root[data-theme="light"] {
			color-scheme: light;
			--ds-space-1: 4px;
			--ds-space-2: 8px;
			--ds-space-3: 12px;
			--ds-space-4: 16px;
			--ds-space-5: 20px;
			--ds-space-6: 28px;
			--ds-radius-sm: 4px;
			--ds-radius-md: 8px;
			--ds-radius-lg: 12px;
			--ds-font-xs: 11px;
			--ds-font-sm: 12px;
			--ds-font-base: 13px;
			--ds-font-md: 14px;
			--ds-font-lg: 16px;
			--ds-bg: #ffffff;
			--ds-surface: #f5f5f5;
			--ds-surface-2: #ffffff;
			--ds-surface-hover: #eeeeee;
			--ds-surface-selected: #e8e8e8;
			--ds-border: #e0e0e0;
			--ds-text: #1a1a1a;
			--ds-text-muted: #515c6b;
			--ds-text-dim: #5e6673;
			--ds-accent: #245bce;
			--ds-accent-hover: #1d4ed8;
			--ds-accent-fg: #ffffff;
			--ds-danger: #dc2626;
			--ds-danger-bg: #fef2f2;
			--ds-success: #16a34a;
			--ds-warning: #b45309;
			--ds-tap-min: 44px;
		}
		:root[data-theme="dark"] {
			color-scheme: dark;
			--ds-bg: #1a1a1a;
			--ds-surface: #242424;
			--ds-surface-2: #1a1a1a;
			--ds-surface-hover: #2e2e2e;
			--ds-surface-selected: #383838;
			--ds-border: #454545;
			--ds-text: #e8e8e8;
			--ds-text-muted: #b7b7b7;
			--ds-text-dim: #a4a4a4;
			--ds-accent: #a4c2f4;
			--ds-accent-hover: #c3d8fa;
			--ds-accent-fg: #182234;
			--ds-danger: #f87171;
			--ds-danger-bg: #2a1a1a;
			--ds-success: #4ade80;
			--ds-warning: #facc15;
		}
		*, *::before, *::after { box-sizing: border-box; }
		html { -webkit-text-size-adjust: 100%; background: var(--ds-bg); }
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			background: var(--ds-bg);
			color: var(--ds-text);
			margin: 0;
			line-height: 1.5;
			font-size: var(--ds-font-md);
			-webkit-font-smoothing: antialiased;
		}
		pre, code { font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
		h1 { font-size: var(--ds-font-lg); margin: 0; font-weight: 700; }
		h2 { font-size: var(--ds-font-lg); margin: 0; font-weight: 600; }
		h3 { font-size: var(--ds-font-base); margin: 0 0 var(--ds-space-2); color: var(--ds-text-muted); font-weight: 600; }
		a { color: var(--ds-accent); }
		.meta { color: var(--ds-text-dim); font-size: var(--ds-font-sm); margin-left: var(--ds-space-2); }
		.meta.error { color: var(--ds-danger); }
		ul { list-style: none; padding: 0; margin: 0; }
		input[type="text"], select, textarea {
			font-family: inherit;
			font-size: var(--ds-font-md);
			background: var(--ds-surface-2);
			color: var(--ds-text);
			border: 1px solid var(--ds-border);
			padding: 8px 10px;
			border-radius: var(--ds-radius-sm);
			transition: border-color 0.12s ease, box-shadow 0.12s ease;
		}
		input[type="text"]::placeholder, textarea::placeholder { color: var(--ds-text-dim); }
		input[type="text"]:focus, select:focus, textarea:focus, input[type="checkbox"]:focus-visible {
			outline: none;
			border-color: var(--ds-accent);
			box-shadow: 0 0 0 2px color-mix(in srgb, var(--ds-accent) 20%, transparent);
		}
		:focus-visible { outline: 2px solid var(--ds-accent); outline-offset: 1px; }
		textarea { resize: vertical; }
		.page-top {
			display: flex;
			align-items: center;
			gap: var(--ds-space-2);
			min-height: 44px;
			padding: var(--ds-space-2) var(--ds-space-4);
			padding-top: calc(var(--ds-space-2) + env(safe-area-inset-top));
			border-bottom: 1px solid var(--ds-border);
		}
		.page-top h1 { line-height: 1; }
		.page-nav { display: flex; align-items: center; gap: var(--ds-space-1); margin-left: auto; }
		.page-nav-link {
			min-height: 28px;
			display: inline-flex;
			align-items: center;
			padding: 4px 8px;
			border-radius: var(--ds-radius-sm);
			color: var(--ds-text-muted);
			font-size: var(--ds-font-sm);
			text-decoration: none;
		}
		.page-nav-link:hover { color: var(--ds-text); background: var(--ds-surface-hover); }
		.page-nav-link.active { color: var(--ds-text); font-weight: 600; }
		.theme-toggle {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 28px;
			height: 28px;
			padding: 0;
			background: none;
			border: 0;
			border-radius: var(--ds-radius-sm);
			color: var(--ds-text-muted);
			cursor: pointer;
		}
		.theme-toggle:hover { background: var(--ds-surface-hover); color: var(--ds-text); }
		:root[data-theme="light"] .theme-icon-dark,
		:root[data-theme="dark"] .theme-icon-light { display: none; }
		.page-content { width: 100%; margin: 0 auto; padding: var(--ds-space-6) var(--ds-space-5); }
		.primary-btn {
			font-family: inherit;
			font-size: var(--ds-font-base);
			font-weight: 600;
			cursor: pointer;
			background: var(--ds-accent);
			color: var(--ds-accent-fg);
			border: 1px solid var(--ds-accent);
			padding: 8px 14px;
			border-radius: var(--ds-radius-sm);
			transition: background-color 0.12s ease, border-color 0.12s ease;
		}
		.primary-btn:hover { background: var(--ds-accent-hover); border-color: var(--ds-accent-hover); }
		.secondary-btn {
			font-family: inherit;
			font-size: var(--ds-font-base);
			background: transparent;
			color: var(--ds-text-muted);
			border: 1px solid var(--ds-border);
			padding: 6px 12px;
			border-radius: var(--ds-radius-sm);
			cursor: pointer;
			min-height: 34px;
		}
		.secondary-btn:hover { background: var(--ds-surface-hover); color: var(--ds-text); }
		.secondary-btn.danger { color: var(--ds-danger); }
		button:disabled { opacity: 0.4; cursor: default; }
		@media (max-width: 640px) {
			.page-content { padding: var(--ds-space-5) var(--ds-space-4); }
			.page-top { padding-left: var(--ds-space-3); padding-right: var(--ds-space-3); }
		}
		@media (pointer: coarse) {
			.page-nav-link, .theme-toggle { min-height: var(--ds-tap-min); }
			.theme-toggle { width: var(--ds-tap-min); }
			input[type="text"], select, textarea { font-size: 16px; }
		}
	`;

/**
 * Sets data-theme on <html> from the SAME localStorage key the SPA's theme
 * toggle persists to (THEME_STORAGE_KEY in packages/web/src/theme.ts:
 * "pi-web-theme"), so the dashboard/settings pages open in whichever
 * light/dark choice the user last made in the app. Inline and synchronous
 * (not a deferred module) so it runs before first paint and there is no
 * flash of the wrong theme. Like the SPA, light is the default when there is
 * no stored choice; toggling writes "light" or "dark" back to the same key.
 */
const CLIENT_THEME_BOOTSTRAP_SCRIPT = `<script>(function(){
	function setTheme(name, persist) {
		var theme = /light/i.test(name) ? "light" : "dark";
		document.documentElement.dataset.theme = theme;
		var button = document.querySelector(".theme-toggle");
		if (button) button.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
		if (persist) {
			try { localStorage.setItem("pi-web-theme", theme); } catch (_error) {}
		}
	}
	try { setTheme(localStorage.getItem("pi-web-theme") || "light", false); } catch (_error) { setTheme("light", false); }
	window.toggleDashboardTheme = function() {
		try { setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light", true); } catch (_error) {}
	};
	window.addEventListener("DOMContentLoaded", function() {
		setTheme(document.documentElement.dataset.theme || "light", false);
	});
})();</script>`;

const DASHBOARD_THEME_TOGGLE = `<button type="button" class="theme-toggle" title="Switch theme" onclick="toggleDashboardTheme()">
	<svg class="theme-icon-light" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
		<title>Dark theme</title>
		<path d="M13.5 9.5A5.5 5.5 0 016.5 2.5 5.5 5.5 0 1013.5 9.5z" stroke="currentColor" stroke-width="1.2" fill="none" />
	</svg>
	<svg class="theme-icon-dark" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
		<title>Light theme</title>
		<circle cx="8" cy="8" r="3.2" stroke="currentColor" stroke-width="1.2" />
		<path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
	</svg>
</button>`;

function renderIndexPage(): string {
	return `<!doctype html>
<html lang="en" data-theme="light">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
	<meta name="theme-color" content="#ffffff" />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-title" content="pi" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<link rel="icon" href="/icons/pi.svg" type="image/svg+xml" />
	<link rel="apple-touch-icon" href="/icons/pi-180.png" />
	<title>pi server</title>
	${CLIENT_THEME_BOOTSTRAP_SCRIPT}
	<style>
${DASHBOARD_BASE_CSS}
		.page-content { max-width: 1240px; }
		.meta { margin-left: 0; }
		.ns-bar {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: var(--ds-space-2);
			min-height: 32px;
			margin: 0 0 var(--ds-space-5);
			color: var(--ds-text-dim);
			font-size: var(--ds-font-sm);
		}
		.ns-bar label { color: var(--ds-text-dim); }
		.ns-bar select, .ns-bar input[type="text"] { font-size: var(--ds-font-sm); padding: 5px 8px; }
		.ns-bar input[type="text"] { width: 160px; }
		#ns-create-form { display: inline-flex; align-items: center; gap: var(--ds-space-2); }
		.ns-tag { color: var(--ds-text-dim); }
		.dash-columns { display: flex; gap: var(--ds-space-6); align-items: flex-start; }
		.dash-main { flex: 1 1 auto; min-width: 0; }
		.dash-side { flex: 0 0 340px; }
		.sessions-header { display: flex; align-items: center; min-height: 36px; gap: var(--ds-space-3); }
		.sessions-header h2 { font-size: var(--ds-font-md); }
		.header-right { display: flex; align-items: center; gap: var(--ds-space-2); margin-left: auto; font-size: var(--ds-font-sm); flex-wrap: wrap; }
		.header-right .row-btn { min-height: 30px; padding: 5px 10px; }
		.spawn-form { padding-left: var(--ds-space-5); border-left: 1px solid var(--ds-border); }
		.spawn-form h2 { font-size: var(--ds-font-md); margin: 0 0 var(--ds-space-3); }
		.spawn-form label { display: block; margin: var(--ds-space-3) 0 0; font-size: var(--ds-font-sm); color: var(--ds-text-muted); }
		.spawn-form label:first-of-type { margin-top: 0; }
		.spawn-form input[type="text"], .spawn-form select { width: 100%; margin-top: var(--ds-space-1); }
		.spawn-form button[type="submit"] { width: 100%; padding: 9px 16px; font-size: var(--ds-font-md); }
		.spawn-actions { display: flex; align-items: center; gap: var(--ds-space-3); margin-top: var(--ds-space-4); flex-wrap: wrap; }
		.spawn-actions button { width: auto; flex: 1 1 auto; }
		#spawn-namespace-wrap { margin-top: var(--ds-space-3); }
		.spawn-result { margin-top: var(--ds-space-3); font-size: var(--ds-font-sm); min-height: 1.2em; }
		.spawn-result.error { color: var(--ds-danger); }
		.spawn-result.success { color: var(--ds-success); }
		.spawn-check { display: flex !important; align-items: center; gap: var(--ds-space-2); margin: 0 !important; font-size: var(--ds-font-sm) !important; color: var(--ds-text-muted) !important; cursor: pointer; }
		.spawn-check input { appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin: 0; border: 1px solid var(--ds-border); border-radius: 3px; background: var(--ds-surface-2); cursor: pointer; position: relative; flex-shrink: 0; }
		.spawn-check input:hover { border-color: var(--ds-accent); }
		.spawn-check input:checked { background: var(--ds-accent); border-color: var(--ds-accent); }
		.spawn-check input:checked::after { content: ""; position: absolute; left: 5px; top: 2px; width: 4px; height: 8px; border: solid var(--ds-accent-fg); border-width: 0 2px 2px 0; transform: rotate(45deg); }
		.spawn-check:hover { color: var(--ds-text) !important; }
		.dir-suggest { position: relative; }
		.suggest-list { position: absolute; left: 0; right: 0; z-index: 5; background: var(--ds-surface-2); border: 1px solid var(--ds-border); border-top: none; border-radius: 0 0 var(--ds-radius-sm) var(--ds-radius-sm); max-height: 200px; overflow-y: auto; box-shadow: 0 8px 20px rgba(0,0,0,0.12); }
		.suggest-list div { padding: 8px 10px; font-size: var(--ds-font-sm); cursor: pointer; }
		.suggest-list div:hover { background: var(--ds-surface-hover); }
		.session-list { min-height: 2.5em; border-top: 1px solid var(--ds-border); }
		.session-list > .meta:only-child { display: block; padding: var(--ds-space-5) var(--ds-space-1); text-align: center; margin: 0; border-bottom: 1px solid var(--ds-border); }
		.session-row { display: flex; justify-content: space-between; align-items: center; min-height: 52px; padding: 9px var(--ds-space-1); gap: var(--ds-space-3); border-bottom: 1px solid var(--ds-border); }
		.session-row:hover { background: var(--ds-surface); }
		.session-main { display: flex; align-items: center; gap: var(--ds-space-2); min-width: 0; flex: 1; }
		.session-name { font-size: var(--ds-font-md); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; min-width: 0; max-width: 260px; }
		.session-main .meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 120px; min-width: 0; }
		.session-name-input { font-family: inherit; font-size: var(--ds-font-md); background: var(--ds-surface-2); color: var(--ds-text); border: 1px solid var(--ds-accent); border-radius: 3px; padding: 3px 6px; min-width: 0; }
		.session-actions { display: flex; gap: var(--ds-space-2); flex-wrap: wrap; flex-shrink: 0; }
		.badge { font-size: var(--ds-font-xs); color: var(--ds-text-dim); flex-shrink: 0; }
		.badge-online, .badge-starting { color: var(--ds-success); }
		.badge-error { color: var(--ds-danger); }
		.badge-stopping { color: var(--ds-warning); }
		.badge-stopped, .badge-past { color: var(--ds-text-dim); }
		.pin-icon { color: var(--ds-warning); flex-shrink: 0; display: inline-flex; align-items: center; }
		.kebab-wrap { position: relative; flex-shrink: 0; }
		.kebab-btn { padding: 6px 10px; font-size: 1.1em; line-height: 1; }
		.kebab-menu { position: absolute; right: 0; top: calc(100% + 4px); background: var(--ds-surface-2); border: 1px solid var(--ds-border); border-radius: var(--ds-radius-md); z-index: 60; display: flex; flex-direction: column; min-width: 150px; overflow: hidden; box-shadow: 0 8px 20px rgba(0,0,0,0.2); }
		.kebab-menu[hidden] { display: none; }
		.section-label { color: var(--ds-text-muted); font-size: var(--ds-font-md); margin: var(--ds-space-4) 0 var(--ds-space-1); }
		.kebab-menu button { all: unset; box-sizing: border-box; cursor: pointer; padding: 11px 14px; font-size: var(--ds-font-base); font-family: inherit; color: var(--ds-text); white-space: nowrap; min-height: var(--ds-tap-min); display: flex; align-items: center; }
		.kebab-menu button:hover, .kebab-menu button:focus { background: var(--ds-surface-hover); }
		.kebab-menu button.danger { color: var(--ds-danger); }
		.kebab-menu-label { padding: 8px 14px 2px; font-size: var(--ds-font-xs); color: var(--ds-text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
		.rename-input { font-family: inherit; font-size: inherit; background: var(--ds-surface-2); color: var(--ds-text); border: 1px solid var(--ds-accent); padding: 3px 6px; border-radius: 3px; min-width: 200px; }
		.row-select { margin-right: var(--ds-space-1); flex-shrink: 0; width: 18px; height: 18px; visibility: hidden; }
		body.select-mode-main .dash-main .row-select { visibility: visible; }
		body.select-mode-modal #others-list .row-select { visibility: visible; }
		body.select-mode-archived #archived-list .row-select { visibility: visible; }
		.archived-section { margin-top: var(--ds-space-4); border-top: 1px solid var(--ds-border); padding-top: var(--ds-space-2); }
		.archived-section summary { cursor: pointer; color: var(--ds-text-muted); font-size: var(--ds-font-md); padding: var(--ds-space-2) 0; list-style-position: outside; }
		.archived-controls { display: flex; align-items: center; min-height: 34px; }
		.row-btn { font-family: inherit; font-size: var(--ds-font-base); background: transparent; color: var(--ds-text-muted); border: 1px solid var(--ds-border); padding: 6px 12px; border-radius: var(--ds-radius-sm); cursor: pointer; white-space: nowrap; flex-shrink: 0; min-height: 34px; text-decoration: none; display: inline-flex; align-items: center; transition: background-color 0.12s ease, color 0.12s ease; }
		.row-btn:hover { background: var(--ds-surface-hover); color: var(--ds-text); }
		.row-btn.primary { background: var(--ds-accent); border-color: var(--ds-accent); color: var(--ds-accent-fg); font-weight: 600; }
		.row-btn.primary:hover { background: var(--ds-accent-hover); border-color: var(--ds-accent-hover); color: var(--ds-accent-fg); }
		.row-btn.danger { color: var(--ds-danger); }
		.row-btn.active { color: var(--ds-warning); }
		.row-btn:disabled { opacity: 0.4; cursor: default; }
		.row-btn:disabled:hover { background: transparent; }
		.select-trigger { background: none; border: none; color: var(--ds-text-muted); font-family: inherit; font-size: var(--ds-font-base); cursor: pointer; padding: 6px 4px; }
		.select-trigger:hover { color: var(--ds-text); }
		.spawn-form button[type="submit"], .ns-bar button:not(.select-trigger) { font-family: inherit; font-size: var(--ds-font-base); cursor: pointer; border-radius: var(--ds-radius-sm); }
		.spawn-form button[type="submit"], #ns-create-form button:first-of-type { background: var(--ds-accent); color: var(--ds-accent-fg); border: 1px solid var(--ds-accent); padding: 8px 14px; font-weight: 600; }
		.spawn-form button[type="submit"]:hover, #ns-create-form button:first-of-type:hover { background: var(--ds-accent-hover); border-color: var(--ds-accent-hover); }
		.ns-bar button:disabled { opacity: 0.4; cursor: default; }
		#ns-delete-btn, #ns-create-form button:last-of-type { background: transparent; color: var(--ds-text-muted); border: 1px solid var(--ds-border); padding: 6px 10px; font-weight: 400; }
		#ns-delete-btn:not(:disabled):hover, #ns-create-form button:last-of-type:hover { background: var(--ds-surface-hover); color: var(--ds-text); }
		.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 40; display: flex; align-items: flex-start; justify-content: center; padding: 5vh 16px; }
		.modal-panel { background: var(--ds-bg); border: 1px solid var(--ds-border); border-radius: var(--ds-radius-lg); width: 100%; max-width: 780px; max-height: 88vh; overflow-y: auto; padding: var(--ds-space-2) var(--ds-space-5) var(--ds-space-5); box-shadow: 0 12px 32px rgba(0,0,0,0.2); }
		.modal-panel .sessions-header { margin-top: var(--ds-space-2); position: sticky; top: 0; background: var(--ds-bg); z-index: 2; padding-top: var(--ds-space-2); }
		.pagination { display: flex; align-items: center; justify-content: center; gap: var(--ds-space-3); padding: var(--ds-space-3) 0; font-size: var(--ds-font-sm); }
		@media (max-width: 900px) {
			.dash-columns { flex-direction: column-reverse; gap: var(--ds-space-6); }
			.dash-side { flex: none; width: 100%; }
			.spawn-form { padding: 0 0 var(--ds-space-5); border-left: 0; border-bottom: 1px solid var(--ds-border); }
		}
		@media (max-width: 640px) {
			.modal-overlay { padding: 0; align-items: stretch; }
			.modal-panel { max-width: none; width: 100%; max-height: none; height: 100%; border-radius: 0; padding: 0 var(--ds-space-4) calc(var(--ds-space-4) + env(safe-area-inset-bottom)); }
			.modal-panel .sessions-header { padding-top: calc(var(--ds-space-3) + env(safe-area-inset-top)); }
			.session-row { align-items: flex-start; flex-wrap: wrap; }
			.session-main { flex-wrap: wrap; width: calc(100% - 46px); }
			.session-main .meta { flex-basis: 100%; }
			.session-actions { margin-left: auto; }
			.session-actions .row-btn { min-height: var(--ds-tap-min); }
			.kebab-wrap { margin-left: auto; }
			.header-right { gap: var(--ds-space-1); }
			.ns-bar { font-size: var(--ds-font-xs); }
			.ns-bar input[type="text"] { width: 130px; }
			.suggest-list { max-width: none; }
		}
	</style>
</head>
<body>
	<div class="page-top">
		<h1>pi</h1>
		<nav class="page-nav">
			<a href="/" class="page-nav-link active">Dashboard</a>
			<a href="/settings" class="page-nav-link">Settings</a>
			${DASHBOARD_THEME_TOGGLE}
		</nav>
	</div>
	<main class="page-content">
	<div class="ns-bar" id="ns-bar" style="display:none">
		<label for="ns-select" id="ns-label">Namespace</label>
		<select id="ns-select" onchange="onNamespaceSwitch()"></select>
		<button type="button" id="ns-delete-btn" onclick="deleteNamespacePrompt()">Delete namespace…</button>
		<button type="button" class="select-trigger" id="ns-create-link" style="display:none" onclick="showCreateNamespace()">+ New namespace…</button>
		<span id="ns-create-form" style="display:none">
			<input type="text" id="ns-create-input" placeholder="new-namespace" maxlength="32" autocomplete="off"/>
			<button type="button" onclick="submitCreateNamespace()">Create</button>
			<button type="button" onclick="hideCreateNamespace()">Cancel</button>
			<span class="meta error" id="ns-create-error"></span>
		</span>
	</div>
	<div class="dash-columns">
	<div class="dash-main">
	<div class="sessions-header">
		<h2>Active sessions</h2>
		<div class="header-right" id="sessions-header-normal">
			<button class="select-trigger" id="all-sessions-btn" onclick="toggleAllSessions(true)">Inactive sessions</button>
			<button class="select-trigger" id="select-mode-btn" onclick="toggleSelectMode('main')">Select</button>
		</div>
		<div class="header-right" id="bulk-toolbar" style="display:none">
			<span><span class="bulk-count">0</span> selected</span>
			<button class="row-btn select-all-btn" onclick="toggleSelectAll()">Select all</button>
			<button class="row-btn" onclick="bulkArchive()">Archive</button>
			<button class="row-btn danger" onclick="bulkDelete()">Delete</button>
			<button class="row-btn" onclick="toggleSelectMode('main')">Cancel</button>
		</div>
	</div>
	<div id="session-list" class="session-list"><span class="meta">Loading...</span></div>
	</div>
	<div class="dash-side">
	<div class="spawn-form">
		<h2>New session</h2>
		<form method="POST" action="/api/spawn" onsubmit="spawnSession(event)">
			<label>Working directory<br>
				<div class="dir-suggest" id="cwd-suggest">
					<input type="text" name="cwd" id="spawn-cwd" placeholder="/path/to/project" autocomplete="off" value="${escapeHtml(getDashboardSettings().defaultCwd ?? "")}" required/>
					<div class="suggest-list" id="cwd-suggest-list" style="display:none"></div>
				</div>
			</label>
			<label id="spawn-namespace-wrap" style="display:none">Namespace<br>
				<select name="namespace" id="spawn-namespace"></select>
			</label>
			<div class="spawn-actions">
				<button type="submit" class="primary-btn">Spawn</button>
				<label class="spawn-check" title="Create the directory if it doesn't exist"><input type="checkbox" name="mkdir" id="spawn-mkdir"/> Create if missing</label>
			</div>
		</form>
		<div class="spawn-result" id="spawn-result"></div>
	</div>
	</div>
	</div>
	<div class="modal-overlay" id="all-sessions-modal" style="display:none">
		<div class="modal-panel">
			<div class="sessions-header">
				<h2>Inactive sessions</h2>
				<div class="header-right" id="modal-header-normal">
					<button class="select-trigger" onclick="toggleSelectMode('modal')">Select</button>
				</div>
				<div class="header-right" id="bulk-toolbar-modal" style="display:none">
					<span><span class="bulk-count">0</span> selected</span>
					<button class="row-btn select-all-btn" onclick="toggleSelectAll()">Select all</button>
					<button class="row-btn" onclick="bulkArchive()">Archive</button>
					<button class="row-btn danger" onclick="bulkDelete()">Delete</button>
					<button class="row-btn" onclick="toggleSelectMode('modal')">Cancel</button>
				</div>
				<button class="row-btn" onclick="toggleAllSessions(false)" aria-label="Close">&#10005;</button>
			</div>
			<div id="others-list" class="session-list" style="min-height:0"><span class="meta">No inactive sessions</span></div>
			<div class="pagination" id="pagination" style="display:none">
				<button class="row-btn" id="page-prev" onclick="changePage(-1)">&larr; Prev</button>
				<span class="meta" id="page-indicator"></span>
				<button class="row-btn" id="page-next" onclick="changePage(1)">Next &rarr;</button>
			</div>
			<details class="archived-section" id="archived-section" style="display:none">
				<summary>Archived (<span id="archived-count">0</span>)</summary>
				<div class="archived-controls">
					<div class="header-right" id="archived-header-normal">
						<button class="select-trigger" onclick="toggleSelectMode('archived')">Select</button>
					</div>
					<div class="header-right" id="bulk-toolbar-archived" style="display:none">
						<span><span class="bulk-count">0</span> selected</span>
						<button class="row-btn select-all-btn" onclick="toggleSelectAll()">Select all</button>
						<button class="row-btn" onclick="bulkUnarchive()">Unarchive</button>
						<button class="row-btn danger" onclick="bulkDelete()">Delete</button>
						<button class="row-btn" onclick="toggleSelectMode('archived')">Cancel</button>
					</div>
				</div>
				<div id="archived-list" class="session-list"></div>
			</details>
		</div>
	</div>
	</main>
	<script>
		if ("serviceWorker" in navigator) {
			window.addEventListener("load", function() {
				navigator.serviceWorker.register("/pwa-sw.js", { scope: "/" }).catch(function() {
					// Service workers are unavailable on insecure non-local origins and in some embedded browsers.
				});
			});
		}

		async function spawnSession(event) {
			event.preventDefault();
			const resultEl = document.getElementById("spawn-result");
			const formData = new FormData(event.target);
			const cwdValue = (formData.get("cwd") || "").toString().trim();
			if (!cwdValue) {
				resultEl.textContent = "Error: a working directory is required";
				resultEl.className = "spawn-result error";
				return;
			}
			resultEl.textContent = "Spawning…";
			resultEl.className = "spawn-result";
			try {
				const namespaceSelect = document.getElementById("spawn-namespace");
				const res = await fetch("/api/spawn", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						cwd: cwdValue,
						createDir: formData.get("mkdir") === "on",
						namespace: namespaceSelect ? namespaceSelect.value : undefined,
					}),
				});
				const data = await res.json();
				if (data.ok && data.instance) {
					resultEl.textContent = "Spawned! Opening…";
					resultEl.className = "spawn-result success";
					window.location.href = "/i/" + data.instance.id + "/";
				} else {
					resultEl.textContent = "Error: " + (data.error || "unknown");
					resultEl.className = "spawn-result error";
				}
			} catch (error) {
				resultEl.textContent = "Error: " + error.message;
				resultEl.className = "spawn-result error";
			}
		}
	function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

	// Account namespaces (see namespaces.ts): separate provider credentials +
	// sessions per local "account". "all" is a client-side filter value, never
	// sent to the server. Selection persists in localStorage across reloads.
	var allNamespaces = ["default"];
	var currentNamespace = localStorage.getItem("pi-dashboard-namespace") || "all";

	async function loadNamespaces() {
		try {
			var res = await fetch("/api/namespaces");
			var data = await res.json();
			if (data.ok && Array.isArray(data.namespaces)) {
				allNamespaces = data.namespaces.map(function(n) { return n.name; });
			}
		} catch (_err) {
			// Best-effort: fall back to just "default".
		}
		// The stored namespace may no longer exist (e.g. deleted from another tab):
		// reconcile against the live list instead of leaving currentNamespace pointing
		// at a name the <select> can no longer render (it would silently fall back to
		// showing "All namespaces" while currentNamespace/loadSessions still filtered
		// by the stale deleted name).
		if (currentNamespace !== "all" && allNamespaces.indexOf(currentNamespace) === -1) {
			currentNamespace = "all";
			localStorage.setItem("pi-dashboard-namespace", currentNamespace);
		}
		renderNamespaceSwitcher();
		renderSpawnNamespaceSelect();
	}

	function renderNamespaceSwitcher() {
		// Only default namespace exists: collapse the bar to a single low-key
		// "+ New namespace" link. Hiding it entirely (an earlier iteration) made
		// creating the FIRST extra namespace impossible, since the switcher's own
		// "+ New namespace" option and the spawn-form select were both hidden too.
		var bar = document.getElementById("ns-bar");
		var onlyDefault = allNamespaces.length <= 1;
		bar.style.display = "";
		document.getElementById("ns-label").style.display = onlyDefault ? "none" : "";
		document.getElementById("ns-select").style.display = onlyDefault ? "none" : "";
		document.getElementById("ns-delete-btn").style.display = onlyDefault ? "none" : "";
		document.getElementById("ns-create-link").style.display = onlyDefault ? "" : "none";
		if (onlyDefault) return;
		var sel = document.getElementById("ns-select");
		var options = ["all"].concat(allNamespaces);
		sel.innerHTML = options.map(function(n) {
			return '<option value="' + esc(n) + '"' + (n === currentNamespace ? " selected" : "") + '>' + (n === "all" ? "All namespaces" : esc(n)) + '</option>';
		}).join("") + '<option value="__new__">+ New namespace\u2026</option>';
		var deleteBtn = document.getElementById("ns-delete-btn");
		deleteBtn.disabled = currentNamespace === "all" || currentNamespace === "default";
	}

	async function deleteNamespacePrompt() {
		if (currentNamespace === "all" || currentNamespace === "default") return;
		var name = currentNamespace;
		if (!window.confirm('Delete namespace "' + name + '"? This only removes it from the switcher; it never touches its credentials or session files.')) return;
		try {
			var res = await fetch("/api/namespaces/delete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: name }),
			});
			var data = await res.json();
			if (!data.ok) { window.alert("Failed to delete namespace: " + (data.error || "unknown")); return; }
			allNamespaces = allNamespaces.filter(function(n) { return n !== name; });
			currentNamespace = "all";
			localStorage.setItem("pi-dashboard-namespace", currentNamespace);
			renderNamespaceSwitcher();
			renderSpawnNamespaceSelect();
			loadSessions();
		} catch (error) {
			window.alert("Failed to delete namespace: " + error.message);
		}
	}

	// Inline creation form instead of window.prompt: installed PWAs and some
	// mobile webviews silently suppress prompt/alert, which made the create
	// button appear to do nothing.
	function showCreateNamespace() {
		document.getElementById("ns-create-form").style.display = "";
		document.getElementById("ns-create-link").style.display = "none";
		document.getElementById("ns-create-error").textContent = "";
		var input = document.getElementById("ns-create-input");
		input.value = "";
		input.focus();
	}

	function hideCreateNamespace() {
		document.getElementById("ns-create-form").style.display = "none";
		renderNamespaceSwitcher();
	}

	async function submitCreateNamespace() {
		var input = document.getElementById("ns-create-input");
		var errorEl = document.getElementById("ns-create-error");
		var name = input.value.trim();
		if (!name) { errorEl.textContent = "name required"; return; }
		if (!/^[a-z0-9-_]{1,32}$/.test(name)) { errorEl.textContent = "lowercase letters, digits, - or _ only"; return; }
		try {
			var res = await fetch("/api/namespaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: name }),
			});
			var data = await res.json();
			if (!data.ok) { errorEl.textContent = data.error || "failed"; return; }
			if (allNamespaces.indexOf(name) === -1) allNamespaces.push(name);
			currentNamespace = name;
			localStorage.setItem("pi-dashboard-namespace", currentNamespace);
			document.getElementById("ns-create-form").style.display = "none";
			renderNamespaceSwitcher();
			renderSpawnNamespaceSelect();
			loadSessions();
		} catch (error) {
			errorEl.textContent = error.message;
		}
	}

	document.getElementById("ns-create-input").addEventListener("keydown", function(e) {
		if (e.key === "Enter") { e.preventDefault(); submitCreateNamespace(); }
		if (e.key === "Escape") hideCreateNamespace();
	});

	function onNamespaceSwitch() {
		var sel = document.getElementById("ns-select");
		var value = sel.value;
		if (value === "__new__") {
			renderNamespaceSwitcher();
			showCreateNamespace();
			return;
		}
		currentNamespace = value;
		localStorage.setItem("pi-dashboard-namespace", currentNamespace);
		renderSpawnNamespaceSelect();
		loadSessions();
	}



	function renderSpawnNamespaceSelect() {
		var wrap = document.getElementById("spawn-namespace-wrap");
		var sel = document.getElementById("spawn-namespace");
		if (allNamespaces.length <= 1) {
			wrap.style.display = "none";
			sel.innerHTML = '<option value="default">default</option>';
			return;
		}
		wrap.style.display = "";
		var current = currentNamespace === "all" ? "default" : currentNamespace;
		sel.innerHTML = allNamespaces.map(function(n) {
			return '<option value="' + esc(n) + '"' + (n === current ? " selected" : "") + '>' + esc(n) + '</option>';
		}).join("") + '<option value="__new__">+ New namespace\u2026</option>';
	}

	document.getElementById("spawn-namespace").addEventListener("change", function() {
		var sel = this;
		if (sel.value !== "__new__") return;
		// Reset to a real value and open the dialog-free inline creator up top.
		renderSpawnNamespaceSelect();
		showCreateNamespace();
	});

	// Working-directory autocomplete: a small debounced dropdown backed by
	// GET /api/fs/dirs, since <datalist> styling/behavior is inconsistent across
	// mobile browsers and this keeps the same dark-theme look as the rest of the page.
	// (Shared with the settings page's default-cwd field; see dirSuggestScript in web.ts.)
	${dirSuggestScript("spawn-cwd", "cwd-suggest-list")}

	function statusLabel(s) {
		if (s.status === "online" || s.status === "starting") return "live";
		if (s.status === "stopping") return "stopping";
		if (s.status === "error") return "error";
		if (s.status === "past") return "past";
		return "stopped";
	}

	// Bulk selection (archive/delete). Pin/unpin stays per-row only. Checkboxes are
	// hidden (visibility, not display) until the user enters select mode via the
	// Select trigger.
	// key -> { id, path, cwd } so bulk actions can act on selections that are not
	// currently rendered (e.g. "Select all" spanning every page of the modal).
	var selectedKeys = {};
	// Which list is in select mode: null, "main" (active/pinned) or "modal"
	// (inactive sessions). The two selections are independent.
	var selectScope = null;
	function rowKey(s) { return s.id ? ("id:" + s.id) : ("path:" + s.sessionFile); }
	function scopeRoot() {
		if (selectScope === "modal") return document.getElementById("others-list");
		if (selectScope === "archived") return document.getElementById("archived-list");
		return document.getElementById("session-list");
	}

	// Pagination: only the active (non-pinned-first-sorted, non-archived) list is
	// paged. Archived stays in its collapsed <details>, unpaginated. Slicing
	// happens client-side against the already-sorted list from the server, so
	// "Select all" (which only walks rendered .row-select checkboxes) naturally
	// selects just the current page.
	var PAGE_SIZE = 10;
	var currentPage = 1;
	var lastOtherSessions = [];
	var lastArchivedSessions = [];

	// The normal header (title + Select trigger) and the bulk toolbar occupy the
	// same fixed-height slot (see .sessions-header), so entering/leaving select
	// mode swaps their visibility in place instead of adding/removing a row.
	function updateBulkToolbar() {
		var n = Object.keys(selectedKeys).length;
		document.querySelectorAll(".bulk-count").forEach(function(el) { el.textContent = n; });
		document.querySelectorAll(".select-all-btn").forEach(function(el) { el.textContent = n > 0 ? "Deselect all" : "Select all"; });
		document.getElementById("sessions-header-normal").style.display = selectScope === "main" ? "none" : "";
		document.getElementById("bulk-toolbar").style.display = selectScope === "main" ? "" : "none";
		document.getElementById("modal-header-normal").style.display = selectScope === "modal" ? "none" : "";
		document.getElementById("bulk-toolbar-modal").style.display = selectScope === "modal" ? "" : "none";
		document.getElementById("archived-header-normal").style.display = selectScope === "archived" ? "none" : "";
		document.getElementById("bulk-toolbar-archived").style.display = selectScope === "archived" ? "" : "none";
	}

	function toggleSelectMode(scope) {
		clearSelection();
		selectScope = selectScope === scope ? null : scope;
		document.body.classList.toggle("select-mode-main", selectScope === "main");
		document.body.classList.toggle("select-mode-modal", selectScope === "modal");
		document.body.classList.toggle("select-mode-archived", selectScope === "archived");
		updateBulkToolbar();
	}

	function toggleAllSessions(open) {
		closeAllKebabMenus();
		// Leaving the modal always exits its select modes so selections can't act invisibly.
		if (!open && (selectScope === "modal" || selectScope === "archived")) toggleSelectMode(selectScope);
		document.getElementById("all-sessions-modal").style.display = open ? "" : "none";
		// Lock page scroll while the modal (a full-height sheet on mobile) is open.
		document.body.style.overflow = open ? "hidden" : "";
	}
	document.getElementById("all-sessions-modal").addEventListener("click", function(e) {
		if (e.target === e.currentTarget) toggleAllSessions(false);
	});

	// Select all when nothing is selected; deselect all otherwise.
	function toggleSelectAll() {
		if (Object.keys(selectedKeys).length > 0) { clearSelection(); return; }
		selectAllSessions();
	}

	// Only iterates rendered checkboxes, i.e. the current page: selecting "all"
	// selects what's visible, not the entire (possibly multi-page) session list.
	function sessionPayload(s) { return { id: s.id || undefined, path: s.sessionFile || undefined, cwd: s.cwd || undefined, namespace: s.namespace || undefined }; }
	function rowPayload(row) {
		return {
			id: row.getAttribute("data-id") || undefined,
			path: row.getAttribute("data-path") || undefined,
			cwd: row.getAttribute("data-cwd") || undefined,
			namespace: row.getAttribute("data-namespace") || undefined,
		};
	}

	function selectAllSessions() {
		if (selectScope === "modal") {
			// All inactive sessions across every page, not just the rendered one.
			lastOtherSessions.forEach(function(s) { selectedKeys[rowKey(s)] = sessionPayload(s); });
		}
		if (selectScope === "archived") {
			lastArchivedSessions.forEach(function(s) { selectedKeys[rowKey(s)] = sessionPayload(s); });
		}
		scopeRoot().querySelectorAll(".row-select").forEach(function(cb) {
			cb.checked = true;
			var row = cb.closest(".session-row");
			selectedKeys[cb.getAttribute("data-key")] = rowPayload(row);
		});
		updateBulkToolbar();
	}

	function clearSelection() {
		selectedKeys = {};
		document.querySelectorAll(".row-select").forEach(function(cb) { cb.checked = false; });
		updateBulkToolbar();
	}

	function selectedPayloads() {
		return Object.keys(selectedKeys).map(function(key) { return selectedKeys[key]; });
	}

	async function bulkArchive() {
		var items = selectedPayloads();
		if (items.length === 0) return;
		if (!window.confirm("Archive " + items.length + " selected session(s)?")) return;
		await Promise.all(items.map(function(item) {
			return fetch("/api/sessions/archive", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: item.id, path: item.path, cwd: item.cwd, namespace: item.namespace, archived: true }),
			});
		}));
		clearSelection();
		loadSessions();
	}

	async function bulkUnarchive() {
		var items = selectedPayloads();
		if (items.length === 0) return;
		await Promise.all(items.map(function(item) {
			return fetch("/api/sessions/archive", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: item.id, path: item.path, cwd: item.cwd, namespace: item.namespace, archived: false }),
			});
		}));
		clearSelection();
		loadSessions();
	}

	async function bulkDelete() {
		var items = selectedPayloads();
		if (items.length === 0) return;
		if (!window.confirm("Delete " + items.length + " selected session(s)? This removes their session files and cannot be undone.")) return;
		await Promise.all(items.map(function(item) {
			return fetch("/api/sessions/delete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: item.id, path: item.path, namespace: item.namespace }),
			});
		}));
		clearSelection();
		loadSessions();
	}

	// Per-row actions: only the name, status, and the primary Open/Resume action
	// are always visible. Rename/Pin/Archive/Delete live in a kebab ("...") menu
	// so the row stays compact; see attachRowHandlers for the open/close wiring.
	function sessionRowHtml(s) {
		var isLive = s.status === "online" || s.status === "starting";
		var badge = '<span class="badge badge-' + statusLabel(s) + '">' + statusLabel(s) + '</span>';
		var namespace = s.namespace || "default";
		// Only tagged when non-default: default is the implicit, unlabeled namespace.
		var nsTag = namespace !== "default" ? '<span class="badge ns-tag">' + esc(namespace) + '</span>' : "";
		// Pinned is shown as an icon in front of the name rather than yet another text badge.
		var pinIcon = s.pinned
			? '<span class="pin-icon" title="Pinned"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1.5l5 5-1.2 1.2-.9-.3-2.6 2.6.3 2.4-1.2 1.2-2.6-2.6-3.8 3.8-.7-.7 3.8-3.8L3 7.7l1.2-1.2 2.4.3 2.6-2.6-.3-.9 1.2-1.2z"/></svg></span>'
			: "";
		var openBtn = isLive
			? '<a class="row-btn primary" href="/i/' + esc(s.id) + '/">Open</a>'
			: (s.sessionFile ? '<button class="row-btn primary" data-action="resume">Resume</button>' : "");
		var key = rowKey(s);
		var checked = selectedKeys[key] ? " checked" : "";
		return '' +
			'<div class="session-row" data-id="' + esc(s.id || "") + '" data-path="' + esc(s.sessionFile || "") + '" data-cwd="' + esc(s.cwd || "") + '" data-pinned="' + (s.pinned ? "true" : "false") + '" data-archived="' + (s.archived ? "true" : "false") + '" data-namespace="' + esc(namespace) + '">' +
				'<input type="checkbox" class="row-select" data-key="' + esc(key) + '"' + checked + ' />' +
				'<div class="session-main">' +
					pinIcon +
					'<span class="session-name" data-role="name">' + esc(s.name) + '</span>' +
					badge +
					nsTag +
					'<span class="meta">' + esc(s.cwd) + '</span>' +
				'</div>' +
				'<div class="session-actions">' +
					openBtn +
					'<div class="kebab-wrap">' +
						'<button class="row-btn kebab-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="More actions">&#8942;</button>' +
						'<div class="kebab-menu" hidden>' +
							'<button type="button" data-action="rename">Rename</button>' +
							'<button type="button" data-action="pin">' + (s.pinned ? "Unpin" : "Pin") + '</button>' +
							'<button type="button" data-action="archive">' + (s.archived ? "Unarchive" : "Archive") + '</button>' +
							'<button type="button" data-action="move">Move to namespace\u2026</button>' +
							'<button type="button" class="danger" data-action="delete">Delete</button>' +
						'</div>' +
					'</div>' +
				'</div>' +
			'</div>';
	}

	// Only one kebab menu open at a time; closes on outside click or Escape.
	function closeAllKebabMenus() {
		document.querySelectorAll(".kebab-menu").forEach(function(menu) {
			// The "Move to…" submenu is created fresh on each use (see action === "move")
			// and marked transient; removing it (instead of just hiding it, like the
			// row's own permanent kebab-menu) avoids leaking an orphaned DOM node every
			// time it is dismissed without completing a move.
			if (menu.dataset.transient === "true") { menu.remove(); return; }
			menu.hidden = true;
			var btn = menu.previousElementSibling;
			if (btn) btn.setAttribute("aria-expanded", "false");
		});
	}
	document.addEventListener("click", function(e) {
		if (!e.target.closest(".kebab-wrap")) closeAllKebabMenus();
	});
	// A fixed-position menu would float detached from its row once anything scrolls.
	document.addEventListener("scroll", closeAllKebabMenus, true);
	document.addEventListener("keydown", function(e) {
		if (e.key === "Escape") {
			closeAllKebabMenus();
			toggleAllSessions(false);
		}
	});

	function attachRowHandlers(container) {
		container.querySelectorAll(".session-row").forEach(function(row) {
			row.querySelectorAll("[data-action]").forEach(function(btn) {
				btn.onclick = function() {
					closeAllKebabMenus();
					handleSessionAction(row, btn.getAttribute("data-action"));
				};
			});
			var kebabBtn = row.querySelector(".kebab-btn");
			if (kebabBtn) {
				kebabBtn.onclick = function(e) {
					e.stopPropagation();
					var menu = kebabBtn.nextElementSibling;
					var wasOpen = !menu.hidden;
					closeAllKebabMenus();
					menu.hidden = wasOpen;
					kebabBtn.setAttribute("aria-expanded", wasOpen ? "false" : "true");
					if (!wasOpen) {
						// Fixed positioning escapes scroll/overflow clipping (e.g. inside the
						// inactive-sessions modal panel).
						var rect = kebabBtn.getBoundingClientRect();
						menu.style.position = "fixed";
						menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + "px";
						menu.style.left = Math.max(8, rect.right - menu.offsetWidth) + "px";
						menu.style.right = "auto";
					}
				};
			}
		});
		container.querySelectorAll(".row-select").forEach(function(cb) {
			cb.onchange = function() {
				var key = cb.getAttribute("data-key");
				if (cb.checked) selectedKeys[key] = rowPayload(cb.closest(".session-row")); else delete selectedKeys[key];
				updateBulkToolbar();
			};
		});
	}

	async function loadSessions() {
		var list = document.getElementById("session-list");
		var archivedSection = document.getElementById("archived-section");
		var archivedList = document.getElementById("archived-list");
		var archivedCount = document.getElementById("archived-count");
		try {
			var res = await fetch("/api/dashboard-sessions");
			var data = await res.json();
			if (!data.ok || !data.sessions) {
				list.innerHTML = '<span class="meta error">Failed to load sessions</span>';
				return;
			}
			var allSessions = currentNamespace === "all"
				? data.sessions
				: data.sessions.filter(function(s) { return (s.namespace || "default") === currentNamespace; });
			data = { ok: true, sessions: allSessions };
			var archived = data.sessions.filter(function(s) { return s.archived; });
			// Two sections: live and pinned sessions always visible up top, everything
			// else ("Other sessions") below, paginated. Server order (pinned-first,
			// then last-accessed) is preserved within each section.
			var activePinned = data.sessions.filter(function(s) {
				return !s.archived && (s.pinned || s.status === "online" || s.status === "starting");
			});
			var others = data.sessions.filter(function(s) {
				return !s.archived && !s.pinned && s.status !== "online" && s.status !== "starting";
			});

			// Drop selections for sessions no longer in the response (e.g. deleted).
			var liveKeys = {};
			data.sessions.forEach(function(s) { liveKeys[rowKey(s)] = true; });
			Object.keys(selectedKeys).forEach(function(key) { if (!liveKeys[key]) delete selectedKeys[key]; });

			list.innerHTML = activePinned.length === 0
				? (others.length === 0 ? '<span class="meta">No sessions yet</span>' : '<span class="meta">No active sessions</span>')
				: activePinned.map(sessionRowHtml).join("");
			attachRowHandlers(list);

			lastOtherSessions = others;
			renderPage();

			var hiddenCount = others.length + archived.length;
			document.getElementById("all-sessions-btn").textContent =
				hiddenCount > 0 ? "Inactive sessions (" + hiddenCount + ")" : "Inactive sessions";

			archivedCount.textContent = archived.length;
			archivedSection.style.display = archived.length === 0 ? "none" : "";
			lastArchivedSessions = archived;
			archivedList.innerHTML = archived.map(sessionRowHtml).join("");
			attachRowHandlers(archivedList);
			updateBulkToolbar();
		} catch (_err) {
			list.innerHTML = '<span class="meta error">Failed to load sessions</span>';
		}
	}

	function renderPage() {
		var list = document.getElementById("others-list");
		var pagination = document.getElementById("pagination");
		var totalPages = Math.max(1, Math.ceil(lastOtherSessions.length / PAGE_SIZE));
		if (currentPage > totalPages) currentPage = totalPages;
		if (currentPage < 1) currentPage = 1;
		var start = (currentPage - 1) * PAGE_SIZE;
		var pageItems = lastOtherSessions.slice(start, start + PAGE_SIZE);

		list.innerHTML = pageItems.length === 0 ? '<span class="meta">No inactive sessions</span>' : pageItems.map(sessionRowHtml).join("");
		attachRowHandlers(list);

		if (lastOtherSessions.length > PAGE_SIZE) {
			pagination.style.display = "";
			document.getElementById("page-indicator").textContent = "Page " + currentPage + " of " + totalPages + " (" + lastOtherSessions.length + ")";
			document.getElementById("page-prev").disabled = currentPage <= 1;
			document.getElementById("page-next").disabled = currentPage >= totalPages;
		} else {
			pagination.style.display = "none";
		}
	}

	function changePage(delta) {
		currentPage += delta;
		renderPage();
	}

	async function handleSessionAction(row, action) {
		var id = row.getAttribute("data-id") || undefined;
		var sessionPath = row.getAttribute("data-path") || undefined;
		var cwd = row.getAttribute("data-cwd") || undefined;
		var pinned = row.getAttribute("data-pinned") === "true";
		var archived = row.getAttribute("data-archived") === "true";
		var namespace = row.getAttribute("data-namespace") || "default";
		var resultEl = document.getElementById("spawn-result");

		if (action === "resume") {
			resultEl.textContent = "Resuming..."; resultEl.className = "spawn-result";
			try {
				var res = await fetch("/api/spawn", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ cwd: cwd, sessionFile: sessionPath, namespace: namespace }),
				});
				var data = await res.json();
				if (data.ok && data.instance) {
					resultEl.textContent = "Resumed! Opening..."; resultEl.className = "spawn-result success";
					window.location.href = "/i/" + data.instance.id + "/";
				} else {
					resultEl.textContent = "Error: " + (data.error || "unknown"); resultEl.className = "spawn-result error";
				}
			} catch (error) {
				resultEl.textContent = "Error: " + error.message; resultEl.className = "spawn-result error";
			}
			return;
		}

		if (action === "rename") {
			// Inline edit instead of window.prompt (suppressed in installed PWAs).
			var nameEl = row.querySelector('[data-role="name"]');
			var currentName = nameEl.textContent;
			var editor = document.createElement("input");
			editor.type = "text";
			editor.className = "rename-input";
			editor.value = currentName;
			nameEl.replaceWith(editor);
			editor.focus();
			editor.select();
			var done = false;
			var finish = async function(save) {
				if (done) return;
				done = true;
				var newName = editor.value.trim();
				if (save && newName && newName !== currentName) {
					var res = await fetch("/api/sessions/rename", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id: id, path: sessionPath, cwd: cwd, name: newName, namespace: namespace }),
					});
					var data = await res.json();
					if (!data.ok) console.error("Rename failed:", data.error);
				}
				loadSessions();
			};
			editor.addEventListener("keydown", function(e) {
				// Escape must not also bubble to the document-level handler, or canceling a
				// rename while the inactive-sessions modal is open (or select mode is on)
				// also closes the modal / exits select mode as an unwanted side effect.
				if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void finish(true); }
				if (e.key === "Escape") { e.stopPropagation(); void finish(false); }
			});
			editor.addEventListener("blur", function() { void finish(true); });
			return;
		}

		if (action === "pin") {
			var res = await fetch("/api/sessions/pin", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: id, path: sessionPath, cwd: cwd, pinned: !pinned, namespace: namespace }),
			});
			var data = await res.json();
			if (!data.ok) window.alert("Pin failed: " + (data.error || "unknown"));
			loadSessions();
			return;
		}

		if (action === "archive") {
			var res = await fetch("/api/sessions/archive", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: id, path: sessionPath, cwd: cwd, archived: !archived, namespace: namespace }),
			});
			var data = await res.json();
			if (!data.ok) window.alert("Archive failed: " + (data.error || "unknown"));
			loadSessions();
			return;
		}

		if (action === "move") {
			// Dialog-free namespace chooser: a kebab-style submenu at the row's kebab
			// button (window.prompt is suppressed in installed PWAs).
			var anchor = row.querySelector(".kebab-btn");
			var wrap = row.querySelector(".kebab-wrap");
			if (!anchor || !wrap) return;
			var targets = allNamespaces.filter(function(n) { return n !== namespace; });
			if (targets.length === 0) return;
			var menu = document.createElement("div");
			menu.className = "kebab-menu";
			menu.dataset.transient = "true";
			menu.innerHTML = '<div class="kebab-menu-label">Move to…</div>' + targets.map(function(n) {
				return '<button type="button" data-ns="' + esc(n) + '">' + esc(n) + '</button>';
			}).join("");
			wrap.appendChild(menu);
			var rect = anchor.getBoundingClientRect();
			menu.style.position = "fixed";
			menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 200) + "px";
			menu.style.left = Math.max(8, rect.right - 150) + "px";
			menu.style.right = "auto";
			menu.querySelectorAll("[data-ns]").forEach(function(btn) {
				btn.onclick = async function(e) {
					e.stopPropagation();
					menu.remove();
					var res = await fetch("/api/sessions/move", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id: id, path: sessionPath, cwd: cwd, namespace: btn.getAttribute("data-ns"), fromNamespace: namespace }),
					});
					var data = await res.json();
					if (!data.ok) console.error("Move failed:", data.error);
					loadSessions();
				};
			});
			return;
		}

		if (action === "delete") {
			var deleteName = row.querySelector('[data-role="name"]').textContent;
			if (!window.confirm('Delete "' + deleteName + '"? This removes the session file and cannot be undone.')) return;
			var res = await fetch("/api/sessions/delete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: id, path: sessionPath }),
			});
			var data = await res.json();
			if (!data.ok) window.alert("Delete failed: " + (data.error || "unknown"));
			loadSessions();
			return;
		}
	}

	loadNamespaces();
	loadSessions();

	// Auto-refresh so a session transitioning starting -> online, or another
	// tab/process spawning or stopping instances, shows up without a manual
	// action or full reload (matching the in-session pinned sidebar's 30s poll).
	// Skipped while a refresh would clobber in-progress UI state: select mode, an
	// inline rename in progress, an open kebab/move menu, or a hidden tab.
	setInterval(function() {
		if (document.hidden) return;
		if (selectScope !== null) return;
		if (document.querySelector(".rename-input")) return;
		if (document.querySelector(".kebab-menu:not([hidden])")) return;
		loadSessions();
	}, 10000);
	</script>
</body>
</html>`;
}

/**
 * Settings page: default working directory (prefills the dashboard's spawn
 * form) and text snippets (inserted into the chat composer via GET
 * /api/snippets). Same visual conventions as renderIndexPage.
 */
function renderSettingsPage(): string {
	return `<!doctype html>
<html lang="en" data-theme="light">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
	<meta name="theme-color" content="#ffffff" />
	<link rel="icon" href="/icons/pi.svg" type="image/svg+xml" />
	<title>pi settings</title>
	${CLIENT_THEME_BOOTSTRAP_SCRIPT}
	<style>
${DASHBOARD_BASE_CSS}
		.page-content { max-width: 760px; }
		.section { padding: var(--ds-space-5) 0; border-top: 1px solid var(--ds-border); }
		.section:first-child { padding-top: 0; border-top: 0; }
		.section h2 { font-size: var(--ds-font-md); margin: 0 0 var(--ds-space-1); }
		.section-hint { color: var(--ds-text-dim); font-size: var(--ds-font-sm); margin: 0 0 var(--ds-space-3); }
		label { display: block; margin: var(--ds-space-3) 0 0; font-size: var(--ds-font-sm); color: var(--ds-text-muted); }
		label:first-of-type { margin-top: 0; }
		button { font-family: inherit; font-size: var(--ds-font-base); }
		.section > .dir-suggest input, .snippet-row.editing input, .snippet-row.editing textarea, .snippet-add-form input, .snippet-add-form textarea { width: 100%; }
		.row-btn { font-family: inherit; font-size: var(--ds-font-base); background: transparent; color: var(--ds-text-muted); border: 1px solid var(--ds-border); padding: 6px 12px; border-radius: var(--ds-radius-sm); cursor: pointer; min-height: 34px; }
		.row-btn:hover { background: var(--ds-surface-hover); color: var(--ds-text); }
		.row-btn.danger { color: var(--ds-danger); }
		.actions { display: flex; align-items: center; gap: var(--ds-space-3); margin-top: var(--ds-space-3); flex-wrap: wrap; }
		.result { font-size: var(--ds-font-sm); }
		.result.error { color: var(--ds-danger); }
		.result.success { color: var(--ds-success); }
		.dir-suggest { position: relative; }
		.suggest-list { position: absolute; left: 0; right: 0; z-index: 5; background: var(--ds-surface-2); border: 1px solid var(--ds-border); border-top: none; border-radius: 0 0 var(--ds-radius-sm) var(--ds-radius-sm); max-height: 200px; overflow-y: auto; box-shadow: 0 8px 20px rgba(0,0,0,0.12); }
		.suggest-list div { padding: 8px 10px; font-size: var(--ds-font-sm); cursor: pointer; }
		.suggest-list div:hover { background: var(--ds-surface-hover); }
		#snippets-list { margin-top: var(--ds-space-2); border-top: 1px solid var(--ds-border); }
		#snippets-list > .meta:only-child { display: block; padding: var(--ds-space-4) 0; text-align: center; border-bottom: 1px solid var(--ds-border); }
		.snippet-row { display: flex; justify-content: space-between; align-items: center; gap: var(--ds-space-3); min-height: 52px; padding: 9px var(--ds-space-1); border-bottom: 1px solid var(--ds-border); }
		.snippet-row:hover:not(.editing) { background: var(--ds-surface); }
		.snippet-main { min-width: 0; flex: 1; }
		.snippet-name { font-size: var(--ds-font-md); font-weight: 600; }
		.snippet-preview { font-size: var(--ds-font-sm); color: var(--ds-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
		.snippet-actions { display: flex; gap: var(--ds-space-2); flex-shrink: 0; }
		.snippet-row.editing { flex-direction: column; align-items: stretch; width: 100%; padding: var(--ds-space-4) var(--ds-space-1); }
		.snippet-add-form { margin-top: var(--ds-space-5); }
		.snippet-add-form h3 { padding-top: var(--ds-space-1); }
		@media (max-width: 600px) {
			.snippet-row { align-items: flex-start; flex-wrap: wrap; }
			.snippet-main { width: 100%; flex-basis: 100%; }
			.snippet-actions { justify-content: flex-start; }
			.snippet-actions .row-btn { min-height: var(--ds-tap-min); }
		}
	</style>
</head>
<body>
	<div class="page-top">
		<h1>pi</h1>
		<nav class="page-nav">
			<a href="/" class="page-nav-link">Dashboard</a>
			<a href="/settings" class="page-nav-link active">Settings</a>
			${DASHBOARD_THEME_TOGGLE}
		</nav>
	</div>

	<main class="page-content">
	<div class="section">
		<h2>Default working directory</h2>
		<p class="section-hint">Prefills the dashboard's spawn form.</p>
		<div class="dir-suggest" id="cwd-suggest">
			<input type="text" id="settings-default-cwd" placeholder="/path/to/project" autocomplete="off" value="${escapeHtml(getDashboardSettings().defaultCwd ?? "")}" />
			<div class="suggest-list" id="settings-cwd-suggest-list" style="display:none"></div>
		</div>
		<div class="actions">
			<button type="button" class="primary-btn" onclick="saveDefaultCwd()">Save</button>
			<span class="result" id="cwd-result"></span>
		</div>
	</div>

	<div class="section">
		<h2>Snippets</h2>
		<p class="section-hint">Reusable text, inserted into the chat composer via the {} button.</p>
		<div id="snippets-list"><span class="meta">Loading…</span></div>
		<div class="snippet-add-form">
			<h3>Add snippet</h3>
			<label>Name<br><input type="text" id="snippet-name-input" maxlength="80" placeholder="Snippet name" /></label>
			<label>Text<br><textarea id="snippet-text-input" rows="4" placeholder="Snippet text"></textarea></label>
			<div class="actions">
				<button type="button" class="primary-btn" onclick="addSnippet()">Add</button>
				<span class="result" id="snippet-add-result"></span>
			</div>
		</div>
	</div>
	</main>

	<script>
		function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

		var settings = { snippets: [] };
		var editingId = null;
		var deleteArmedId = null;
		var deleteArmTimer;

		async function loadSettings() {
			try {
				var res = await fetch("/api/settings");
				var data = await res.json();
				if (!data.ok) throw new Error(data.error || "Failed to load settings");
				settings = data.settings;
				document.getElementById("settings-default-cwd").value = settings.defaultCwd || "";
				renderSnippets();
			} catch (error) {
				document.getElementById("snippets-list").innerHTML = '<span class="meta result error">Failed to load settings: ' + esc(error.message) + '</span>';
			}
		}

		function firstLine(text) {
			var line = (text.split("\\n")[0] || "").trim();
			return line.length > 140 ? line.slice(0, 140) + "\u2026" : line;
		}

		function renderSnippets() {
			var list = document.getElementById("snippets-list");
			var snippets = settings.snippets || [];
			if (snippets.length === 0) {
				list.innerHTML = '<span class="meta">No snippets yet</span>';
				return;
			}
			list.innerHTML = snippets.map(function(s) {
				if (editingId === s.id) {
					return '<div class="snippet-row editing" data-id="' + esc(s.id) + '">' +
						'<label>Name<br><input type="text" class="snippet-edit-name" maxlength="80" value="' + esc(s.name) + '" /></label>' +
						'<label>Text<br><textarea class="snippet-edit-text" rows="4">' + esc(s.text) + '</textarea></label>' +
						'<div class="actions">' +
							'<button type="button" class="primary-btn" onclick="saveSnippetEdit(' + JSON.stringify(s.id) + ')">Save</button>' +
							'<button type="button" class="row-btn" onclick="cancelSnippetEdit()">Cancel</button>' +
							'<span class="result" id="snippet-edit-result-' + esc(s.id) + '"></span>' +
						'</div>' +
					'</div>';
				}
				var armed = deleteArmedId === s.id;
				return '<div class="snippet-row" data-id="' + esc(s.id) + '">' +
					'<div class="snippet-main">' +
						'<div class="snippet-name">' + esc(s.name) + '</div>' +
						'<div class="snippet-preview">' + esc(firstLine(s.text)) + '</div>' +
					'</div>' +
					'<div class="snippet-actions">' +
						'<button type="button" class="row-btn" onclick="startSnippetEdit(' + JSON.stringify(s.id) + ')">Edit</button>' +
						'<button type="button" class="row-btn danger" onclick="deleteSnippet(' + JSON.stringify(s.id) + ')">' + (armed ? "Confirm delete" : "Delete") + '</button>' +
					'</div>' +
				'</div>';
			}).join("");
		}

		function startSnippetEdit(id) {
			editingId = id;
			deleteArmedId = null;
			clearTimeout(deleteArmTimer);
			renderSnippets();
		}

		function cancelSnippetEdit() {
			editingId = null;
			renderSnippets();
		}

		async function persistSnippets(nextSnippets) {
			var res = await fetch("/api/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ snippets: nextSnippets }),
			});
			return await res.json();
		}

		async function saveSnippetEdit(id) {
			var row = document.querySelector('.snippet-row[data-id="' + id + '"]');
			var name = row.querySelector(".snippet-edit-name").value;
			var text = row.querySelector(".snippet-edit-text").value;
			var next = settings.snippets.map(function(s) { return s.id === id ? { id: id, name: name, text: text } : s; });
			var data = await persistSnippets(next);
			if (!data.ok) {
				var resultEl = document.getElementById("snippet-edit-result-" + id);
				if (resultEl) { resultEl.textContent = "Error: " + data.error; resultEl.className = "result error"; }
				return;
			}
			settings = data.settings;
			editingId = null;
			renderSnippets();
		}

		function deleteSnippet(id) {
			if (deleteArmedId === id) {
				clearTimeout(deleteArmTimer);
				deleteArmedId = null;
				var next = settings.snippets.filter(function(s) { return s.id !== id; });
				void persistSnippets(next).then(function(data) {
					if (data.ok) settings = data.settings;
					renderSnippets();
				});
				return;
			}
			deleteArmedId = id;
			renderSnippets();
			clearTimeout(deleteArmTimer);
			deleteArmTimer = setTimeout(function() {
				deleteArmedId = null;
				renderSnippets();
			}, 4000);
		}

		async function addSnippet() {
			var nameInput = document.getElementById("snippet-name-input");
			var textInput = document.getElementById("snippet-text-input");
			var resultEl = document.getElementById("snippet-add-result");
			var name = nameInput.value.trim();
			var text = textInput.value;
			if (!name || !text.trim()) {
				resultEl.textContent = "Error: name and text are required";
				resultEl.className = "result error";
				return;
			}
			var next = settings.snippets.concat([{ name: name, text: text }]);
			var data = await persistSnippets(next);
			if (!data.ok) {
				resultEl.textContent = "Error: " + data.error;
				resultEl.className = "result error";
				return;
			}
			settings = data.settings;
			nameInput.value = "";
			textInput.value = "";
			resultEl.textContent = "Added";
			resultEl.className = "result success";
			renderSnippets();
		}

		async function saveDefaultCwd() {
			var input = document.getElementById("settings-default-cwd");
			var resultEl = document.getElementById("cwd-result");
			try {
				var res = await fetch("/api/settings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ defaultCwd: input.value.trim() }),
				});
				var data = await res.json();
				if (!data.ok) {
					resultEl.textContent = "Error: " + (data.error || "unknown");
					resultEl.className = "result error";
					return;
				}
				settings = data.settings;
				resultEl.textContent = "Saved";
				resultEl.className = "result success";
			} catch (error) {
				resultEl.textContent = "Error: " + error.message;
				resultEl.className = "result error";
			}
		}

		loadSettings();
		${dirSuggestScript("settings-default-cwd", "settings-cwd-suggest-list")}
	</script>
</body>
</html>`;
}

function renderReviewPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
	<title>pi review</title>
	<style>
		*, *::before, *::after { box-sizing: border-box; }
		body { font-family: ui-monospace, monospace; background: #1a1a1a; color: #e8e8e8; margin: 0; padding: 16px; }
		header { display: flex; gap: 6px; align-items: center; margin-bottom: 1em; font-size: 13px; color: #b7b7b7; }
		header a { color: #a4c2f4; text-decoration: none; font-weight: 500; }
		header a:hover { color: #c3d8fa; }
		header .sep { color: #a4a4a4; }
		header .home-btn { display: inline-flex; align-items: center; padding: 4px 6px; border-radius: 4px; color: #b7b7b7; }
		header .home-btn:hover { color: #e8e8e8; background: #2e2e2e; }
		header .branch { color: #a4c2f4; background: #242424; border: 1px solid #454545; border-radius: 3px; padding: 2px 6px; font-size: 0.85em; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.panel { background: #242424; border: 1px solid #454545; border-radius: 6px; padding: 1em; margin-bottom: 1em; }
		.panel h2 { font-size: 1em; margin: 0 0 0.6em 0; color: #b7b7b7; }
		label { display: block; margin: 0.3em 0; font-size: 0.9em; color: #b7b7b7; }
		input, button { font-family: inherit; font-size: 15px; background: #1a1a1a; color: #e8e8e8; border: 1px solid #454545; padding: 10px 12px; border-radius: 4px; }
		input { width: 100%; max-width: 280px; }
		button { cursor: pointer; background: #a4c2f4; border-color: #a4c2f4; color: #182234; white-space: nowrap; min-height: 44px; }
		button:hover { background: #c3d8fa; border-color: #c3d8fa; }
		button.danger { background: #2a1a1a; border-color: #f87171; color: #f87171; }
		button.danger:hover { background: #f87171; color: #182234; }
		button:disabled { opacity: 0.5; cursor: default; }
		button:disabled:hover { background: #a4c2f4; }
		.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0.3em 0; }
		.row label { margin: 0; flex: 1; min-width: 120px; }
		.status { font-size: 0.85em; color: #b7b7b7; }
		.status.warn { color: #facc15; }
		.status .num { color: #e8e8e8; font-weight: bold; }
		.file-list { list-style: none; margin: 0.8em 0 0 0; padding: 0; border: 1px solid #454545; border-radius: 6px; overflow: hidden; }
		.file-list li { border-top: 1px solid #454545; }
		.file-list li:first-child { border-top: none; }
		.file-row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: #1a1a1a; border: none; border-radius: 0; color: #e8e8e8; font-size: 0.85em; padding: 10px 12px; min-height: 44px; }
		.file-row:hover { background: #2e2e2e; }
		.file-row .box { color: #a4a4a4; flex-shrink: 0; }
		.file-row.done .box { color: #4ade80; }
		.file-row.done .path { color: #a4a4a4; }
		.file-row .path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
		.file-row .tag { flex-shrink: 0; font-size: 0.85em; color: #facc15; }
		.diff-view { background: #1a1a1a; border: 1px solid #454545; border-radius: 6px; padding: 0; overflow: auto; max-height: 60vh; -webkit-overflow-scrolling: touch; }
		.diff-view pre { margin: 0; padding: 12px; font-size: 0.8em; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
		.add { color: #4ade80; }
		.del { color: #f87171; }
		.hdr { color: #a4c2f4; }
		.msg { margin-top: 0.5em; font-size: 0.9em; }
		.msg.error { color: #f87171; }
		.msg.success { color: #4ade80; }
		.hidden { display: none; }
		@media (max-width: 600px) {
			body { padding: 10px; }
			.panel { padding: 0.8em; border-radius: 4px; }
			.row { flex-direction: column; align-items: stretch; gap: 6px; }
			.row button { width: 100%; }
			input { max-width: none; }
			button { min-height: 44px; }
		}
	</style>
</head>
<body>
	<header>
		<a href="/" class="home-btn" title="Home">
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><title>Home</title><path d="M2 6l6-4 6 4v8H2V6z" stroke="currentColor" stroke-width="1.2" fill="none" /><rect x="6" y="9" width="4" height="5" stroke="currentColor" stroke-width="1.2" fill="none" /></svg>
		</a>
		<span class="sep">/</span> review
		<a href="#" class="home-btn hidden" id="review-session-link" title="Back to session">
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><title>Session</title><rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none" /><path d="M4.5 6.5L6.5 8l-2 1.5M8 9.5h3.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
		</a>
		<span class="branch hidden" id="review-branch"></span>
		<span class="sep" style="margin-left:auto;font-size:0.85em;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="review-cwd"></span>
	</header>

	<div class="panel hidden" id="panel-start">
		<h2>Start review</h2>
		<div class="status" style="margin-bottom:0.7em">Leave Base and Head empty to use the current branch's GitHub PR. If no PR exists, pi will create one for the current branch.</div>
		<div class="row">
			<label>Base <input id="start-base" placeholder="current branch PR" /></label>
			<label>Head <input id="start-head" placeholder="current branch PR" /></label>
			<label>Repo <input id="start-repo" placeholder="(cwd)" /></label>
			<button onclick="startReview()">Start</button>
		</div>
		<div id="start-msg" class="msg"></div>
	</div>

	<div class="panel hidden" id="panel-active">
		<div class="row" style="justify-content:space-between">
			<h2 style="margin:0" id="review-title">Review</h2>
			<div>
				<button onclick="swapReview()" id="btn-swap" title="Restart this review with base and head exchanged">Swap base/head</button>
				<button onclick="commitReview()" id="btn-commit" title="Keep what you have reviewed and pick up new commits">Commit review</button>
				<button onclick="mergeReview()" id="btn-merge" title="Merge this branch's pull request on GitHub">Merge PR</button>
				<button class="danger" onclick="clearReview()" title="Discard all review progress and start this review again">Restart</button>
			</div>
		</div>
		<div id="review-action-msg" class="msg"></div>
		<div id="review-status" class="status"></div>
		<ul id="file-list" class="file-list hidden"></ul>
		<div id="review-file" class="hidden">
			<div class="row" style="justify-content:space-between; margin-top:0.8em">
				<div class="row" style="flex:1; min-width:0; gap:8px; margin:0">
					<button onclick="showSummary()" id="btn-back" title="Back to the file list">&larr; Files</button>
					<strong id="file-path" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap"></strong>
				</div>
				<div>
					<button onclick="markFile()" id="btn-mark">Mark reviewed</button>
					<button onclick="nextFile()">Skip</button>
				</div>
			</div>
			<div class="status" id="file-position"></div>
			<div class="diff-view"><pre id="diff-content"></pre></div>
		</div>
		<div id="review-empty" class="status hidden">All files reviewed.</div>
		<div id="review-msg" class="msg"></div>
	</div>

	<script>
		const startPanel = document.getElementById("panel-start");
		const activePanel = document.getElementById("panel-active");
		const params = new URLSearchParams(location.search);
		const repoCwd = params.get("cwd") || "";
		let autoStartReview = params.get("start") === "1";
		if (repoCwd) {
			document.getElementById("review-cwd").textContent = repoCwd;
			document.getElementById("start-repo").value = repoCwd;
		}
		// Shown only when we know which session this review was opened from
		const instanceId = params.get("instance");
		if (instanceId) {
			const sessionLink = document.getElementById("review-session-link");
			sessionLink.href = "/i/" + encodeURIComponent(instanceId) + "/";
			sessionLink.classList.remove("hidden");
		}
		let sessionId = null;
		let currentFile = null;
		let currentFingerprint = null;
		// Every file in the review, newest status first, as returned by cranium status
		let reviewFiles = [];
		// null on the summary view, otherwise the path of the file being reviewed
		let openFile = null;
		// Refs of the active session, so Clear can recreate the same review range
		let activeBaseRef = null;
		let activeHeadRef = null;
		let activeProviderReviewId = null;
		let activeCounts = null;

		function selectedRepo() {
			return document.getElementById("start-repo").value.trim() || repoCwd;
		}

		async function loadBranch() {
			const el = document.getElementById("review-branch");
			const repo = selectedRepo();
			if (!repo) {
				el.classList.add("hidden");
				return;
			}
			try {
				const res = await fetch("/api/git/branch?repo=" + encodeURIComponent(repo));
				const data = await res.json();
				if (data.ok && data.branch) {
					el.textContent = data.branch;
					el.classList.remove("hidden");
					return;
				}
			} catch (_err) {
				// fall through and hide: a missing branch is not a review error
			}
			el.classList.add("hidden");
		}
		document.getElementById("start-repo").addEventListener("change", loadBranch);

		async function api(method, url, body) {
			const repo = selectedRepo();
			if (repo) url += (url.indexOf("?") === -1 ? "?" : "&") + "repo=" + encodeURIComponent(repo);
			const opts = { method, headers: body != null ? { "Content-Type": "application/json" } : {} };
			if (body != null) opts.body = JSON.stringify({ repo: repo || undefined, ...body });
			const res = await fetch(url, opts);
			return res.json();
		}

		async function loadStatus() {
			const data = await api("GET", "/api/review/status");
			if (!data.ok || !data.data) {
				// No active review
				startPanel.classList.remove("hidden");
				activePanel.classList.add("hidden");
				if (autoStartReview) {
					autoStartReview = false;
					await startReview();
				}
				return;
			}
			const r = data.data.result;
			sessionId = r.session.id;
			activeBaseRef = r.session.baseRef;
			activeHeadRef = r.session.headRef;
			activeProviderReviewId = r.session.providerReviewId;
			activeCounts = r.counts;
			startPanel.classList.add("hidden");
			activePanel.classList.remove("hidden");

			document.getElementById("review-title").textContent =
				"Review " + r.session.baseRef + ".." + r.session.headRef;
			document.getElementById("review-status").innerHTML =
				"<span class=num>" + r.counts.unreviewed + "</span> unreviewed &middot; " +
				"<span class=num>" + r.counts.reviewed + "</span> reviewed &middot; " +
				"<span class=num>" + r.counts.changedSinceReview + "</span> changed";

			reviewFiles = Array.isArray(r.files) ? r.files : [];
			renderFileList();

			// A file open before the refresh stays open so marking one file does not
			// throw away the diff the user is reading.
			if (openFile !== null && reviewFiles.some((file) => file.path === openFile)) {
				document.getElementById("file-list").classList.add("hidden");
				document.getElementById("review-empty").classList.add("hidden");
			} else {
				openFile = null;
				document.getElementById("review-file").classList.add("hidden");
				const emptyEl = document.getElementById("review-empty");
				// An empty range is not a finished review: with base and head the wrong way
				// round the diff is empty, which must not look like "nothing left to do".
				if (r.files.length === 0) {
					emptyEl.innerHTML =
						"No files in <strong>" + escapeRef(r.session.baseRef) + ".." + escapeRef(r.session.headRef) +
						"</strong>. This range is empty \u2014 if the branches are the wrong way round, " +
						"Restart the review with base <strong>" + escapeRef(r.session.headRef) + "</strong> and head <strong>" +
						escapeRef(r.session.baseRef) + "</strong>.";
					emptyEl.className = "status warn";
					emptyEl.classList.remove("hidden");
				} else if (r.counts.unreviewed === 0 && r.counts.changedSinceReview === 0) {
					emptyEl.textContent = "All files reviewed.";
					emptyEl.className = "status";
					emptyEl.classList.remove("hidden");
				} else {
					// Files remain: the list itself is the view, so no empty message.
					emptyEl.classList.add("hidden");
				}
			}
		}

		function isReviewed(status) {
			return status === "reviewed" || status === "unchanged";
		}

		/** Files still needing attention, in the order the diff view walks them. */
		function pendingFiles() {
			return reviewFiles.filter((file) => !isReviewed(file.status));
		}

		/**
		 * Render the summary: every file in the review with a tick when reviewed and an
		 * empty box when not. Clicking a row drills into that file's diff.
		 */
		function renderFileList() {
			const list = document.getElementById("file-list");
			list.textContent = "";
			if (reviewFiles.length === 0) {
				list.classList.add("hidden");
				return;
			}
			for (const file of reviewFiles) {
				const done = isReviewed(file.status);
				const item = document.createElement("li");
				const row = document.createElement("button");
				row.className = done ? "file-row done" : "file-row";
				row.onclick = () => openReviewFile(file.path);

				const box = document.createElement("span");
				box.className = "box";
				box.textContent = done ? "[x]" : "[ ]";
				row.appendChild(box);

				// bdi keeps the rtl ellipsis from reordering the path's own characters
				const pathEl = document.createElement("bdi");
				pathEl.className = "path";
				pathEl.textContent = file.path;
				row.appendChild(pathEl);

				if (file.status === "changedSinceReview") {
					const tag = document.createElement("span");
					tag.className = "tag";
					tag.textContent = "changed";
					row.appendChild(tag);
				}

				item.appendChild(row);
				list.appendChild(item);
			}
			list.classList.remove("hidden");
		}

		/** Show the file list and hide any open diff. */
		function showSummary() {
			openFile = null;
			currentFile = null;
			currentFingerprint = null;
			document.getElementById("review-file").classList.add("hidden");
			document.getElementById("review-msg").textContent = "";
			return loadStatus();
		}

		/** Drill into one file's diff. */
		async function openReviewFile(filePath) {
			const file = reviewFiles.find((candidate) => candidate.path === filePath);
			if (!file) return;
			openFile = file.path;
			currentFile = file.path;
			currentFingerprint = file.currentFingerprint;
			document.getElementById("file-path").textContent = file.path;
			document.getElementById("review-file").classList.remove("hidden");
			document.getElementById("file-list").classList.add("hidden");
			document.getElementById("review-empty").classList.add("hidden");
			document.getElementById("btn-mark").disabled = isReviewed(file.status);

			const pending = pendingFiles();
			const position = pending.findIndex((candidate) => candidate.path === file.path);
			document.getElementById("file-position").textContent =
				position === -1
					? "Already reviewed"
					: "File " + (position + 1) + " of " + pending.length + " to review";

			document.getElementById("diff-content").textContent = "Loading\u2026";
			const diffData = await api("GET",
				"/api/review/diff?path=" + encodeURIComponent(file.path) +
				(sessionId ? "&session=" + sessionId : ""));
			// A slower diff for a file the user already navigated away from must not land
			if (openFile !== file.path) return;
			document.getElementById("diff-content").innerHTML =
				highlightDiff((diffData.ok && typeof diffData.data === "string") ? diffData.data : "");
			document.querySelector(".diff-view").scrollTop = 0;
		}

		function escapeRef(value) {
			return String(value == null ? "" : value)
				.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		}

		/**
		 * Open the next file needing review after afterPath, wrapping to the start.
		 * Returns to the summary when nothing is left.
		 */
		async function openNextPending(afterPath) {
			const pending = pendingFiles();
			if (pending.length === 0) {
				showSummary();
				return;
			}
			// Walk from the file just reviewed so marking advances in list order
			const index = reviewFiles.findIndex((file) => file.path === afterPath);
			const next =
				reviewFiles
					.slice(index + 1)
					.find((file) => !isReviewed(file.status)) ?? pending[0];
			await openReviewFile(next.path);
		}

		function highlightDiff(text) {
			return text
				.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
				.replace(/^(\\+.*)$/gm, '<span class="add">$1</span>')
				.replace(/^(-.*)$/gm, '<span class="del">$1</span>')
				.replace(/^(@@.*@@.*)$/gm, '<span class="hdr">$1</span>')
				.replace(/^(diff .*)$/gm, '<span class="hdr">$1</span>')
				.replace(/^(index .*)$/gm, '<span class="hdr">$1</span>')
				.replace(/^(---.*)$/gm, '<span class="hdr">$1</span>')
				.replace(/^(\\+\\+\\+.*)$/gm, '<span class="hdr">$1</span>');
		}

		async function startReview() {
			const base = document.getElementById("start-base").value.trim();
			const head = document.getElementById("start-head").value.trim();
			const repo = selectedRepo();
			const msg = document.getElementById("start-msg");
			msg.textContent = base || head ? "Starting…" : "Finding or creating PR…"; msg.className = "msg";
			const data = await api("POST", "/api/review/start", {
				base: base || undefined,
				head: head || undefined,
				repo: repo || undefined,
				createPr: !base && !head,
			});
			if (!data.ok) {
				msg.textContent = data.error || "Failed"; msg.className = "msg error";
			} else {
				// --create-pr can move HEAD to a new branch
				await loadBranch();
				await loadStatus();
			}
		}

		/** Mark the open file reviewed, then move straight on to the next one. */
		async function markFile() {
			if (!currentFile) return;
			const marked = currentFile;
			const msg = document.getElementById("review-msg");
			const button = document.getElementById("btn-mark");
			button.disabled = true;
			msg.textContent = "Marking…"; msg.className = "msg";
			try {
				const data = await api("POST", "/api/review/mark", {
					path: marked,
					session: sessionId,
					expected: currentFingerprint,
				});
				if (!data.ok) {
					msg.textContent = data.error || "Failed"; msg.className = "msg error";
					button.disabled = false;
					return;
				}
				msg.textContent = "";
				// Refresh statuses so the tick and the remaining count reflect the mark,
				// keeping the current file open so loadStatus does not bounce to the list.
				await loadStatus();
				await openNextPending(marked);
			} finally {
				if (openFile !== null) {
					const file = reviewFiles.find((candidate) => candidate.path === openFile);
					button.disabled = file ? isReviewed(file.status) : false;
				}
			}
		}

		/** Leave the file unreviewed and move to the next one. */
		async function nextFile() {
			document.getElementById("review-msg").textContent = "";
			await openNextPending(currentFile);
		}

		/**
		 * Merge this branch's GitHub pull request into a target branch (default main).
		 *
		 * The merge happens on GitHub and cannot be undone from here, so the target is
		 * confirmed rather than assumed, and outstanding review work is called out.
		 */
		/**
		 * True when a merge failed only because the branch has no pull request.
		 *
		 * cranium reports this two ways: NO_PULL_REQUEST when it could ask and was
		 * declined, and CONFIRMATION_REQUIRED when it could not prompt at all, which
		 * is what the server always gets.
		 */
		function missingPullRequest(error) {
			const text = String(error || "");
			return /No GitHub pull request exists/.test(text) ||
				/No open pull request exists for the current branch/.test(text);
		}

		/** Turn cranium's merge failures into something actionable. */
		function explainMergeError(error) {
			const text = String(error || "").trim();
			if (/Cannot determine a GitHub repository from origin/.test(text)) {
				return text + " - check the origin remote (git remote get-url origin) points at GitHub.";
			}
			if (missingPullRequest(text)) {
				return "No open pull request exists for this branch, and creating one was declined.";
			}
			return text;
		}

		/**
		 * Update the local repository after a merge lands on the remote.
		 *
		 * The base branch is usually not checked out, so it is fast-forwarded directly
		 * as well; reviews resolve refs locally and would otherwise keep diffing against
		 * the pre-merge commit.
		 */
		async function runGitPull(baseBranch) {
			const repo = selectedRepo();
			// Updating the base ref only applies when it is not the checked-out branch,
			// which git refuses; on that branch the pull already covers it.
			const command =
				"git pull --ff-only && " +
				'if [ "$(git rev-parse --abbrev-ref HEAD)" != "' + baseBranch + '" ]; then ' +
				"git fetch origin " + baseBranch + ":" + baseBranch + "; fi";
			try {
				const res = await fetch("/api/bash", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ command: command, cwd: repo || undefined }),
				});
				const data = await res.json();
				if (data.ok) return { ok: true };
				return { ok: false, error: (data.error || data.output || "git pull failed").trim().split("\\n")[0] };
			} catch (err) {
				return { ok: false, error: err.message || "git pull failed" };
			}
		}

		async function mergeReview() {
			const msg = document.getElementById("review-action-msg");
			const button = document.getElementById("btn-merge");
			const target = window.prompt("Merge this branch's pull request into which branch?", "main");
			if (target === null) return;
			const baseBranch = target.trim() || "main";
			const outstanding = activeCounts
				? activeCounts.unreviewed + activeCounts.changedSinceReview
				: 0;
			const warning = outstanding > 0
				? "\\n\\n" + outstanding + " file(s) are still unreviewed or changed since you reviewed them."
				: "";
			if (!confirm("Merge the pull request for this branch into " + baseBranch + "?" + warning)) return;
			button.disabled = true;
			msg.textContent = "Merging…"; msg.className = "msg";
			try {
				let data = await api("POST", "/api/review/merge", { base: baseBranch, session: sessionId });
				// No pull request yet: offer to open one for this branch, then merge it.
				if (!data.ok && missingPullRequest(data.error)) {
					if (!confirm("No open pull request exists for this branch. Create one and merge it into " + baseBranch + "?")) {
						msg.textContent = explainMergeError(data.error); msg.className = "msg error";
						return;
					}
					msg.textContent = "Creating pull request…";
					data = await api("POST", "/api/review/merge", {
						base: baseBranch,
						session: sessionId,
						createPr: true,
					});
				}
				if (!data.ok) {
					msg.textContent = explainMergeError(data.error) || "Failed"; msg.className = "msg error";
					return;
				}
				const result = data.data && data.data.result;
				const pull = result && result.pull;
				const merged = pull
					? "Merged " + pull.identity + " into " + baseBranch + "."
					: "Merged into " + baseBranch + ".";
				// The merge happened on GitHub, so pull to bring the local branches in line.
				// Without this the local base ref stays behind and reviews diff against a
				// stale commit.
				msg.textContent = merged + " Pulling\u2026"; msg.className = "msg";
				const pulled = await runGitPull(baseBranch);
				msg.textContent = pulled.ok ? merged + " Pulled." : merged + " Pull failed: " + pulled.error;
				msg.className = pulled.ok ? "msg success" : "msg error";
				await loadBranch();
				await loadStatus();
			} finally {
				button.disabled = false;
			}
		}

		/**
		 * Commit the review: re-anchor to the repo's current HEAD while keeping every
		 * checkpoint. Files reviewed at an older revision come back as "changed" showing
		 * only what moved since you reviewed them, and new commits add new files.
		 */
		async function commitReview() {
			const msg = document.getElementById("review-action-msg");
			const button = document.getElementById("btn-commit");
			button.disabled = true;
			msg.textContent = "Committing review\u2026"; msg.className = "msg";
			try {
				const data = await api("POST", "/api/review/refresh", sessionId ? { session: sessionId } : {});
				if (!data.ok) {
					msg.textContent = data.error || "Failed"; msg.className = "msg error";
					return;
				}
				msg.textContent = "Review committed."; msg.className = "msg success";
				// HEAD may have moved to a different branch since the review started
				await loadBranch();
				await loadStatus();
			} finally {
				button.disabled = false;
			}
		}

		/**
		 * Restart the review with base and head exchanged. Fixes a review created with
		 * the branches the wrong way round, which produces an empty range.
		 */
		async function swapReview() {
			const base = activeBaseRef;
			const head = activeHeadRef;
			if (!base || !head) {
				const msg = document.getElementById("review-action-msg");
				msg.textContent = "This review has no explicit base and head to swap.";
				msg.className = "msg error";
				return;
			}
			if (!confirm("Restart this review as " + head + ".." + base + "? Review progress will be discarded.")) return;
			await restartReview({ base: head, head: base });
		}

		/**
		 * Discard all review progress and start the same review over from scratch.
		 *
		 * cranium's start is idempotent (it refreshes an existing session instead of
		 * recreating it), so the old session must be deleted first. The session's own
		 * refs are reused so the new review covers the same range; a PR-backed session
		 * re-resolves the PR instead.
		 */
		async function clearReview() {
			if (!confirm("Discard all review progress and start this review again?")) return;
			const fromPullRequest = activeProviderReviewId !== null && activeProviderReviewId !== undefined;
			const base = activeBaseRef;
			const head = activeHeadRef;
			// A PR-backed session re-resolves its existing PR, so creation is never needed here.
			await restartReview(fromPullRequest || !base || !head ? {} : { base: base, head: head });
		}

		/** Delete the current session, then start a new one with the given refs. */
		async function restartReview(startBody) {
			const msg = document.getElementById("review-action-msg");
			msg.textContent = "Clearing\u2026"; msg.className = "msg";
			const cleared = await api("POST", "/api/review/clear", sessionId ? { session: sessionId } : {});
			if (!cleared.ok) {
				msg.textContent = cleared.error || "Failed to clear"; msg.className = "msg error";
				return;
			}
			sessionId = null;
			currentFile = null;
			currentFingerprint = null;

			msg.textContent = "Starting review\u2026";
			const started = await api("POST", "/api/review/start", startBody);
			if (!started.ok) {
				// The review is gone; fall back to the start panel so it can be recreated by hand
				msg.textContent = started.error || "Cleared, but failed to start again";
				msg.className = "msg error";
				await loadStatus();
				return;
			}
			msg.textContent = "";
			await loadBranch();
			await loadStatus();
		}

		// Keyboard shortcuts mirroring the spacemacs review bindings: q returns to the
		// file list, m marks reviewed and advances, n skips to the next file.
		document.addEventListener("keydown", (event) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const tag = event.target && event.target.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA") return;
			if (openFile === null) return;
			if (event.key === "q" || event.key === "Escape") {
				event.preventDefault();
				showSummary();
			} else if (event.key === "m") {
				event.preventDefault();
				markFile();
			} else if (event.key === "n") {
				event.preventDefault();
				nextFile();
			}
		});

		loadBranch();
		loadStatus();
	</script>
</body>
</html>`;
}

function renderTerminalPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
	<title>pi terminal</title>
	<style>
		*, *::before, *::after { box-sizing: border-box; }
		body { font-family: ui-monospace, monospace; background: #1a1a1a; color: #e8e8e8; margin: 0; display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
		header { padding: 10px 14px; border-bottom: 1px solid #454545; font-size: 13px; color: #b7b7b7; display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
		header a { color: #a4c2f4; text-decoration: none; font-weight: 500; }
		header a:hover { color: #c3d8fa; }
		header .sep { color: #a4a4a4; }
		header .home-btn { display: inline-flex; align-items: center; padding: 6px 6px; border-radius: 4px; color: #b7b7b7; }
		header .home-btn:hover { color: #e8e8e8; background: #2e2e2e; }
		header .cwd-wrap { flex: 1; text-align: right; }
		header input { font-family: inherit; font-size: 13px; background: #1a1a1a; color: #e8e8e8; border: 1px solid #454545; padding: 6px 8px; border-radius: 4px; width: 160px; }
		#output { flex: 1; overflow-y: auto; padding: 12px; font-size: 0.85em; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
		#input-line { display: flex; border-top: 1px solid #454545; flex-shrink: 0; }
		#input-line span { padding: 12px 10px 12px 14px; color: #4ade80; font-size: 15px; user-select: none; }
		#input-line input { flex: 1; font-family: inherit; font-size: 15px; background: transparent; color: #e8e8e8; border: none; padding: 12px 0; outline: none; }
		.dim { color: #a4a4a4; }
		.err { color: #f87171; }
		@media (max-width: 600px) {
			header { padding: 8px 10px; }
			header input { width: 120px; font-size: 12px; }
			#output { padding: 8px; font-size: 0.8em; }
		}
	</style>
</head>
<body>
	<header>
		<a href="/" class="home-btn" title="Home">
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><title>Home</title><path d="M2 6l6-4 6 4v8H2V6z" stroke="currentColor" stroke-width="1.2" fill="none" /><rect x="6" y="9" width="4" height="5" stroke="currentColor" stroke-width="1.2" fill="none" /></svg>
		</a>
		<span class="sep">/</span> terminal
		<span class="cwd-wrap"><input id="cwd" placeholder="cwd" title="Working directory" value="${escapeHtml(process.cwd())}" /></span>
	</header>
	<div id="output"></div>
	<div id="input-line">
		<span>$</span>
		<input id="cmd" autofocus placeholder="Enter command…" spellcheck="false" />
	</div>
	<script>
		const output = document.getElementById("output");
		const cmd = document.getElementById("cmd");
		const cwdInput = document.getElementById("cwd");
		let history = [];
		let historyIdx = -1;

		function append(text, cls) {
			const el = document.createElement("div");
			if (cls) el.className = cls;
			el.textContent = text;
			output.appendChild(el);
			output.scrollTop = output.scrollHeight;
		}

		async function run() {
			const command = cmd.value.trim();
			if (!command) return;
			history.push(command);
			historyIdx = history.length;
			cmd.value = "";
			append("$ " + command, "dim");
			cmd.disabled = true;
			try {
				const cwd = cwdInput.value.trim() || "";
				const res = await fetch("/api/bash", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ command, cwd: cwd || undefined }),
				});
				const data = await res.json();
				if (data.output) append(data.output.trimEnd());
				if (data.error) append(data.error, "err");
			} catch (err) {
				append(err.message || "Failed", "err");
			}
			cmd.disabled = false;
			cmd.focus();
		}

		cmd.addEventListener("keydown", function(e) {
			if (e.key === "Enter") { e.preventDefault(); run(); }
			else if (e.key === "ArrowUp") {
				e.preventDefault();
				if (historyIdx > 0) { historyIdx--; cmd.value = history[historyIdx]; }
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				if (historyIdx < history.length - 1) { historyIdx++; cmd.value = history[historyIdx]; }
				else { historyIdx = history.length; cmd.value = ""; }
			}
		});
	</script>
</body>
</html>`;
}

const INSTANCE_PATH_PATTERN = /^\/i\/([0-9a-f-]{36})(\/|$)/;

export async function startServerWeb(options: ServerWebOptions): Promise<ServerWebHandle> {
	const { host } = options;
	const staticDir = getWebDistDir();
	const indexPath = path.join(staticDir, "index.html");
	if (!fs.existsSync(indexPath)) {
		throw new Error(
			`Web UI assets not found at ${staticDir}. Build them with: npm run build --workspace=@earendil-works/pi-web`,
		);
	}

	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");

		// POST /api/spawn — spawn a new instance from the web dashboard
		if (request.method === "POST" && url.pathname === "/api/spawn") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				void (async () => {
					try {
						const parsed = JSON.parse(body) as {
							cwd?: string;
							label?: string;
							sessionFile?: string;
							createDir?: boolean;
							namespace?: string;
						};
						const cwdRaw = parsed.cwd?.trim();
						// Resumes carry a sessionFile (with the stored cwd); fresh spawns must
						// name a directory explicitly - no silent default to the server's cwd.
						if (!cwdRaw) {
							response.writeHead(400, { "content-type": "application/json" });
							response.end(JSON.stringify({ ok: false, error: "cwd is required" }));
							return;
						}
						// The default-cwd setting (and manual entry) may start with '~'; the
						// working-directory autocomplete already resolves this for its own
						// suggestions, but a value typed/prefilled without picking a suggestion
						// reaches this handler unexpanded.
						const cwd = expandHomePrefix(cwdRaw);
						const namespaceResult = resolveRequestNamespace(parsed.namespace);
						if (!namespaceResult.ok) {
							response.writeHead(400, { "content-type": "application/json" });
							response.end(JSON.stringify(namespaceResult));
							return;
						}
						const namespace = namespaceResult.namespace;
						if (!fs.existsSync(cwd)) {
							if (parsed.createDir) {
								fs.mkdirSync(cwd, { recursive: true });
							} else {
								response.writeHead(400, { "content-type": "application/json" });
								response.end(
									JSON.stringify({
										ok: false,
										error: `Directory does not exist: ${cwd} (tick "Create directory" to create it)`,
									}),
								);
								return;
							}
						} else if (!fs.statSync(cwd).isDirectory()) {
							response.writeHead(400, { "content-type": "application/json" });
							response.end(JSON.stringify({ ok: false, error: `Not a directory: ${cwd}` }));
							return;
						}
						const instance = await supervisor.spawnInstance({
							cwd,
							label: parsed.label,
							sessionFile: parsed.sessionFile,
							namespace,
						});
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify({
								ok: true,
								instance: {
									id: instance.id,
									status: instance.status,
									cwd: instance.cwd,
									label: instance.label,
									namespace: instance.namespace,
								},
							}),
						);
					} catch (error: unknown) {
						response.writeHead(500, { "content-type": "application/json" });
						response.end(
							JSON.stringify({
								ok: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						);
					}
				})();
			});
			return;
		}

		// GET /api/fs/dirs?prefix=<path> — directory-only completions for the
		// dashboard's "working directory" field (~ expands to the home directory).
		if (request.method === "GET" && url.pathname === "/api/fs/dirs") {
			const prefix = url.searchParams.get("prefix") ?? "";
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
			response.end(JSON.stringify({ ok: true, dirs: listDirCompletions(prefix) }));
			return;
		}

		// GET /api/git/branch?repo=<path> — current branch of a repo, for the review header
		if (request.method === "GET" && url.pathname === "/api/git/branch") {
			const repo = url.searchParams.get("repo") || process.cwd();
			response.writeHead(200, { "content-type": "application/json" });
			try {
				// Detached HEAD exits non-zero, which the catch below reports as no branch.
				const branch = execFileSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
					cwd: repo,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				response.end(JSON.stringify({ ok: true, branch: branch || undefined }));
			} catch {
				response.end(JSON.stringify({ ok: true, branch: undefined }));
			}
			return;
		}

		// GET /api/sessions?cwd=<path> — list past sessions. Without a cwd, lists every
		// session across all project directories (newest first); with one, only the
		// sessions of that working directory.
		if (request.method === "GET" && url.pathname === "/api/sessions") {
			response.writeHead(200, { "content-type": "application/json" });
			const cwd = url.searchParams.get("cwd")?.trim();
			const sessionsPromise = cwd ? SessionManager.list(cwd) : SessionManager.listAll();
			sessionsPromise
				.then((sessions: Awaited<typeof sessionsPromise>) => {
					response.end(
						JSON.stringify({
							ok: true,
							sessions: sessions.map((s: (typeof sessions)[number]) => ({
								id: s.id,
								path: s.path,
								cwd: s.cwd,
								name: s.name,
								messageCount: s.messageCount,
								firstMessage: s.firstMessage,
								modified: s.modified,
							})),
						}),
					);
				})
				.catch((error: unknown) => {
					response.end(JSON.stringify({ ok: false, error: String(error) }));
				});
			return;
		}

		// GET /api/dashboard-sessions — the dashboard's unified session list: live and
		// stopped/errored tracked instances merged with past sessions found only on
		// disk, deduplicated by session file. Includes pinned/archived and the
		// resolved display name (session name > label > fallback).
		if (request.method === "GET" && url.pathname === "/api/dashboard-sessions") {
			listDashboardSessions()
				.then((sessions) => {
					response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
					response.end(JSON.stringify({ ok: true, sessions }));
				})
				.catch((error: unknown) => {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ ok: false, error: String(error) }));
				});
			return;
		}

		// Session actions (rename/pin/archive/delete), addressed by tracked instance
		// id or, for a past session with no InstanceRecord yet, by session file path
		// (+ cwd, needed if a record has to be created to hold pinned/archived state).
		if (request.method === "POST" && url.pathname === "/api/sessions/rename") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				void (async () => {
					try {
						const parsed = JSON.parse(body) as {
							id?: string;
							path?: string;
							cwd?: string;
							name?: string;
							namespace?: string;
						};
						if (!parsed.name || !parsed.name.trim()) {
							response.writeHead(200, { "content-type": "application/json" });
							response.end(JSON.stringify({ ok: false, error: "Name is required" }));
							return;
						}
						const instanceIdResult = resolveSessionActionInstanceId(parsed);
						if (!instanceIdResult.ok) {
							response.writeHead(200, { "content-type": "application/json" });
							response.end(JSON.stringify(instanceIdResult));
							return;
						}
						const result = await supervisor.renameInstance(instanceIdResult.instanceId, parsed.name);
						response.writeHead(200, { "content-type": "application/json" });
						response.end(JSON.stringify(result));
					} catch (error: unknown) {
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
						);
					}
				})();
			});
			return;
		}

		if (request.method === "POST" && url.pathname === "/api/sessions/pin") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				void (async () => {
					try {
						const parsed = JSON.parse(body) as {
							id?: string;
							path?: string;
							cwd?: string;
							pinned?: boolean;
							namespace?: string;
						};
						const instanceIdResult = resolveSessionActionInstanceId(parsed);
						if (!instanceIdResult.ok) {
							response.writeHead(200, { "content-type": "application/json" });
							response.end(JSON.stringify(instanceIdResult));
							return;
						}
						const instance = await supervisor.setPinned(instanceIdResult.instanceId, parsed.pinned !== false);
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify(instance ? { ok: true, instance } : { ok: false, error: "Unknown instance" }),
						);
					} catch (error: unknown) {
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
						);
					}
				})();
			});
			return;
		}

		if (request.method === "POST" && url.pathname === "/api/sessions/archive") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				void (async () => {
					try {
						const parsed = JSON.parse(body) as {
							id?: string;
							path?: string;
							cwd?: string;
							archived?: boolean;
							namespace?: string;
						};
						const instanceIdResult = resolveSessionActionInstanceId(parsed);
						if (!instanceIdResult.ok) {
							response.writeHead(200, { "content-type": "application/json" });
							response.end(JSON.stringify(instanceIdResult));
							return;
						}
						const instance = await supervisor.setArchived(instanceIdResult.instanceId, parsed.archived !== false);
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify(instance ? { ok: true, instance } : { ok: false, error: "Unknown instance" }),
						);
					} catch (error: unknown) {
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
						);
					}
				})();
			});
			return;
		}

		// Deleting a tracked instance (id) stops it, removes the record, and deletes
		// its session file. Deleting a bare past session (path only, never tracked)
		// just removes the file after validating it is a real session path.
		if (request.method === "POST" && url.pathname === "/api/sessions/delete") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				void (async () => {
					try {
						const parsed = JSON.parse(body) as { id?: string; path?: string };
						if (parsed.id) {
							const result = await supervisor.deleteInstance(parsed.id);
							response.writeHead(200, { "content-type": "application/json" });
							response.end(JSON.stringify(result));
							return;
						}
						if (parsed.path && isSafeSessionFilePath(parsed.path)) {
							if (fs.existsSync(parsed.path)) {
								fs.rmSync(parsed.path);
							}
							response.writeHead(200, { "content-type": "application/json" });
							response.end(JSON.stringify({ ok: true }));
							return;
						}
						response.writeHead(200, { "content-type": "application/json" });
						response.end(JSON.stringify({ ok: false, error: "Missing id or invalid path" }));
					} catch (error: unknown) {
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
						);
					}
				})();
			});
			return;
		}

		// POST /api/sessions/move — move a session to another namespace (see
		// namespaces.ts). The session file itself does not move; a live instance is
		// stopped and, if resumable, respawned under the target namespace's env.
		if (request.method === "POST" && url.pathname === "/api/sessions/move") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				void (async () => {
					try {
						const parsed = JSON.parse(body) as {
							id?: string;
							path?: string;
							cwd?: string;
							namespace?: string;
							fromNamespace?: string;
						};
						const instanceIdResult = resolveSessionActionInstanceId({
							id: parsed.id,
							path: parsed.path,
							cwd: parsed.cwd,
							namespace: parsed.fromNamespace,
						});
						if (!instanceIdResult.ok) {
							response.writeHead(200, { "content-type": "application/json" });
							response.end(JSON.stringify(instanceIdResult));
							return;
						}
						const result = await supervisor.moveInstanceNamespace(instanceIdResult.instanceId, parsed.namespace);
						response.writeHead(200, { "content-type": "application/json" });
						response.end(JSON.stringify(result));
					} catch (error: unknown) {
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
						);
					}
				})();
			});
			return;
		}

		// GET /api/namespaces — list account namespaces (always includes "default").
		// POST /api/namespaces — create a namespace: { name }
		if (url.pathname === "/api/namespaces" && request.method === "GET") {
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
			response.end(JSON.stringify({ ok: true, namespaces: listNamespaces() }));
			return;
		}
		if (url.pathname === "/api/namespaces" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				try {
					const parsed = JSON.parse(body) as { name?: string };
					const result = createNamespace(parsed.name ?? "");
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify(result));
				} catch (error: unknown) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
					);
				}
			});
			return;
		}

		// POST /api/namespaces/delete — remove a namespace from the registry. Refuses
		// while any session still references it; never deletes its credential files.
		if (url.pathname === "/api/namespaces/delete" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				try {
					const parsed = JSON.parse(body) as { name?: string };
					const result = deleteNamespace(parsed.name ?? "");
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify(result));
				} catch (error: unknown) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
					);
				}
			});
			return;
		}

		// GET /api/settings — full dashboard settings object (default cwd + snippets).
		if (url.pathname === "/api/settings" && request.method === "GET") {
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
			response.end(JSON.stringify({ ok: true, settings: getDashboardSettings() }));
			return;
		}

		// PUT /api/settings — update dashboard settings. Fields omitted from the body
		// keep their current stored value (see updateDashboardSettings), so the
		// settings page can save the working-directory field and the snippet list
		// independently.
		if (url.pathname === "/api/settings" && request.method === "PUT") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				try {
					const parsed = JSON.parse(body) as { defaultCwd?: unknown; snippets?: unknown };
					const result = updateDashboardSettings(parsed);
					response.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
					response.end(JSON.stringify(result));
				} catch (error: unknown) {
					response.writeHead(400, { "content-type": "application/json" });
					response.end(
						JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
					);
				}
			});
			return;
		}

		// GET /api/snippets — lightweight snippet list for the chat composer's snippet picker.
		if (url.pathname === "/api/snippets" && request.method === "GET") {
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
			response.end(JSON.stringify({ ok: true, snippets: getDashboardSettings().snippets }));
			return;
		}

		// Subagent inspection API (pi-subagents extension).
		// GET /i/<id>/subagents — list subagent runs for an instance
		const subagentsMatch = /^\/i\/([0-9a-f-]{36})\/subagents$/.exec(url.pathname);
		if (request.method === "GET" && subagentsMatch) {
			const instance = supervisor.getLiveInstance(subagentsMatch[1]);
			if (!instance) {
				sendText(response, 404, "Unknown instance\n");
				return;
			}
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
			response.end(JSON.stringify({ ok: true, runs: listSubagentRuns(instance.cwd, instance.sessionFile) }));
			return;
		}

		// GET /i/<id>/subagents/file?path=<relative> — read a subagent artifact file
		// (transcript, output, or named output). Paths are the ones returned by the
		// listing above and must resolve inside the instance's artifacts dir.
		const subagentsFileMatch = /^\/i\/([0-9a-f-]{36})\/subagents\/file$/.exec(url.pathname);
		if (request.method === "GET" && subagentsFileMatch) {
			const instance = supervisor.getLiveInstance(subagentsFileMatch[1]);
			if (!instance) {
				sendText(response, 404, "Unknown instance\n");
				return;
			}
			const relative = url.searchParams.get("path") ?? "";
			const filePath = resolveSubagentArtifact(instance.cwd, instance.sessionFile, relative);
			if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
				sendText(response, 404, "Not found\n");
				return;
			}
			const bytes = fs.statSync(filePath).size;
			const truncated = bytes > MAX_SUBAGENT_FILE_BYTES;
			// Read at most MAX_SUBAGENT_FILE_BYTES bytes instead of the whole file: this
			// endpoint is polled every 2s while a run is active, and an unbounded
			// readFileSync on a large/growing transcript can stall the event loop for
			// the whole server (all instances) for the duration of the read.
			const content = readBoundedFile(filePath, bytes, MAX_SUBAGENT_FILE_BYTES);
			const contentType =
				path.extname(filePath).toLowerCase() === ".json" ? "application/json" : "text/plain; charset=utf-8";
			response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
			response.end(
				JSON.stringify({
					ok: true,
					path: relative,
					bytes: Math.min(bytes, MAX_SUBAGENT_FILE_BYTES),
					truncated,
					content: truncated
						? `${content.slice(0, MAX_SUBAGENT_FILE_BYTES)}\n\n[... truncated at ${MAX_SUBAGENT_FILE_BYTES} bytes]`
						: content,
				}),
			);
			return;
		}

		// Read-only file explorer (sidebar EXPLORER tree + file viewer).
		// GET /i/<id>/files?path=<relative> — directory listing, scoped to the instance's cwd.
		const filesMatch = /^\/i\/([0-9a-f-]{36})\/files$/.exec(url.pathname);
		if (request.method === "GET" && filesMatch) {
			const instance = supervisor.getLiveInstance(filesMatch[1]);
			if (!instance) {
				sendText(response, 404, "Unknown instance\n");
				return;
			}
			const relative = url.searchParams.get("path") ?? "";
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
			response.end(JSON.stringify(listExplorerDir(instance.cwd, relative)));
			return;
		}

		// GET /i/<id>/files/content?path=<relative> — file content, capped at EXPLORER_MAX_FILE_BYTES
		// and restricted to text-ish files (see isExplorerTextFile).
		const filesContentMatch = /^\/i\/([0-9a-f-]{36})\/files\/content$/.exec(url.pathname);
		if (request.method === "GET" && filesContentMatch) {
			const instance = supervisor.getLiveInstance(filesContentMatch[1]);
			if (!instance) {
				sendText(response, 404, "Unknown instance\n");
				return;
			}
			const relative = url.searchParams.get("path") ?? "";
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
			response.end(JSON.stringify(readExplorerFile(instance.cwd, relative)));
			return;
		}

		// Terminal API
		if (url.pathname === "/api/bash" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { command, cwd } = JSON.parse(body) as { command: string; cwd?: string };
				try {
					const stdout = execSync(command, {
						cwd: cwd || process.cwd(),
						encoding: "utf-8",
						maxBuffer: 10 * 1024 * 1024,
						timeout: 30_000,
					});
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ ok: true, output: stdout }));
				} catch (error) {
					const err = error as { stdout?: string; stderr?: string; message?: string };
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							ok: false,
							output: (err.stdout || "") + (err.stderr || ""),
							error: err.message || String(error),
						}),
					);
				}
			});
			return;
		}

		// Cranium review API — all endpoints accept ?repo= or body.repo to set the working directory
		function reviewCwd(url: URL, bodyRepo?: string): string | undefined {
			return bodyRepo || url.searchParams.get("repo") || undefined;
		}
		if (url.pathname === "/api/review/status" && request.method === "GET") {
			const cwd = reviewCwd(url);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(runCranium(["review", "status", "--json"], { cwd })));
			return;
		}
		if (url.pathname === "/api/review/start" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { base, head, repo, createPr } = JSON.parse(body) as {
					base?: string;
					head?: string;
					repo?: string;
					createPr?: boolean;
				};
				const args = ["review", "start"];
				if (base !== undefined || head !== undefined) {
					if (base === undefined || head === undefined) {
						response.writeHead(200, { "content-type": "application/json" });
						response.end(
							JSON.stringify({ ok: false, error: "Base and Head must both be set for a manual review" }),
						);
						return;
					}
					args.push("--base", base, "--head", head);
				} else if (createPr) {
					args.push("--create-pr");
				}
				if (repo) args.push("--repo", repo);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args, { cwd: repo || undefined })));
			});
			return;
		}
		if (url.pathname === "/api/review/next" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { session, repo } = JSON.parse(body || "{}") as { session?: string; repo?: string };
				const cwd = reviewCwd(url, repo);
				const args = ["review", "next", "--json"];
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args, { cwd })));
			});
			return;
		}
		if (url.pathname === "/api/review/diff" && request.method === "GET") {
			const filePath = url.searchParams.get("path");
			const session = url.searchParams.get("session");
			const cwd = reviewCwd(url);
			if (!filePath) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: false, error: "Missing path parameter" }));
				return;
			}
			const args = ["review", "diff", filePath];
			if (session) args.push("--session", session);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(runCranium(args, { cwd })));
			return;
		}
		if (url.pathname === "/api/review/mark" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const {
					path: filePath,
					session,
					expected,
					repo,
				} = JSON.parse(body) as {
					path: string;
					session?: string;
					expected?: string;
					repo?: string;
				};
				const cwd = reviewCwd(url, repo);
				const args = ["review", "mark", filePath];
				if (expected) args.push("--expected", expected);
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args, { cwd })));
			});
			return;
		}
		// Re-anchor the review to the repo's current HEAD, keeping existing checkpoints:
		// reviewed files whose content moved become changedSinceReview, and files touched
		// by new commits are added as unreviewed.
		if (url.pathname === "/api/review/refresh" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { session, repo } = JSON.parse(body || "{}") as { session?: string; repo?: string };
				const cwd = reviewCwd(url, repo);
				const args = ["review", "refresh", "--json"];
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args, { cwd })));
			});
			return;
		}
		if (url.pathname === "/api/review/clear" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { session, repo } = JSON.parse(body || "{}") as { session?: string; repo?: string };
				const cwd = reviewCwd(url, repo);
				const args = ["review", "clear", "--yes"];
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args, { cwd })));
			});
			return;
		}
		if (url.pathname === "/api/review/merge" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer | string) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const { base, session, repo, createPr } = JSON.parse(body) as {
					base: string;
					session?: string;
					repo?: string;
					createPr?: boolean;
				};
				const cwd = reviewCwd(url, repo);
				// --json keeps errors machine-readable on stdout and wraps success in { result }
				const args = ["review", "merge", "--base", base, "--yes", "--json"];
				// cranium cannot prompt here, so opting in to creation must be explicit
				if (createPr) args.push("--create-pr");
				if (session) args.push("--session", session);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(runCranium(args, { cwd })));
			});
			return;
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			sendText(response, 405, "Method not allowed\n");
			return;
		}

		if (url.pathname === "/") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			response.end(renderIndexPage());
			return;
		}

		if (url.pathname === "/review") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			response.end(renderReviewPage());
			return;
		}

		if (url.pathname === "/settings") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			response.end(renderSettingsPage());
			return;
		}

		if (url.pathname === "/terminal") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			response.end(renderTerminalPage());
			return;
		}

		if (url.pathname === "/themes") {
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
			response.end(JSON.stringify({ themes: listThemeNames() }));
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

		// Instance SPA paths (valid or not) fall through to index.html: an unknown or
		// stopped instance id still needs the app shell loaded so the client-side JS can
		// render a proper "session not found" state instead of a bare-text 404 page. The
		// WS upgrade handler below is what actually gates on instance liveness (closes
		// with code 4404), which the client uses to distinguish this from a transient drop.
		// Static assets are also served under each instance prefix so relative PWA
		// manifest/service-worker URLs keep the installed app scoped to that instance.
		const instanceMatch = INSTANCE_PATH_PATTERN.exec(url.pathname);
		const instancePrefix = instanceMatch ? `/i/${instanceMatch[1]}/` : undefined;
		const relativePath = decodeURIComponent(
			instancePrefix && url.pathname.startsWith(instancePrefix)
				? url.pathname.slice(instancePrefix.length)
				: url.pathname.replace(/^\/+/, ""),
		);
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
		const instanceMatch = INSTANCE_PATH_PATTERN.exec(url.pathname);
		const instanceId = instanceMatch?.[1];
		const isWsPath = instanceMatch !== null && url.pathname === `/i/${instanceId}/ws`;
		if (!isWsPath || !instanceId) {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			const stream = supervisor.openRpcStream(
				instanceId,
				(event) => {
					if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
				},
				(message) => {
					if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
				},
			);
			if (!stream) {
				ws.close(4404, "Unknown instance");
				return;
			}
			// Opening the stream counts as accessing the session, for the dashboard's
			// last-accessed sort order.
			supervisor.touchInstance(instanceId);
			ws.on("message", (data) => {
				void (async () => {
					try {
						const parsed = JSON.parse(data.toString()) as RpcCommand | RpcExtensionUIResponse;
						if (parsed.type === "extension_ui_response") {
							stream.handleUiResponse(parsed as RpcExtensionUIResponse);
							return;
						}
						const response = await stream.handleRpc(parsed as RpcCommand);
						if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
					} catch (error: unknown) {
						if (ws.readyState === ws.OPEN) {
							ws.send(
								JSON.stringify({
									type: "response",
									command: "parse",
									success: false,
									error: error instanceof Error ? error.message : String(error),
								}),
							);
						}
					}
				})();
			});
			ws.on("close", () => stream.close());
			ws.on("error", () => stream.close());
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
