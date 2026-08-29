/**
 * tmux discovery and one-shot command execution.
 *
 * The persistent web terminal is backed by a tmux session rather than a pty
 * native addon; see control-client.ts for the streaming half.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Minimum tmux version supporting `resize-window` on a detached session. */
const MIN_TMUX_VERSION = 2.9;

export class TmuxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TmuxUnavailableError";
	}
}

let cachedTmuxPath: string | null | undefined;

/**
 * Locate the tmux binary. Result is cached for the process lifetime; a missing
 * tmux is cached as null so repeated terminal_open attempts stay cheap.
 */
export function findTmux(): string | null {
	if (cachedTmuxPath !== undefined) return cachedTmuxPath;

	const explicit = process.env.PI_TMUX_PATH;
	if (explicit) {
		cachedTmuxPath = existsSync(explicit) ? explicit : null;
		return cachedTmuxPath;
	}

	for (const candidate of ["/usr/bin/tmux", "/usr/local/bin/tmux", "/opt/homebrew/bin/tmux"]) {
		if (existsSync(candidate)) {
			cachedTmuxPath = candidate;
			return cachedTmuxPath;
		}
	}

	// Fall back to a PATH search, so a tmux installed via nix, linuxbrew, asdf, or any
	// other non-default prefix is still found even though it isn't one of the hardcoded
	// candidates above.
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, "tmux");
		if (existsSync(candidate)) {
			cachedTmuxPath = candidate;
			return cachedTmuxPath;
		}
	}

	cachedTmuxPath = null;
	return cachedTmuxPath;
}

/** Reset the cached tmux lookup. Test-only seam. */
export function resetTmuxPathCache(): void {
	cachedTmuxPath = undefined;
}

/**
 * Parse a `tmux -V` version string ("tmux 3.2a", "tmux next-3.4") into a number.
 * Trailing letters are suffixes, not precision, so 3.2a compares equal to 3.2.
 */
export function parseTmuxVersion(output: string): number | undefined {
	const match = /(\d+)\.(\d+)/.exec(output);
	if (!match) return undefined;
	return Number.parseFloat(`${match[1]}.${match[2]}`);
}

export interface TmuxCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Run a one-shot tmux command. Never rejects on a non-zero exit. */
export function runTmux(tmuxPath: string, args: string[], timeoutMs = 5000): Promise<TmuxCommandResult> {
	return new Promise((resolve) => {
		execFile(
			tmuxPath,
			args,
			{ timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				// execFile reports a non-zero exit as an error carrying a numeric code;
				// spawn failures (ENOENT, timeout kill) carry a string code instead.
				let exitCode = 0;
				if (error) {
					const code = (error as NodeJS.ErrnoException).code;
					exitCode = typeof code === "number" ? code : 1;
				}
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
			},
		);
	});
}

/**
 * Resolve tmux, verifying it is new enough for the commands we depend on.
 * @throws TmuxUnavailableError with actionable installation guidance
 */
export async function requireTmux(): Promise<string> {
	const tmuxPath = findTmux();
	if (!tmuxPath) {
		throw new TmuxUnavailableError(
			"tmux is required for the web terminal but was not found.\n" +
				"Install it with your package manager (apt install tmux / brew install tmux),\n" +
				"or set PI_TMUX_PATH to its location.",
		);
	}

	const { stdout, exitCode } = await runTmux(tmuxPath, ["-V"]);
	if (exitCode !== 0) {
		throw new TmuxUnavailableError(`Found tmux at ${tmuxPath} but "tmux -V" failed.`);
	}
	const version = parseTmuxVersion(stdout);
	if (version !== undefined && version < MIN_TMUX_VERSION) {
		throw new TmuxUnavailableError(
			`tmux ${stdout.trim()} is too old for the web terminal (need ${MIN_TMUX_VERSION}+).`,
		);
	}
	return tmuxPath;
}

/**
 * Encode bytes as the hex pairs `send-keys -H` expects.
 * Hex is used for all input so control characters, escape sequences and
 * multi-byte UTF-8 share one code path with no key-name ambiguity.
 */
export function toSendKeysHex(data: Buffer): string[] {
	const hex: string[] = [];
	for (const byte of data) {
		hex.push(byte.toString(16).padStart(2, "0"));
	}
	return hex;
}

/**
 * Split hex pairs into batches that stay well clear of argv length limits.
 * Each pair becomes its own argv entry, so this bounds both count and length.
 */
export function chunkHexArgs(hex: string[], maxPerCommand = 512): string[][] {
	if (hex.length === 0) return [];
	const chunks: string[][] = [];
	for (let index = 0; index < hex.length; index += maxPerCommand) {
		chunks.push(hex.slice(index, index + maxPerCommand));
	}
	return chunks;
}
