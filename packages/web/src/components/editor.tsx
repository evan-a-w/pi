import { computed, signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { ImageContent, RpcSlashCommand } from "../protocol.ts";
import {
	editorText,
	executeBuiltinCommand,
	pushToast,
	queue,
	sendAbort,
	sendBash,
	sendPrompt,
	sessionState,
	slashCommands,
	workingMessage,
} from "../state.ts";

const AUTOCOMPLETE_MAX_VISIBLE = 8;
const TUI_BUILTIN_COMMAND_ORDER = new Map(
	[
		"settings",
		"model",
		"scoped-models",
		"export",
		"import",
		"share",
		"web",
		"copy",
		"name",
		"session",
		"changelog",
		"hotkeys",
		"fork",
		"clone",
		"tree",
		"trust",
		"login",
		"logout",
		"new",
		"cd",
		"gas",
		"compact",
		"resume",
		"reload",
		"quit",
	].map((name, index): [string, number] => [name, index]),
);
const TUI_SOURCE_ORDER = {
	builtin: 0,
	prompt: 1,
	extension: 2,
	skill: 3,
} satisfies Record<RpcSlashCommand["source"], number>;

const pendingImages = signal<ImageContent[]>([]);
const autocompleteIndex = signal(0);
const autocompleteDismissed = signal(false);
const sending = signal(false);

// Snippet picker: reusable text chunks managed on the dashboard's /settings
// page (server-persisted), inserted at the composer cursor - never auto-sent.
interface Snippet {
	id: string;
	name: string;
	text: string;
}
const SNIPPET_CACHE_MS = 30_000;
const snippetPickerOpen = signal(false);
const snippetQuery = signal("");
const snippetIndex = signal(0);
const snippets = signal<Snippet[]>([]);
const snippetsLoading = signal(false);
let snippetsFetchedAt = 0;

async function loadSnippets(): Promise<void> {
	if (Date.now() - snippetsFetchedAt < SNIPPET_CACHE_MS) return;
	snippetsLoading.value = true;
	try {
		// Absolute path: works same-origin from under /i/<id>/.
		const response = await fetch("/api/snippets", { cache: "no-store" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = (await response.json()) as { ok?: boolean; snippets?: Snippet[] };
		snippets.value = data.snippets ?? [];
		snippetsFetchedAt = Date.now();
	} catch (error) {
		pushToast(`Failed to load snippets: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		snippetsLoading.value = false;
	}
}

const snippetMatches = computed(() => fuzzyFilter(snippets.value, snippetQuery.value, (snippet) => snippet.name));

function insertAtCursor(textarea: HTMLTextAreaElement | null, text: string): void {
	const current = editorText.value;
	const start = textarea?.selectionStart ?? current.length;
	const end = textarea?.selectionEnd ?? current.length;
	const before = current.slice(0, start);
	const after = current.slice(end);
	// Keep the snippet on its own line boundary when dropped mid-text.
	const lead = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
	const trail = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
	editorText.value = `${before}${lead}${text}${trail}${after}`;
	const caret = before.length + lead.length + text.length;
	queueMicrotask(() => {
		if (!textarea) return;
		textarea.focus();
		textarea.setSelectionRange(caret, caret);
	});
}

function fuzzyMatch(query: string, text: string): { matches: boolean; score: number } {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const matchQuery = (normalizedQuery: string): { matches: boolean; score: number } => {
		if (normalizedQuery.length === 0) {
			return { matches: true, score: 0 };
		}
		if (normalizedQuery.length > textLower.length) {
			return { matches: false, score: 0 };
		}

		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;

		for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i += 1) {
			if (textLower[i] === normalizedQuery[queryIndex]) {
				const isWordBoundary = i === 0 || /[\s_./:-]/.test(textLower[i - 1] ?? "");
				if (lastMatchIndex === i - 1) {
					consecutiveMatches += 1;
					score -= consecutiveMatches * 5;
				} else {
					consecutiveMatches = 0;
					if (lastMatchIndex >= 0) {
						score += (i - lastMatchIndex - 1) * 2;
					}
				}
				if (isWordBoundary) {
					score -= 10;
				}
				score += i * 0.1;
				lastMatchIndex = i;
				queryIndex += 1;
			}
		}

		if (queryIndex < normalizedQuery.length) {
			return { matches: false, score: 0 };
		}
		if (normalizedQuery === textLower) {
			score -= 100;
		}
		return { matches: true, score };
	};

	const primaryMatch = matchQuery(queryLower);
	if (primaryMatch.matches) {
		return primaryMatch;
	}

	const alphaNumericMatch = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/.exec(queryLower);
	const numericAlphaMatch = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/.exec(queryLower);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";
	if (!swappedQuery) {
		return primaryMatch;
	}

	const swappedMatch = matchQuery(swappedQuery);
	return swappedMatch.matches ? { matches: true, score: swappedMatch.score + 5 } : primaryMatch;
}

function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	const tokens = query
		.trim()
		.split(/[\s/]+/)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) {
		return items;
	}

	const results: Array<{ item: T; totalScore: number }> = [];
	for (const item of items) {
		let totalScore = 0;
		let allMatch = true;
		for (const token of tokens) {
			const match = fuzzyMatch(token, getText(item));
			if (!match.matches) {
				allMatch = false;
				break;
			}
			totalScore += match.score;
		}
		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((result) => result.item);
}

function getCommandSortIndex(command: RpcSlashCommand): number {
	if (command.source !== "builtin") {
		return 0;
	}
	return TUI_BUILTIN_COMMAND_ORDER.get(command.name) ?? TUI_BUILTIN_COMMAND_ORDER.size;
}

function sortCommandsLikeTui(commands: RpcSlashCommand[]): RpcSlashCommand[] {
	return commands
		.map((command, index) => ({ command, index }))
		.sort((a, b) => {
			const sourceDelta = TUI_SOURCE_ORDER[a.command.source] - TUI_SOURCE_ORDER[b.command.source];
			if (sourceDelta !== 0) {
				return sourceDelta;
			}
			const commandDelta = getCommandSortIndex(a.command) - getCommandSortIndex(b.command);
			return commandDelta !== 0 ? commandDelta : a.index - b.index;
		})
		.map((entry) => entry.command);
}

function formatAutocompleteDescription(command: RpcSlashCommand): string | undefined {
	if (!command.argumentHint) {
		return command.description;
	}
	return command.description ? `${command.argumentHint} — ${command.description}` : command.argumentHint;
}

const autocompleteQuery = computed(() => {
	const text = editorText.value;
	if (!text.startsWith("/") || text.includes(" ") || autocompleteDismissed.value) {
		return undefined;
	}
	return text.slice(1);
});

const autocompleteMatches = computed(() => {
	const query = autocompleteQuery.value;
	if (query === undefined) return [];
	return fuzzyFilter(sortCommandsLikeTui(slashCommands.value), query, (command) => command.name);
});

const autocompleteOpen = computed(() => autocompleteMatches.value.length > 0);

function getSelectedAutocompleteIndex(matches: RpcSlashCommand[]): number {
	return matches.length === 0 ? -1 : Math.min(autocompleteIndex.value, matches.length - 1);
}

const visibleAutocompleteMatches = computed(() => {
	const matches = autocompleteMatches.value;
	const selectedIndex = getSelectedAutocompleteIndex(matches);
	if (selectedIndex === -1) return [];
	const startIndex = Math.max(
		0,
		Math.min(selectedIndex - Math.floor(AUTOCOMPLETE_MAX_VISIBLE / 2), matches.length - AUTOCOMPLETE_MAX_VISIBLE),
	);
	return matches.slice(startIndex, startIndex + AUTOCOMPLETE_MAX_VISIBLE).map((command, offset) => ({
		command,
		index: startIndex + offset,
	}));
});

const isBusy = computed(() => sessionState.value?.isStreaming === true || workingMessage.value !== undefined);

// On touch devices Enter inserts a newline (no Shift key on virtual keyboards);
// the send button is the send affordance. On desktop Enter sends.
const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

function readFileAsImage(file: File): Promise<ImageContent> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = String(reader.result);
			const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
			resolve({ type: "image", data: base64, mimeType: file.type || "image/png" });
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

async function send(): Promise<void> {
	const text = editorText.value.trim();
	const images = pendingImages.value;
	if (sending.value || (text === "" && images.length === 0)) return;
	if (text === "") return;
	sending.value = true;
	editorText.value = "";
	pendingImages.value = [];
	autocompleteDismissed.value = false;
	try {
		if (text.startsWith("!")) {
			await sendBash(text.slice(1));
			return;
		}
		if (text.startsWith("/") && (await executeBuiltinCommand(text))) {
			return;
		}
		await sendPrompt(text, images);
	} catch (error) {
		pushToast(error instanceof Error ? error.message : String(error), "error");
	} finally {
		sending.value = false;
	}
}

export function Editor() {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const pickerRef = useRef<HTMLDivElement>(null);

	const autoGrow = () => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	};

	const closeSnippetPicker = () => {
		snippetPickerOpen.value = false;
		snippetQuery.value = "";
		snippetIndex.value = 0;
	};

	const chooseSnippet = (snippet: Snippet) => {
		insertAtCursor(textareaRef.current, snippet.text);
		closeSnippetPicker();
		queueMicrotask(autoGrow);
	};

	const openSnippetPicker = () => {
		snippetPickerOpen.value = true;
		snippetIndex.value = 0;
		void loadSnippets();
	};

	// Close on outside click.
	useEffect(() => {
		if (!snippetPickerOpen.value) return;
		const onMouseDown = (event: MouseEvent) => {
			if (!pickerRef.current?.contains(event.target as Node)) closeSnippetPicker();
		};
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [snippetPickerOpen.value]);

	const handleSnippetKeyDown = (event: KeyboardEvent) => {
		const matches = snippetMatches.value;
		if (event.key === "Escape") {
			event.preventDefault();
			closeSnippetPicker();
			textareaRef.current?.focus();
			return;
		}
		if (event.key === "ArrowDown" && matches.length > 0) {
			event.preventDefault();
			snippetIndex.value = (snippetIndex.value + 1) % matches.length;
			return;
		}
		if (event.key === "ArrowUp" && matches.length > 0) {
			event.preventDefault();
			snippetIndex.value = (snippetIndex.value - 1 + matches.length) % matches.length;
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const selected = matches[Math.min(snippetIndex.value, matches.length - 1)];
			if (selected) chooseSnippet(selected);
		}
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if (autocompleteOpen.value) {
			const matches = autocompleteMatches.value;
			const selectedIndex = getSelectedAutocompleteIndex(matches);
			if (event.key === "ArrowDown") {
				event.preventDefault();
				autocompleteIndex.value = (selectedIndex + 1) % matches.length;
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				autocompleteIndex.value = (selectedIndex - 1 + matches.length) % matches.length;
				return;
			}
			if (event.key === "Tab" || event.key === "Enter") {
				event.preventDefault();
				const selected = matches[selectedIndex];
				if (selected) {
					editorText.value = `/${selected.name} `;
					autocompleteDismissed.value = true;
					autoGrow();
				}
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				autocompleteDismissed.value = true;
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey && !isCoarsePointer) {
			event.preventDefault();
			void send();
			return;
		}
		if (event.key === "Escape" && isBusy.value) {
			event.preventDefault();
			void sendAbort();
		}
	};

	const handlePaste = (event: ClipboardEvent) => {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			void readFileAsImage(file)
				.then((image) => {
					pendingImages.value = [...pendingImages.value, image];
				})
				.catch(() => pushToast("Failed to read pasted image", "error"));
		}
	};

	const queuedMessages = [...queue.value.steering, ...queue.value.followUp];

	return (
		<div class="editor-area">
			{queuedMessages.length > 0 && (
				<div class="queue-indicator">
					{queuedMessages.map((text, index) => (
						<div key={`${index}-${text}`} class="queue-entry">
							queued: {text}
						</div>
					))}
				</div>
			)}
			{pendingImages.value.length > 0 && (
				<div class="pending-images">
					{pendingImages.value.map((image, index) => (
						<button
							key={`${image.mimeType}-${index}`}
							type="button"
							class="pending-image"
							title="Remove image"
							onClick={() => {
								pendingImages.value = pendingImages.value.filter((_, i) => i !== index);
							}}
						>
							<img src={`data:${image.mimeType};base64,${image.data}`} alt="attachment" />
						</button>
					))}
				</div>
			)}
			{autocompleteOpen.value && (
				<div class="autocomplete">
					{visibleAutocompleteMatches.value.map(({ command, index }) => (
						<button
							key={`${command.source}:${command.name}`}
							type="button"
							class={`autocomplete-entry ${index === getSelectedAutocompleteIndex(autocompleteMatches.value) ? "selected" : ""}`}
							onMouseDown={(event) => {
								event.preventDefault();
								editorText.value = `/${command.name} `;
								autocompleteDismissed.value = true;
								textareaRef.current?.focus();
							}}
						>
							<span class="autocomplete-name">/{command.name}</span>
							{formatAutocompleteDescription(command) && (
								<span class="autocomplete-description">{formatAutocompleteDescription(command)}</span>
							)}
						</button>
					))}
					{autocompleteMatches.value.length > AUTOCOMPLETE_MAX_VISIBLE && (
						<div class="autocomplete-scroll-info">
							({getSelectedAutocompleteIndex(autocompleteMatches.value) + 1}/{autocompleteMatches.value.length})
						</div>
					)}
				</div>
			)}
			<div class="editor-row">
				{snippetPickerOpen.value && (
					<div class="snippet-picker" ref={pickerRef}>
						<input
							type="text"
							class="snippet-filter"
							placeholder="Filter snippets…"
							value={snippetQuery.value}
							// biome-ignore lint/a11y/noAutofocus: the picker is an explicitly opened popover
							autoFocus
							onInput={(event) => {
								snippetQuery.value = (event.target as HTMLInputElement).value;
								snippetIndex.value = 0;
							}}
							onKeyDown={handleSnippetKeyDown}
						/>
						<div class="snippet-list">
							{snippetsLoading.value && snippets.value.length === 0 ? (
								<div class="snippet-empty">Loading…</div>
							) : snippets.value.length === 0 ? (
								<div class="snippet-empty">
									No snippets yet — add some in <a href="/settings">Settings</a>
								</div>
							) : snippetMatches.value.length === 0 ? (
								<div class="snippet-empty">No matches</div>
							) : (
								snippetMatches.value.map((snippet, index) => (
									<button
										key={snippet.id}
										type="button"
										class={`snippet-entry ${index === Math.min(snippetIndex.value, snippetMatches.value.length - 1) ? "selected" : ""}`}
										onMouseDown={(event) => {
											event.preventDefault();
											chooseSnippet(snippet);
										}}
									>
										<span class="snippet-name">{snippet.name}</span>
										<span class="snippet-preview">{snippet.text.split("\n")[0]}</span>
									</button>
								))
							)}
						</div>
					</div>
				)}
				<button
					type="button"
					class={`editor-button snippets ${snippetPickerOpen.value ? "active" : ""}`}
					title="Insert snippet"
					onClick={() => (snippetPickerOpen.value ? closeSnippetPicker() : openSnippetPicker())}
				>
					{"{}"}
				</button>
				<textarea
					ref={textareaRef}
					class="editor-input"
					placeholder={isBusy.value ? "Steer the agent…" : "Send a message…"}
					rows={1}
					enterkeyhint={isCoarsePointer ? "enter" : "send"}
					value={editorText.value}
					onInput={(event) => {
						editorText.value = (event.target as HTMLTextAreaElement).value;
						autocompleteIndex.value = 0;
						if (!editorText.value.startsWith("/")) {
							autocompleteDismissed.value = false;
						}
						autoGrow();
					}}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
				/>
				{isBusy.value ? (
					<button type="button" class="editor-button abort" title="Abort (Esc)" onClick={() => void sendAbort()}>
						■
					</button>
				) : null}
				<button type="button" class="editor-button send" title="Send" onClick={() => void send()}>
					▲
				</button>
			</div>
		</div>
	);
}
