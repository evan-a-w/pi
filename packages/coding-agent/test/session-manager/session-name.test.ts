import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager session name / auto-naming attempted marker", () => {
	it("getSessionName reflects the latest session_info entry", () => {
		const session = SessionManager.inMemory();
		expect(session.getSessionName()).toBeUndefined();

		session.appendSessionInfo("First");
		expect(session.getSessionName()).toBe("First");

		session.appendSessionInfo("Second");
		expect(session.getSessionName()).toBe("Second");
	});

	it("wasAutoNamingAttempted is false until a session_info entry marks an attempt", () => {
		const session = SessionManager.inMemory();
		expect(session.wasAutoNamingAttempted()).toBe(false);

		session.appendSessionInfo("Manual rename");
		expect(session.wasAutoNamingAttempted()).toBe(false);
	});

	it("a reservation entry (empty name, autoNamed) marks an attempt without setting a name", () => {
		const session = SessionManager.inMemory();
		session.appendSessionInfo("", { autoNamed: true });

		expect(session.getSessionName()).toBeUndefined();
		expect(session.wasAutoNamingAttempted()).toBe(true);
	});

	it("an auto-named title marks both the name and the attempted flag", () => {
		const session = SessionManager.inMemory();
		session.appendSessionInfo("", { autoNamed: true });
		session.appendSessionInfo("Fix Login Bug", { autoNamed: true });

		expect(session.getSessionName()).toBe("Fix Login Bug");
		expect(session.wasAutoNamingAttempted()).toBe(true);
	});

	it("persists the attempted marker across a fresh SessionManager loaded from the same file", () => {
		const source = SessionManager.create(process.cwd(), tmpdir());
		source.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		// Reservation written synchronously before the (slow) title request starts.
		source.appendSessionInfo("", { autoNamed: true });

		const sessionFile = source.getSessionFile();
		expect(sessionFile).toBeDefined();

		// A second SessionManager opened on the same file (simulating a session
		// reload / resume / new process while the first title generation is still
		// in flight) must see the reservation and not attempt naming again.
		const reopened = SessionManager.open(sessionFile as string);
		expect(reopened.getSessionName()).toBeUndefined();
		expect(reopened.wasAutoNamingAttempted()).toBe(true);
	});

	it("a user rename after a reservation entry resets wasAutoNamingAttempted only when cleared to empty", () => {
		const session = SessionManager.inMemory();
		session.appendSessionInfo("", { autoNamed: true });
		expect(session.wasAutoNamingAttempted()).toBe(true);

		// A real user rename (no autoNamed marker) is the latest entry now.
		session.appendSessionInfo("User Renamed");
		expect(session.getSessionName()).toBe("User Renamed");
		expect(session.wasAutoNamingAttempted()).toBe(false);

		// An explicit clear (empty name, not auto) also resets the attempted flag,
		// allowing auto-naming to run once more.
		session.appendSessionInfo("");
		expect(session.getSessionName()).toBeUndefined();
		expect(session.wasAutoNamingAttempted()).toBe(false);
	});
});
