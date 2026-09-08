import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDashboardSettingsPath } from "../src/config.ts";
import {
	getDashboardSettings,
	MAX_SNIPPET_NAME_LENGTH,
	MAX_SNIPPET_TEXT_LENGTH,
	MAX_SNIPPETS,
	updateDashboardSettings,
} from "../src/settings.ts";
import { type ServerWebHandle, startServerWeb } from "../src/web.ts";

let serverDir: string;
let previousServerDir: string | undefined;
let previousRadiusApiKey: string | undefined;

beforeEach(() => {
	previousServerDir = process.env.PI_SERVER_DIR;
	serverDir = mkdtempSync(join(tmpdir(), "pi-server-settings-test-"));
	process.env.PI_SERVER_DIR = serverDir;
	previousRadiusApiKey = process.env.RADIUS_API_KEY;
	delete process.env.RADIUS_API_KEY;
});

afterEach(() => {
	if (previousServerDir === undefined) {
		delete process.env.PI_SERVER_DIR;
	} else {
		process.env.PI_SERVER_DIR = previousServerDir;
	}
	if (previousRadiusApiKey !== undefined) {
		process.env.RADIUS_API_KEY = previousRadiusApiKey;
	}
	rmSync(serverDir, { recursive: true, force: true });
});

describe("dashboard settings storage", () => {
	it("defaults to an empty snippet list when the file does not exist", () => {
		expect(existsSync(getDashboardSettingsPath())).toBe(false);
		expect(getDashboardSettings()).toEqual({ snippets: [] });
	});

	it("round-trips defaultCwd and snippets with server-assigned ids", () => {
		const result = updateDashboardSettings({
			defaultCwd: "  ~/projects  ",
			snippets: [{ name: " Greeting ", text: "hello there" }],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.settings.defaultCwd).toBe("~/projects");
		expect(result.settings.snippets).toHaveLength(1);
		expect(result.settings.snippets[0].name).toBe("Greeting");
		expect(result.settings.snippets[0].id).toMatch(/^[0-9a-f-]{36}$/);

		const onDisk = JSON.parse(readFileSync(getDashboardSettingsPath(), "utf-8"));
		expect(onDisk).toEqual(result.settings);
		expect(getDashboardSettings()).toEqual(result.settings);
	});

	it("keeps omitted fields unchanged on partial updates", () => {
		updateDashboardSettings({ defaultCwd: "/work", snippets: [{ name: "a", text: "b" }] });
		const cwdOnly = updateDashboardSettings({ defaultCwd: "/other" });
		expect(cwdOnly.ok && cwdOnly.settings.snippets).toHaveLength(1);
		const snippetsOnly = updateDashboardSettings({ snippets: [] });
		expect(snippetsOnly.ok && snippetsOnly.settings.defaultCwd).toBe("/other");
	});

	it("preserves submitted snippet ids so edits do not churn identity", () => {
		const first = updateDashboardSettings({ snippets: [{ name: "a", text: "b" }] });
		if (!first.ok) throw new Error("setup failed");
		const id = first.settings.snippets[0].id;
		const second = updateDashboardSettings({ snippets: [{ id, name: "renamed", text: "b" }] });
		expect(second.ok && second.settings.snippets[0].id).toBe(id);
	});

	it("clears defaultCwd when set to empty", () => {
		updateDashboardSettings({ defaultCwd: "/work" });
		const cleared = updateDashboardSettings({ defaultCwd: "" });
		expect(cleared.ok && cleared.settings.defaultCwd).toBeUndefined();
	});

	it("rejects invalid shapes and limits", () => {
		expect(updateDashboardSettings({ defaultCwd: 5 }).ok).toBe(false);
		expect(updateDashboardSettings({ snippets: "nope" }).ok).toBe(false);
		expect(updateDashboardSettings({ snippets: [{ name: "", text: "x" }] }).ok).toBe(false);
		expect(updateDashboardSettings({ snippets: [{ name: "x", text: "   " }] }).ok).toBe(false);
		expect(updateDashboardSettings({ snippets: [{ name: "x".repeat(MAX_SNIPPET_NAME_LENGTH + 1), text: "x" }] }).ok).toBe(
			false,
		);
		expect(updateDashboardSettings({ snippets: [{ name: "x", text: "x".repeat(MAX_SNIPPET_TEXT_LENGTH + 1) }] }).ok).toBe(
			false,
		);
		const tooMany = Array.from({ length: MAX_SNIPPETS + 1 }, (_, i) => ({ name: `s${i}`, text: "t" }));
		expect(updateDashboardSettings({ snippets: tooMany }).ok).toBe(false);
		// Nothing was persisted by any rejected update.
		expect(getDashboardSettings()).toEqual({ snippets: [] });
	});
});

describe("dashboard settings over HTTP", () => {
	let handle: ServerWebHandle;
	let baseUrl: string;

	beforeEach(async () => {
		handle = await startServerWeb({ host: "127.0.0.1", port: 0 });
		baseUrl = `http://127.0.0.1:${handle.port}`;
	});

	afterEach(async () => {
		await handle.close();
	});

	it("serves GET /api/settings and /api/snippets, and PUT persists", async () => {
		const put = await fetch(`${baseUrl}/api/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ defaultCwd: "~/code", snippets: [{ name: "Review", text: "Please review:" }] }),
		});
		expect(put.status).toBe(200);
		const putBody = (await put.json()) as { ok: boolean; settings: { defaultCwd?: string } };
		expect(putBody.ok).toBe(true);
		expect(putBody.settings.defaultCwd).toBe("~/code");

		const get = (await (await fetch(`${baseUrl}/api/settings`)).json()) as {
			ok: boolean;
			settings: { snippets: Array<{ name: string }> };
		};
		expect(get.ok).toBe(true);
		expect(get.settings.snippets.map((s) => s.name)).toEqual(["Review"]);

		const snippets = (await (await fetch(`${baseUrl}/api/snippets`)).json()) as {
			ok: boolean;
			snippets: Array<{ id: string; name: string; text: string }>;
		};
		expect(snippets.ok).toBe(true);
		expect(snippets.snippets[0]).toMatchObject({ name: "Review", text: "Please review:" });
	});

	it("rejects a bad PUT body with 400 and does not persist", async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ snippets: [{ name: "", text: "x" }] }),
		});
		expect(res.status).toBe(400);
		expect(getDashboardSettings()).toEqual({ snippets: [] });
	});

	it("renders the settings page and prefills the spawn form with defaultCwd", async () => {
		updateDashboardSettings({ defaultCwd: "/srv/projects" });
		const settingsHtml = await (await fetch(`${baseUrl}/settings`)).text();
		expect(settingsHtml).toContain("settings-default-cwd");
		expect(settingsHtml).toContain('value="/srv/projects"');

		const indexHtml = await (await fetch(`${baseUrl}/`)).text();
		expect(indexHtml).toContain('href="/settings"');
		expect(indexHtml).toContain('id="spawn-cwd"');
		expect(indexHtml).toContain('value="/srv/projects"');
	});
});
