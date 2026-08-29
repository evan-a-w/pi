/**
 * Model-generated session titles.
 *
 * When a session has no explicit name, a short descriptive title is generated
 * from the first user message and the first assistant reply, using the same
 * summarization choke point as compaction (completeSummarization). This keeps
 * the call isolated (no cache writes, standalone request) and covered by the
 * same retry-free failure handling: callers are expected to treat a thrown
 * error as "no title" and log it, never surface it to the user.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { completeSummarization } from "./compaction/compaction.ts";

const TITLE_SYSTEM_PROMPT =
	"You generate short descriptive titles for coding assistant conversations. " +
	"Respond with only the title text: 3 to 6 words, no quotes, no trailing punctuation, no markdown, no explanation.";

const MAX_TITLE_LENGTH = 60;
const MAX_INPUT_CHARS = 800;

export interface GenerateSessionTitleAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

function sanitizeTitle(raw: string): string | undefined {
	let title = raw
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
	if (!title) return undefined;
	if (title.length > MAX_TITLE_LENGTH) {
		title = title.slice(0, MAX_TITLE_LENGTH).trim();
	}
	return title || undefined;
}

/**
 * Generate a short (3-6 word) session title from the first user message and
 * the first assistant reply. Returns undefined if the model produced no usable
 * text. Throws on request failure; callers should catch and log.
 */
export async function generateSessionTitle(
	model: Model<any>,
	userText: string,
	assistantText: string,
	auth: GenerateSessionTitleAuth,
	streamFn?: StreamFn,
): Promise<string | undefined> {
	const prompt =
		`Conversation:\nUser: ${userText.slice(0, MAX_INPUT_CHARS)}\n` +
		`Assistant: ${assistantText.slice(0, MAX_INPUT_CHARS)}\n\n` +
		"Give a short descriptive title for this conversation (3-6 words).";

	const response = await completeSummarization(
		model,
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		},
		{ maxTokens: 20, apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: auth.signal },
		streamFn,
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Title generation failed");
	}

	return sanitizeTitle(contentText(response.content));
}
