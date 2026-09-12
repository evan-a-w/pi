#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as {
	version: string;
};

function printHelp(): void {
	console.log(
		`pi-server v${packageJson.version}\n\nUsage:\n  pi-server serve [--web [--web-port <port>] [--web-host <host>]]\n  pi-server --help\n  pi-server --version`,
	);
}

function getFlagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index === -1 || index + 1 >= args.length) {
		return undefined;
	}
	return args[index + 1];
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printHelp();
		process.exit(0);
	}

	if (args[0] === "--version" || args[0] === "-v") {
		console.log(packageJson.version);
		process.exit(0);
	}

	if (args[0] === "serve") {
		if (args.includes("--web")) {
			const webPortValue = getFlagValue(args, "--web-port");
			const webPort = webPortValue !== undefined ? Number(webPortValue) : undefined;
			if (webPort !== undefined && (!Number.isInteger(webPort) || webPort < 0 || webPort > 65535)) {
				console.error("--web-port requires an integer between 0 and 65535");
				process.exit(1);
			}
			await serve({ web: { host: getFlagValue(args, "--web-host"), port: webPort } });
			return;
		}
		await serve();
		return;
	}

	console.error(`Unknown command: ${args[0]}`);
	printHelp();
	process.exit(1);
}

await main();
