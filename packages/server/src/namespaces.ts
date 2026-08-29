/**
 * Account namespaces: local, non-security groupings of sessions that each get
 * their own PI_CODING_AGENT_DIR tree (provider credentials, settings, sessions).
 * See getNamespaceAgentDir in config.ts for the on-disk layout.
 */
import { spawn } from "node:child_process";
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getNamespaceAgentDir, isBunBinary, isValidNamespaceName } from "./config.ts";
import { loadInstances, loadNamespaces, saveNamespaces, withNamespacesLock } from "./storage.ts";
import type { NamespaceRecord } from "./types.ts";

export const DEFAULT_NAMESPACE = "default";

/** undefined/empty/"default" all mean the implicit default namespace. */
export function normalizeNamespace(name: string | undefined): string {
	return name?.trim() || DEFAULT_NAMESPACE;
}

export function isDefaultNamespace(name: string | undefined): boolean {
	return normalizeNamespace(name) === DEFAULT_NAMESPACE;
}

/** The value to store on an InstanceRecord for a (already normalized) target namespace. */
export function storedNamespaceValue(name: string): string | undefined {
	return name === DEFAULT_NAMESPACE ? undefined : name;
}

/**
 * PI_CODING_AGENT_DIR override for a namespace's session processes, or
 * undefined for the implicit default (uses the normal ~/.pi/agent unchanged).
 */
export function namespaceAgentDirOverride(name: string | undefined): string | undefined {
	const normalized = normalizeNamespace(name);
	return normalized === DEFAULT_NAMESPACE ? undefined : getNamespaceAgentDir(normalized);
}

/** All namespaces, always including the implicit "default" first. */
export function listNamespaces(): NamespaceRecord[] {
	return [{ name: DEFAULT_NAMESPACE, createdAt: "" }, ...loadNamespaces()];
}

export function namespaceExists(name: string): boolean {
	return name === DEFAULT_NAMESPACE || loadNamespaces().some((namespace) => namespace.name === name);
}

export type NamespaceResolution = { ok: true; namespace: string } | { ok: false; error: string };

/**
 * Normalize and validate a client-supplied namespace name for a REST entry point:
 * the implicit default is always valid; anything else must already exist in the
 * registry. Every endpoint that accepts a namespace from a request body must call
 * this before using the value for anything - especially before
 * ServerSupervisor.ensureRecordForSessionFile, whose result can flow into
 * spawnInstance -> getNamespaceAgentDir.
 */
export function resolveRequestNamespace(raw: string | undefined): NamespaceResolution {
	const namespace = normalizeNamespace(raw);
	if (namespace !== DEFAULT_NAMESPACE && !namespaceExists(namespace)) {
		return { ok: false, error: `Unknown namespace: ${namespace}` };
	}
	return { ok: true, namespace };
}

/**
 * Packages every new namespace starts with, so core workflows (subagents,
 * Anthropic login) work without manual per-namespace installs. Installed in the
 * background after creation via `pi install`, which also records them in the
 * namespace's own settings.json.
 */
const DEFAULT_NAMESPACE_PACKAGES = ["npm:pi-subagents", "npm:@gotgenes/pi-anthropic-auth"];

function piCliInvocation(): { command: string; args: string[] } {
	if (isBunBinary) {
		return {
			command: join(dirname(process.execPath), process.platform === "win32" ? "pi.exe" : "pi"),
			args: [],
		};
	}
	// Same resolution as rpc-process.ts getSpawnCommand, pointed at the CLI entry.
	const srcDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot = dirname(dirname(dirname(srcDir)));
	const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
	const rpcEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
	return {
		command: process.execPath,
		args: [tsxBin, "--tsconfig", join(repoRoot, "tsconfig.json"), join(dirname(rpcEntry), "cli.js")],
	};
}

/**
 * Fire-and-forget install of the default packages into a namespace's agent
 * dir. Sequential (npm registry + settings.json writes), logged on failure,
 * never blocks the create endpoint. Sessions spawned before it finishes just
 * load the packages on their next restart.
 */
function installDefaultPackages(name: string): void {
	const { command, args } = piCliInvocation();
	const env = { ...process.env, PI_CODING_AGENT_DIR: getNamespaceAgentDir(name) };
	const runNext = (index: number): void => {
		if (index >= DEFAULT_NAMESPACE_PACKAGES.length) return;
		const pkg = DEFAULT_NAMESPACE_PACKAGES[index];
		const child = spawn(command, [...args, "install", pkg], { env, stdio: "ignore" });
		child.on("exit", (code) => {
			if (code !== 0) {
				console.error(`namespace ${name}: default package install failed for ${pkg} (exit ${code})`);
			}
			runNext(index + 1);
		});
		child.on("error", (error) => {
			console.error(`namespace ${name}: default package install failed for ${pkg}: ${error.message}`);
			runNext(index + 1);
		});
	};
	runNext(0);
}

export type CreateNamespaceResult = { ok: true; namespace: NamespaceRecord } | { ok: false; error: string };

export function createNamespace(nameRaw: string): CreateNamespaceResult {
	const name = nameRaw.trim();
	if (!isValidNamespaceName(name)) {
		return {
			ok: false,
			error: "Namespace name must be 1-32 characters: lowercase letters, digits, - or _",
		};
	}
	return withNamespacesLock(() => {
		if (namespaceExists(name)) {
			return { ok: false, error: `Namespace "${name}" already exists` };
		}
		const record: NamespaceRecord = { name, createdAt: new Date().toISOString() };
		saveNamespaces([...loadNamespaces(), record]);
		installDefaultPackages(name);
		return { ok: true, namespace: record };
	});
}

/** True if any session .jsonl file exists anywhere under a directory tree (recursive). */
function hasSessionFilesUnder(dir: string): boolean {
	if (!existsSync(dir)) {
		return false;
	}
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				return true;
			}
		}
	}
	return false;
}

export type DeleteNamespaceResult = { ok: true } | { ok: false; error: string };

/**
 * Remove a namespace from the registry. Refuses for the implicit default, for
 * an unknown name, while any InstanceRecord still references it, or while any
 * session .jsonl file still exists on disk under its agent dir (a plain stop
 * forgets the InstanceRecord entirely while leaving the file behind, so
 * checking instances alone would let deletion silently hide those sessions
 * from the past-session scan). Never deletes the namespace's agent directory
 * (auth.json and other credentials) - only the registry entry, so recreating
 * the same name later picks the old credentials back up.
 */
export function deleteNamespace(name: string): DeleteNamespaceResult {
	if (isDefaultNamespace(name)) {
		return { ok: false, error: "The default namespace cannot be deleted" };
	}
	return withNamespacesLock(() => {
		const existing = loadNamespaces();
		if (!existing.some((namespace) => namespace.name === name)) {
			return { ok: false, error: `Unknown namespace: ${name}` };
		}
		const inUse = loadInstances().some((instance) => normalizeNamespace(instance.namespace) === name);
		if (inUse) {
			return { ok: false, error: `Namespace "${name}" still has sessions; move or delete them first` };
		}
		if (hasSessionFilesUnder(join(getNamespaceAgentDir(name), "sessions"))) {
			return {
				ok: false,
				error: `Namespace "${name}" still has session files on disk; move or delete them first`,
			};
		}
		saveNamespaces(existing.filter((namespace) => namespace.name !== name));
		return { ok: true };
	});
}
