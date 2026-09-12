/**
 * Persisted dashboard settings: the spawn form's default working directory
 * and reusable text snippets (inserted into the chat composer from
 * packages/web's snippet picker). See storage.ts for the on-disk file and
 * config.ts getDashboardSettingsPath for its location.
 */
import { randomUUID } from "node:crypto";
import { loadDashboardSettings, saveDashboardSettings, withSettingsLock } from "./storage.ts";
import type { DashboardSettings, SnippetRecord } from "./types.ts";

export const MAX_SNIPPET_NAME_LENGTH = 80;
export const MAX_SNIPPET_TEXT_LENGTH = 20_000;
export const MAX_SNIPPETS = 200;

interface SnippetInput {
	id?: unknown;
	name?: unknown;
	text?: unknown;
}

export interface UpdateSettingsInput {
	defaultCwd?: unknown;
	snippets?: unknown;
}

export type UpdateSettingsResult = { ok: true; settings: DashboardSettings } | { ok: false; error: string };

function validateSnippet(
	input: SnippetInput,
	index: number,
): { ok: true; snippet: SnippetRecord } | { ok: false; error: string } {
	const name = typeof input.name === "string" ? input.name.trim() : "";
	const text = typeof input.text === "string" ? input.text : "";
	if (!name) {
		return { ok: false, error: `Snippet ${index + 1}: name is required` };
	}
	if (name.length > MAX_SNIPPET_NAME_LENGTH) {
		return { ok: false, error: `Snippet ${index + 1}: name exceeds ${MAX_SNIPPET_NAME_LENGTH} characters` };
	}
	if (!text.trim()) {
		return { ok: false, error: `Snippet ${index + 1}: text is required` };
	}
	if (text.length > MAX_SNIPPET_TEXT_LENGTH) {
		return { ok: false, error: `Snippet ${index + 1}: text exceeds ${MAX_SNIPPET_TEXT_LENGTH} characters` };
	}
	const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : randomUUID();
	return { ok: true, snippet: { id, name, text } };
}

/** Current settings, always with a snippets array (even if the file has never been written). */
export function getDashboardSettings(): DashboardSettings {
	return loadDashboardSettings();
}

/**
 * Validate and persist a (possibly partial) settings update: a field omitted
 * from `input` keeps its current stored value, so the settings page can save
 * the working-directory field and the snippet list independently without
 * clobbering the other. `snippets`, when present, always replaces the full
 * list (entries keep their submitted id, new entries get a server-assigned
 * randomUUID) - the caller is expected to resend the full list including
 * unmodified entries, matching how the settings page renders it.
 */
export function updateDashboardSettings(input: UpdateSettingsInput): UpdateSettingsResult {
	if (input.defaultCwd !== undefined && typeof input.defaultCwd !== "string") {
		return { ok: false, error: "defaultCwd must be a string" };
	}
	if (input.snippets !== undefined && !Array.isArray(input.snippets)) {
		return { ok: false, error: "snippets must be an array" };
	}
	const snippetsInput = input.snippets as unknown[] | undefined;
	if (snippetsInput !== undefined && snippetsInput.length > MAX_SNIPPETS) {
		return { ok: false, error: `Too many snippets (max ${MAX_SNIPPETS})` };
	}

	let validatedSnippets: SnippetRecord[] | undefined;
	if (snippetsInput !== undefined) {
		validatedSnippets = [];
		for (let i = 0; i < snippetsInput.length; i++) {
			const entry = snippetsInput[i];
			if (!entry || typeof entry !== "object") {
				return { ok: false, error: `Snippet ${i + 1}: invalid` };
			}
			const result = validateSnippet(entry as SnippetInput, i);
			if (!result.ok) {
				return result;
			}
			validatedSnippets.push(result.snippet);
		}
	}

	return withSettingsLock(() => {
		const current = loadDashboardSettings();
		const defaultCwd = input.defaultCwd !== undefined ? (input.defaultCwd as string).trim() : current.defaultCwd;
		const next: DashboardSettings = {
			snippets: validatedSnippets ?? current.snippets,
			...(defaultCwd ? { defaultCwd } : {}),
		};
		saveDashboardSettings(next);
		return { ok: true, settings: next };
	});
}
