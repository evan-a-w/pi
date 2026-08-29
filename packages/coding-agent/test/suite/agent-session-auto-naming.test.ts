import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * After the first turn (>=1 user + >=1 assistant message), an unnamed session
 * should get a short model-generated title via a background, non-blocking
 * completion, using the same path as AgentSession.setSessionName.
 */

function respondWith(harness: Harness, textForCall: (call: number) => string): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		const text = textForCall(callCount);
		queueMicrotask(() => {
			const message = {
				...fauxAssistantMessage(text),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

describe("AgentSession auto session naming", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("generates a title from the model after the first turn when unnamed", async () => {
		const harness = await createHarness({ settings: { autoNameSession: true } });
		harnesses.push(harness);

		const callCount = respondWith(harness, (call) => (call === 1 ? "Sure, here is how to fix it." : "Fix Login Bug"));

		await harness.session.prompt("How do I fix the login bug?");

		await vi.waitFor(() => {
			expect(harness.sessionManager.getSessionName()).toBe("Fix Login Bug");
		});

		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["Fix Login Bug"]);
		expect(callCount()).toBe(2);
	});

	it("does not run when the session already has a name", async () => {
		const harness = await createHarness({ settings: { autoNameSession: true } });
		harnesses.push(harness);
		harness.session.setSessionName("Existing Name");

		const callCount = respondWith(harness, () => "reply");

		await harness.session.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(harness.sessionManager.getSessionName()).toBe("Existing Name");
		expect(callCount()).toBe(1);
	});

	it("does not re-trigger on later turns once attempted", async () => {
		const harness = await createHarness({ settings: { autoNameSession: true } });
		harnesses.push(harness);

		const callCount = respondWith(harness, (call) => (call <= 2 ? `reply ${call}` : `title-ish ${call}`));

		await harness.session.prompt("first message");
		await vi.waitFor(() => expect(callCount()).toBe(2));

		await harness.session.prompt("second message");
		await new Promise((resolve) => setTimeout(resolve, 20));

		// Only the first turn's reply (1) plus the one title generation (2) plus the
		// second turn's reply (3): no second title-generation call.
		expect(callCount()).toBe(3);
	});

	it("is skippable via the autoNameSession setting", async () => {
		const harness = await createHarness({ settings: { autoNameSession: false } });
		harnesses.push(harness);

		const callCount = respondWith(harness, () => "reply");

		await harness.session.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(callCount()).toBe(1);
	});

	/**
	 * Regression: session names changing by themselves. Root cause was that a new
	 * AgentSession created by a session reload / resume / respawn while the first
	 * (async, non-blocking) title generation was still in flight had no way to see
	 * that naming had already started, so it ran its own independent generation,
	 * appending a second, likely different, title. The fix persists a reservation
	 * marker (session_info entry with autoNamed:true, empty name) synchronously
	 * before the slow title request starts, so any process that (re)loads the
	 * session file afterward sees the attempt and never retries.
	 */
	it("persists an attempted marker before title generation completes, so a reload of the same file never retries", async () => {
		const sessionDir = tmpdir();
		const harness = await createHarness({
			settings: { autoNameSession: true },
			sessionManager: SessionManager.create(process.cwd(), sessionDir),
		});
		harnesses.push(harness);

		let releaseTitle: (() => void) | undefined;
		let callCount = 0;
		harness.session.agent.streamFunction = (model) => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			const isTitleCall = callCount === 2;
			const push = () => {
				const message = {
					...fauxAssistantMessage(isTitleCall ? "Stale Title" : "reply"),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				stream.push({ type: "done", reason: "stop", message });
			};
			if (isTitleCall) {
				// Stall the title-generation call: simulates a reload/resume happening
				// while the request is still in flight.
				releaseTitle = push;
			} else {
				queueMicrotask(push);
			}
			return stream;
		};

		await harness.session.prompt("first message");
		await vi.waitFor(() => expect(callCount).toBe(2));

		// The reservation must already be on disk before the title request resolves.
		expect(harness.sessionManager.wasAutoNamingAttempted()).toBe(true);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();

		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reloaded = SessionManager.open(sessionFile as string);
		expect(reloaded.wasAutoNamingAttempted()).toBe(true);
		expect(reloaded.getSessionName()).toBeUndefined();

		// Once the stalled request finally resolves, the real title still lands
		// (this instance was not disposed, only "reloaded elsewhere").
		releaseTitle?.();
		await vi.waitFor(() => expect(harness.sessionManager.getSessionName()).toBe("Stale Title"));
	});

	it("aborts in-flight title generation on dispose, so a disposed (replaced) session never completes a stale write", async () => {
		const harness = await createHarness({ settings: { autoNameSession: true } });
		harnesses.push(harness);

		let releaseTitle: (() => void) | undefined;
		let callCount = 0;
		harness.session.agent.streamFunction = (model) => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			const isTitleCall = callCount === 2;
			const push = () => {
				const message = {
					...fauxAssistantMessage(isTitleCall ? "Stale Title" : "reply"),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				stream.push({ type: "done", reason: "stop", message });
			};
			if (isTitleCall) {
				releaseTitle = push;
			} else {
				queueMicrotask(push);
			}
			return stream;
		};

		await harness.session.prompt("first message");
		await vi.waitFor(() => expect(callCount).toBe(2));

		// Simulate the session being replaced (e.g. by switchSession on a reload)
		// while the title request is still in flight.
		harness.session.dispose();
		releaseTitle?.();
		await new Promise((resolve) => setTimeout(resolve, 20));

		// The abort must prevent the late write; only the reservation remains.
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(harness.sessionManager.wasAutoNamingAttempted()).toBe(true);
	});

	it("a user rename while generation is in flight is never overwritten by a late title", async () => {
		const harness = await createHarness({ settings: { autoNameSession: true } });
		harnesses.push(harness);

		let releaseTitle: (() => void) | undefined;
		let callCount = 0;
		harness.session.agent.streamFunction = (model) => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			const isTitleCall = callCount === 2;
			const push = () => {
				const message = {
					...fauxAssistantMessage(isTitleCall ? "Generated Title" : "reply"),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				stream.push({ type: "done", reason: "stop", message });
			};
			if (isTitleCall) {
				releaseTitle = push;
			} else {
				queueMicrotask(push);
			}
			return stream;
		};

		await harness.session.prompt("first message");
		await vi.waitFor(() => expect(callCount).toBe(2));

		harness.session.setSessionName("User Renamed");
		releaseTitle?.();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(harness.sessionManager.getSessionName()).toBe("User Renamed");
	});
});
