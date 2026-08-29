import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_DIR_NAME = ".pi";
const ENV_SERVER_DIR = "PI_SERVER_DIR";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

interface PackageJson {
	version?: string;
}

function getPackageJsonPath(): string {
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		const packageJsonPath = join(dir, "package.json");
		if (existsSync(packageJsonPath)) {
			return packageJsonPath;
		}
		dir = dirname(dir);
	}
	return join(__dirname, "package.json");
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

export const VERSION: string = pkg.version || "0.0.0";

/** Base `~/.pi` (or `$PI_CONFIG_DIR`) directory shared by the server dir and namespace agent dirs. */
export function getPiBaseDir(): string {
	return process.env.PI_CONFIG_DIR || join(homedir(), CONFIG_DIR_NAME);
}

export function getServerDir(): string {
	const envDir = process.env[ENV_SERVER_DIR];
	if (envDir) {
		return envDir;
	}

	return join(getPiBaseDir(), "server");
}

export function getAuthPath(): string {
	return join(getServerDir(), "auth.json");
}

export function getMachinePath(): string {
	return join(getServerDir(), "machine.json");
}

export function getInstancesPath(): string {
	return join(getServerDir(), "instances.json");
}

export function getNamespacesRegistryPath(): string {
	return join(getServerDir(), "namespaces.json");
}

/**
 * Account namespaces: separate PI_CODING_AGENT_DIR trees so each namespace has
 * its own provider credentials (auth.json), settings, and sessions directory.
 * The implicit "default" namespace is ~/.pi/agent (unchanged); named namespaces
 * live under ~/.pi/namespaces/<name>/agent. Name validation matches this pattern.
 */
export const NAMESPACE_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

export function isValidNamespaceName(name: string): boolean {
	return NAMESPACE_NAME_PATTERN.test(name);
}

/**
 * Agent dir for a named (non-default) namespace. Callers must not call this for
 * "default". Asserts the name against NAMESPACE_NAME_PATTERN as a hard defense-
 * in-depth check: every REST entry point must already validate/normalize the
 * namespace before it gets here, but a rejected name here can never turn into a
 * path.join escape out of ~/.pi/namespaces.
 */
export function getNamespaceAgentDir(name: string): string {
	if (!isValidNamespaceName(name)) {
		throw new Error(`Invalid namespace name: ${name}`);
	}
	return join(getPiBaseDir(), "namespaces", name, "agent");
}

export function getSocketPath(): string {
	return join(getServerDir(), "server.sock");
}
