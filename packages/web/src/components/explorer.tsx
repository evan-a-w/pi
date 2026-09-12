/**
 * Read-only file explorer: a lazy-loading directory tree in the sidebar
 * (GET /i/<id>/files) and a simple viewer that replaces the chat area when a
 * file is opened (GET /i/<id>/files/content). See packages/server/src/web.ts
 * for the endpoints; both are scoped to the instance's cwd.
 */

import { signal } from "@preact/signals";
import { basePath, instanceId } from "../state.ts";

interface FileEntry {
	name: string;
	type: "dir" | "file";
	size?: number;
}

const explorerOpen = signal(false);
const dirEntries = signal<Record<string, FileEntry[] | undefined>>({});
const dirErrors = signal<Record<string, string>>({});
const dirLoading = signal<Record<string, boolean>>({});
const expandedDirs = signal<Set<string>>(new Set());

export const openFilePath = signal<string | undefined>(undefined);
export const openFileContent = signal<string | undefined>(undefined);
export const openFileError = signal<string | undefined>(undefined);
export const openFileLoading = signal(false);

/**
 * Explorer endpoints are absolute (`${basePath}...`, e.g. `/i/<id>/files?path=`)
 * so they always hit pi-server's instance-scoped routes rather than resolving
 * relative to whatever path the SPA happens to be on. A non-JSON response
 * (e.g. an HTML error page from an unrelated proxy/gateway in front of the
 * server) is reported as a friendly message instead of a raw JSON parse error.
 */
async function fetchJson<T>(path: string): Promise<{ data?: T; error?: string }> {
	try {
		const response = await fetch(`${basePath}${path}`, { cache: "no-store" });
		if (!response.ok) {
			return { error: `Failed to load (HTTP ${response.status})` };
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			return { error: "Unexpected response from server" };
		}
		const data = (await response.json()) as ({ ok?: boolean; error?: string } & T) | undefined;
		if (!data || data.ok === false) {
			return { error: data?.error ?? `HTTP ${response.status}` };
		}
		return { data };
	} catch {
		return { error: "Failed to reach the server" };
	}
}

async function loadDir(relPath: string): Promise<void> {
	dirLoading.value = { ...dirLoading.value, [relPath]: true };
	const result = await fetchJson<{ entries: FileEntry[] }>(`files?path=${encodeURIComponent(relPath)}`);
	dirLoading.value = { ...dirLoading.value, [relPath]: false };
	if (result.error) {
		dirErrors.value = { ...dirErrors.value, [relPath]: result.error };
		return;
	}
	dirEntries.value = { ...dirEntries.value, [relPath]: result.data?.entries ?? [] };
}

async function openFile(relPath: string): Promise<void> {
	openFilePath.value = relPath;
	openFileContent.value = undefined;
	openFileError.value = undefined;
	openFileLoading.value = true;
	const result = await fetchJson<{ content: string }>(`files/content?path=${encodeURIComponent(relPath)}`);
	openFileLoading.value = false;
	if (result.error) {
		openFileError.value = result.error;
		return;
	}
	openFileContent.value = result.data?.content ?? "";
}

export function closeFileViewer(): void {
	openFilePath.value = undefined;
	openFileContent.value = undefined;
	openFileError.value = undefined;
}

function toggleDir(relPath: string): void {
	const next = new Set(expandedDirs.value);
	if (next.has(relPath)) {
		next.delete(relPath);
	} else {
		next.add(relPath);
		if (!dirEntries.value[relPath] && !dirLoading.value[relPath]) {
			void loadDir(relPath);
		}
	}
	expandedDirs.value = next;
}

function joinRel(parent: string, name: string): string {
	return parent ? `${parent}/${name}` : name;
}

