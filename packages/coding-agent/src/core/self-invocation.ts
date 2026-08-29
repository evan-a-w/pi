/**
 * Resolve how to re-launch pi itself as a child process.
 *
 * Mirrors the pattern packages/server/src/rpc-process.ts uses to spawn
 * rpc-entry.js (Bun binary re-execs itself; Node re-execs the built dist
 * entry; an unbuilt dev checkout falls back to tsx over the TypeScript
 * source), but targets this package's own interactive CLI entry (`cli.js`)
 * instead of `rpc-entry.js`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPackageDir, isBunBinary } from "../config.ts";

export interface PiSelfInvocation {
	/** Executable to spawn. */
	command: string;
	/** Arguments before any caller-supplied CLI flags. */
	args: string[];
}

/**
 * Resolve the command/args to launch pi's own interactive CLI.
 * - Bun binary: `process.execPath` is the compiled `pi` binary itself.
 * - Node, built: re-exec `dist/cli.js` with the current Node binary.
 * - Node, unbuilt dev checkout: run `src/cli.ts` via the repo's local tsx.
 */
export function resolvePiSelfInvocation(): PiSelfInvocation {
	if (isBunBinary) {
		return { command: process.execPath, args: [] };
	}

	const packageDir = getPackageDir();
	const distCli = join(packageDir, "dist", "cli.js");
	if (existsSync(distCli)) {
		return { command: process.execPath, args: [distCli] };
	}

	// Unbuilt dev checkout: packageDir is packages/coding-agent, two levels below repo root.
	const repoRoot = dirname(dirname(packageDir));
	const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
	const srcCli = join(packageDir, "src", "cli.ts");
	return {
		command: process.execPath,
		args: [tsxBin, "--tsconfig", join(repoRoot, "tsconfig.json"), srcCli],
	};
}
