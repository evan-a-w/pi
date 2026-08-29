import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { findTmux } from "../../src/core/terminal/tmux-cli.ts";
import { RpcBridge, type RpcClientConnection } from "../../src/modes/rpc/rpc-bridge.ts";
import { createHarness, type Harness } from "./harness.ts";

const tmuxPath = findTmux();
const describeTmux = tmuxPath ? describe : describe.skip;

interface TestClient {
	connection: RpcClientConnection;
	messages: Array<Record<string, unknown>>;
	responseFor(command: string): Record<string, unknown> | undefined;
}

function createTestClient(): TestClient {
	const messages: Array<Record<string, unknown>> = [];
	return {
		connection: {
			send: (message) => {
				messages.push(message as Record<string, unknown>);
			},
		},
		messages,
		responseFor: (command) =>
			messages.filter((m) => m.type === "response" && m.command === command).at(-1) as
				| Record<string, unknown>
				| undefined,
	};
}

describe("tui_* over RPC", () => {
	const harnesses: Harness[] = [];
	const bridges: RpcBridge[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (bridges.length > 0) {
			await bridges.pop()?.dispose();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function createSessionDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-tui-rpc-"));
		tempDirs.push(dir);
		return dir;
	}

	it("rejects tui_open when the session has no session file", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runtimeHost = { session: harness.session, setRebindSession: () => {} } as unknown as AgentSessionRuntime;
		const bridge = new RpcBridge(runtimeHost, {}, { bindExtensions: false });
		bridges.push(bridge);
		await bridge.start();
		const client = createTestClient();
		const handle = bridge.attachClient(client.connection);

		await handle.receive(JSON.stringify({ id: "1", type: "tui_open" }));

		const response = client.responseFor("tui_open");
		expect(response?.success).toBe(false);
		expect(response?.error).toContain("no session file");
	});

	describeTmux("with a persisted session and a stand-in TUI process (requires tmux)", () => {
		async function setup(): Promise<{
			bridge: RpcBridge;
			client: TestClient;
			receive: (command: object) => Promise<void>;
			switchSessionCalls: string[];
			sessionFile: string;
		}> {
			const cwd = createSessionDir();
			const sessionDir = join(cwd, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const sessionManager = SessionManager.create(cwd, sessionDir);
			const harness = await createHarness({ sessionManager });
			harnesses.push(harness);
			const sessionFile = harness.session.sessionFile;
			if (!sessionFile) throw new Error("expected a file-backed session for this test");

			const switchSessionCalls: string[] = [];
			const runtimeHost = {
				session: harness.session,
				setRebindSession: () => {},
				switchSession: async (path: string) => {
					switchSessionCalls.push(path);
					return { cancelled: false };
				},
			} as unknown as AgentSessionRuntime;

			// A long-lived stand-in for the real pi TUI process: this test only
			// exercises the RPC guard and cleanup around tui_open/close, not an
			// actual interactive pi session (which would need a real model/provider).
			const bridge = new RpcBridge(
				runtimeHost,
				{},
				{ bindExtensions: false, resolveTuiCommand: () => ["sleep", "60"] },
			);
			bridges.push(bridge);
			await bridge.start();
			const client = createTestClient();
			const handle = bridge.attachClient(client.connection);
			return {
				bridge,
				client,
				receive: (command: object) => handle.receive(JSON.stringify(command)),
				switchSessionCalls,
				sessionFile,
			};
		}

		it("opens a TUI terminal attached to the session", async () => {
			const { client, receive } = await setup();

			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });

			const response = client.responseFor("tui_open");
			expect(response?.success).toBe(true);
			const data = response?.data as { termId: string; cols: number; rows: number };
			expect(data.termId).toMatch(/^pi-\d+-[0-9a-f]+$/);
			expect(data.cols).toBe(80);
			expect(data.rows).toBe(24);
		});

		it("rejects prompt, steer, and follow_up while the TUI is open", async () => {
			const { client, receive } = await setup();
			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });

			await receive({ id: "2", type: "prompt", message: "hello" });
			const promptResponse = client.responseFor("prompt");
			expect(promptResponse?.success).toBe(false);
			expect(promptResponse?.error).toBe("TUI is attached to this session");

			await receive({ id: "3", type: "steer", message: "hello" });
			expect(client.responseFor("steer")?.success).toBe(false);

			await receive({ id: "4", type: "follow_up", message: "hello" });
			expect(client.responseFor("follow_up")?.success).toBe(false);
		});

		it("does not block read-only or terminal commands while the TUI is open", async () => {
			const { client, receive } = await setup();
			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });

			await receive({ id: "2", type: "get_state" });
			expect(client.responseFor("get_state")?.success).toBe(true);

			await receive({ id: "3", type: "get_messages" });
			expect(client.responseFor("get_messages")?.success).toBe(true);
		});

		it("reloads the session from disk and unblocks writes on tui_close", async () => {
			const { client, receive, switchSessionCalls, sessionFile } = await setup();
			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });

			await receive({ id: "2", type: "tui_close" });
			expect(client.responseFor("tui_close")?.success).toBe(true);
			expect(switchSessionCalls).toEqual([sessionFile]);

			await receive({ id: "3", type: "tui_input", data: "AA==" });
			expect(client.responseFor("tui_input")?.success).toBe(false);
		});

		it("blocks every session-mutating command while the TUI is open, not just prompt/steer/follow_up", async () => {
			const { client, receive } = await setup();
			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });

			const blocked: Array<Record<string, unknown>> = [
				{ id: "2", type: "new_session" },
				{ id: "3", type: "switch_session", sessionPath: "/tmp/does-not-matter.jsonl" },
				{ id: "4", type: "fork", entryId: "some-entry" },
				{ id: "5", type: "clone" },
				{ id: "6", type: "change_cwd", cwd: "/tmp" },
				{ id: "7", type: "compact" },
				{ id: "8", type: "set_session_name", name: "renamed" },
			];
			for (const command of blocked) {
				await receive(command);
				const response = client.responseFor(command.type as string);
				expect(response?.success, `${command.type} should be blocked while a TUI is attached`).toBe(false);
				expect(response?.error).toBe("TUI is attached to this session");
			}

			// Reads and bridge-local settings are unaffected, matching the existing
			// "does not block read-only or terminal commands" test above.
			await receive({ id: "9", type: "set_thinking_level", level: "low" });
			expect(client.responseFor("set_thinking_level")?.success).toBe(true);
		});

		it("dedupes concurrent tui_open calls instead of spawning a second TUI process", async () => {
			const { client, receive } = await setup();

			// Fire two tui_open commands without awaiting the first, mirroring the real
			// (unawaited) ws message handler: both see the in-flight creation and reattach
			// to it instead of racing TmuxTerminal.create() twice.
			const first = receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });
			const second = receive({ id: "2", type: "tui_open", cols: 80, rows: 24 });
			await Promise.all([first, second]);

			const firstResponse = client.messages.find((m) => m.id === "1") as { data?: { termId: string } } | undefined;
			const secondResponse = client.messages.find((m) => m.id === "2") as { data?: { termId: string } } | undefined;
			expect(firstResponse?.data?.termId).toBeDefined();
			expect(secondResponse?.data?.termId).toBe(firstResponse?.data?.termId);
		});

		it("broadcasts tui_exit to other attached clients on tui_close, but not to the closer", async () => {
			const { bridge, client, receive } = await setup();
			const other = createTestClient();
			bridge.attachClient(other.connection);

			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });
			await receive({ id: "2", type: "tui_close" });

			expect(client.responseFor("tui_close")?.success).toBe(true);
			// The closer already handles this locally (see toggleTui in the web client);
			// a broadcast back to it would be a duplicate toast/resync.
			expect(client.messages.some((m) => m.type === "tui_exit")).toBe(false);
			// Every other client attached to the same session must learn the TUI is gone.
			const exitMessage = other.messages.find((m) => m.type === "tui_exit") as { reason?: string } | undefined;
			expect(exitMessage).toBeDefined();
			expect(exitMessage?.reason).toBe("closed");
		});

		it("reloads the session and notifies clients while the TUI is still open, when the session file changes", async () => {
			const { client, receive, switchSessionCalls, sessionFile } = await setup();
			await receive({ id: "1", type: "tui_open", cols: 80, rows: 24 });

			// Simulate the TUI (a separate process) writing to the session file, e.g.
			// switching models from its own selector.
			appendFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "model_change",
					id: "ext-write",
					parentId: null,
					timestamp: new Date().toISOString(),
					provider: "faux",
					modelId: "faux-2",
				})}\n`,
			);

			// Debounced ~300ms; give it slack for the reload itself to complete.
			await new Promise((resolve) => setTimeout(resolve, 700));

			expect(switchSessionCalls).toEqual([sessionFile]);
			expect(client.messages.some((m) => m.type === "session_reloaded")).toBe(true);
			// tui_exit/tui_close were not sent: the TUI is still attached, so it's still blocking writes.
			expect(client.messages.some((m) => m.type === "tui_exit")).toBe(false);

			await receive({ id: "2", type: "prompt", message: "hello" });
			expect(client.responseFor("prompt")?.success).toBe(false);
		});
	});
});