function TreeNode({ entry, parentPath, depth }: { entry: FileEntry; parentPath: string; depth: number }) {
	const relPath = joinRel(parentPath, entry.name);
	const indent = { paddingLeft: `${6 + depth * 14}px` };

	if (entry.type === "file") {
		return (
			<button
				type="button"
				class={`explorer-node${openFilePath.value === relPath ? " selected" : ""}`}
				style={indent}
				title={relPath}
				onClick={() => void openFile(relPath)}
			>
				<span class="explorer-node-spacer" />
				<span class="explorer-node-label">{entry.name}</span>
			</button>
		);
	}

	const isExpanded = expandedDirs.value.has(relPath);
	const children = dirEntries.value[relPath];
	const error = dirErrors.value[relPath];

	return (
		<>
			<button
				type="button"
				class={`explorer-node${isExpanded ? " expanded" : ""}`}
				style={indent}
				title={relPath}
				onClick={() => toggleDir(relPath)}
			>
				<svg
					class="explorer-node-chevron"
					width="9"
					height="9"
					viewBox="0 0 16 16"
					fill="currentColor"
					aria-hidden="true"
				>
					<title>Toggle</title>
					<path d="M5 2l7 6-7 6z" />
				</svg>
				<span class="explorer-node-label">{entry.name}</span>
			</button>
			{isExpanded && error ? (
				<div class="explorer-error" style={{ paddingLeft: `${20 + depth * 14}px` }}>
					{error}
				</div>
			) : null}
			{isExpanded && children
				? children.map((child) => (
						<TreeNode key={child.name} entry={child} parentPath={relPath} depth={depth + 1} />
					))
				: null}
			{isExpanded && !children && !error ? (
				<div class="explorer-error" style={{ paddingLeft: `${20 + depth * 14}px` }}>
					Loading…
				</div>
			) : null}
		</>
	);
}

/** Collapsible EXPLORER section in the sidebar. */
export function Explorer() {
	if (!instanceId) return null;
	const isOpen = explorerOpen.value;
	const rootEntries = dirEntries.value[""];
	const rootError = dirErrors.value[""];

	return (
		<div class="explorer">
			<button
				type="button"
				class={`explorer-toggle${isOpen ? " open" : ""}`}
				onClick={() => {
					explorerOpen.value = !isOpen;
					if (!isOpen && !rootEntries && !dirLoading.value[""]) {
						void loadDir("");
					}
				}}
			>
				<svg
					class="explorer-toggle-chevron"
					width="9"
					height="9"
					viewBox="0 0 16 16"
					fill="currentColor"
					aria-hidden="true"
				>
					<title>Toggle explorer</title>
					<path d="M5 2l7 6-7 6z" />
				</svg>
				Explorer
			</button>
			{isOpen ? (
				<div class="explorer-tree">
					{rootError ? <div class="explorer-error">{rootError}</div> : null}
					{!rootError && !rootEntries ? <div class="explorer-empty">Loading…</div> : null}
					{!rootError && rootEntries && rootEntries.length === 0 ? (
						<div class="explorer-empty">Empty directory</div>
					) : null}
					{rootEntries?.map((entry) => (
						<TreeNode key={entry.name} entry={entry} parentPath="" depth={0} />
					))}
				</div>
			) : null}
		</div>
	);
}

/** Read-only file viewer, replaces the chat area while a file is open. */
export function FileViewer() {
	const path = openFilePath.value;
	if (!path) return null;
	const lines = openFileContent.value?.split("\n");
	return (
		<div class="file-viewer">
			<div class="file-viewer-header">
				<span class="file-viewer-path" title={path}>
					{path}
				</span>
				<button type="button" class="file-viewer-close" onClick={closeFileViewer}>
					Close
				</button>
			</div>
			{openFileLoading.value ? <div class="file-viewer-message">Loading…</div> : null}
			{openFileError.value ? <div class="file-viewer-message">{openFileError.value}</div> : null}
			{!openFileLoading.value && !openFileError.value && lines ? (
				<pre class="file-viewer-body">
					{lines.map((line, index) => (
						<div class="file-viewer-line" key={index}>
							<span class="file-viewer-line-number">{index + 1}</span>
							<span class="file-viewer-line-text">{line}</span>
						</div>
					))}
				</pre>
			) : null}
		</div>
	);
}
