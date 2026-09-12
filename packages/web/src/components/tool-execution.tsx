import { diffLines } from "diff";
import { useState } from "preact/hooks";
import { toolStates } from "../state.ts";

const COLLAPSE_LINE_THRESHOLD = 15;
const COLLAPSE_CHAR_THRESHOLD = 2000;

// Remember expand/collapse per tool call across re-renders
const expandedToolCalls = new Map<string, boolean>();

function summarizeArgs(args: Record<string, unknown>): string {
	const candidate =
		(typeof args.command === "string" && args.command) ||
		(typeof args.path === "string" && args.path) ||
		(typeof args.file_path === "string" && args.file_path) ||
		(typeof args.query === "string" && args.query) ||
		(typeof args.pattern === "string" && args.pattern) ||
		JSON.stringify(args);
	const singleLine = candidate.replace(/\s+/g, " ").trim();
	return singleLine.length > 100 ? `${singleLine.slice(0, 100)}…` : singleLine;
}

/** Line-based diff for the edit tool (oldText -> newText). */
function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
	const parts = diffLines(oldText, newText);
	return (
		<pre class="diff">
			{parts.map((part, index) => {
				const cls = part.added ? "diff-add" : part.removed ? "diff-del" : "diff-ctx";
				const prefix = part.added ? "+" : part.removed ? "-" : " ";
				const lines = part.value.replace(/\n$/, "").split("\n");
				return lines.map((line, lineIndex) => (
					<div key={`${index}-${lineIndex}`} class={cls}>
						{prefix} {line}
					</div>
				));
			})}
		</pre>
	);
}

/** Render tool args as a diff where applicable (edit/write), like the TUI. */
function ArgsDiff({ name, args }: { name: string; args: Record<string, unknown> }) {
	if (name === "edit" && typeof args.oldText === "string" && typeof args.newText === "string") {
		return <EditDiff oldText={args.oldText} newText={args.newText} />;
	}
	if (name === "write" && typeof args.content === "string") {
		return (
			<pre class="diff">
				{args.content
					.replace(/\n$/, "")
					.split("\n")
					.map((line, index) => (
						<div key={index} class="diff-add">
							+ {line}
						</div>
					))}
			</pre>
		);
	}
	return null;
}

export function ToolExecution({
	toolCallId,
	name,
	args,
}: {
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
}) {
	const live = toolStates.value[toolCallId];
	const status = live?.status ?? "running";
	const isError = live?.isError ?? false;
	const output = live?.output ?? live?.partial ?? "";

	const [expanded, setExpanded] = useState(expandedToolCalls.get(toolCallId) ?? false);
	const toggleExpanded = () => {
		const next = !expanded;
		expandedToolCalls.set(toolCallId, next);
		setExpanded(next);
	};

	const statusClass = status === "running" ? "tool-pending" : isError ? "tool-error" : "tool-success";
	const summary = summarizeArgs(args);
	const hasDiff =
		(name === "edit" && typeof args.oldText === "string" && typeof args.newText === "string") ||
		(name === "write" && typeof args.content === "string");
	const diffLineCount =
		name === "edit" && typeof args.newText === "string"
			? args.newText.split("\n").length
			: name === "write" && typeof args.content === "string"
				? args.content.split("\n").length
				: 0;
	const lineCount = (output === "" ? 0 : output.split("\n").length) + diffLineCount;
	const isLong = lineCount > COLLAPSE_LINE_THRESHOLD || output.length > COLLAPSE_CHAR_THRESHOLD;

	return (
		<div class={`tool ${statusClass}`}>
			<button type="button" class="tool-title" onClick={isLong ? toggleExpanded : undefined}>
				<span class="tool-name">{name}</span>
				{summary && <span class="tool-summary">{summary}</span>}
				{status === "running" && <span class="tool-running-indicator">…</span>}
				{isLong && <span class="tool-chevron">{expanded ? "▴" : "▾"}</span>}
			</button>
			{(hasDiff || output) && (
				<div class={`tool-body ${isLong && !expanded ? "collapsed" : ""}`}>
					{hasDiff && <ArgsDiff name={name} args={args} />}
					{output && <pre class="tool-output">{output}</pre>}
				</div>
			)}
			{isLong && (
				<button type="button" class="tool-toggle" onClick={toggleExpanded}>
					{expanded ? "Show less" : `Show all ${lineCount} lines`}
				</button>
			)}
		</div>
	);
}
