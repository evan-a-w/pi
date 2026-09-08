import { useEffect } from "preact/hooks";
import type { SubagentRunSummary } from "../protocol.ts";
import {
	refreshSubagents,
	selectedRunKey,
	selectSubagentOutput,
	selectSubagentRun,
	setSubagentView,
	startSubagentPolling,
	stopSubagentPolling,
	subagentFile,
	subagentLoading,
	subagentRuns,
	subagentView,
	tuiActive,
} from "../state.ts";
import { MarkdownView } from "./markdown-view.tsx";

// ============================================================================
// Formatting helpers
// ============================================================================

function formatTime(ms: number | undefined): string {
	if (!ms || !Number.isFinite(ms)) return "—";
	const date = new Date(ms);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getHours()}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDate(ms: number | undefined): string {
	if (!ms || !Number.isFinite(ms)) return "";
	return new Date(ms).toLocaleString();
}

function formatDuration(ms: number | undefined): string {
	if (!ms || !Number.isFinite(ms)) return "—";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function formatBytes(bytes: number | undefined): string {
	if (bytes === undefined) return "";
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
	if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
	return `${bytes}B`;
}

function formatTokens(run: SubagentRunSummary): string {
	const input = run.usage?.input;
	const output = run.usage?.output;
	if (typeof input !== "number" && typeof output !== "number") return "";
	const total = (typeof input === "number" ? input : 0) + (typeof output === "number" ? output : 0);
	const format = (count: number): string =>
		count >= 1_000_000
			? `${(count / 1_000_000).toFixed(1)}M`
			: count >= 1_000
				? `${(count / 1_000).toFixed(1)}k`
				: String(count);
	return ` ${format(total)} tok`;
}

const STATUS_LABEL: Record<SubagentRunSummary["status"], string> = {
	running: "running",
	done: "done",
	failed: "failed",
};

// ============================================================================
// Transcript rendering
// ============================================================================

interface TranscriptLine {
	ts: number;
	role: string;
	event: string;
	text?: string;
	meta?: string;
}

/** Cap per-entry text so huge tool outputs stay readable in the panel. */
const MAX_ENTRY_CHARS = 4_000;

/**
 * Extract readable text from a standard agent session-record `message` field
 * (`{role, content: [{type: "text", text}, ...]}` or a plain string), used as a
 * fallback when a line has no top-level `text` (workflow-mode transcripts are the
 * child's own session .jsonl, not the flat pi-subagents artifact shape below).
 */
function extractMessageText(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
			parts.push((part as Record<string, unknown>).text as string);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function parseTranscript(content: string): TranscriptLine[] {
	const lines: TranscriptLine[] = [];
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const data = JSON.parse(line) as Record<string, unknown>;
			const message = data.message as Record<string, unknown> | undefined;
			const ts =
				typeof data.ts === "number" ? data.ts : typeof data.timestamp === "string" ? Date.parse(data.timestamp) : 0;
			const text =
				typeof data.text === "string" && data.text.trim().length > 0
					? data.text.trim()
					: extractMessageText(message)?.trim();
			const role =
				typeof data.role === "string" && data.role
					? data.role
					: typeof message?.role === "string" && message.role
						? (message.role as string)
						: "event";
			const event =
				typeof data.sourceEventType === "string"
					? data.sourceEventType
					: typeof data.type === "string"
						? data.type
						: "";
			const metaBits: string[] = [];
			if (typeof data.model === "string") metaBits.push(data.model);
			if (typeof data.toolName === "string") metaBits.push(`tool:${data.toolName}`);
			if (typeof data.exitCode === "number") metaBits.push(`exit:${data.exitCode}`);
			lines.push({ ts, role, event, text, meta: metaBits.join(" · ") });
		} catch {
			lines.push({ ts: 0, role: "raw", event: "", text: line });
		}
	}
	return lines;
}

function TranscriptContent({ content }: { content: string }) {
	const lines = parseTranscript(content);
	if (lines.length === 0) {
		return <div class="subagents-empty">Empty transcript.</div>;
	}
	return (
		<div class="transcript">
			{lines.map((line, index) => {
				const displayText =
					line.text && line.text.length > MAX_ENTRY_CHARS
						? `${line.text.slice(0, MAX_ENTRY_CHARS)}\n… [truncated ${line.text.length - MAX_ENTRY_CHARS} chars]`
						: line.text;
				return (
					<div key={index} class={`transcript-entry ${line.role}`}>
						<div class="transcript-header">
							<span class="transcript-time">{formatTime(line.ts)}</span>
							<span class="transcript-role">{line.role}</span>
							{line.event && line.event !== line.role ? (
								<span class="transcript-event">{line.event}</span>
							) : null}
							{line.meta ? <span class="transcript-meta">{line.meta}</span> : null}
						</div>
						{displayText ? <pre class="transcript-text">{displayText}</pre> : null}
					</div>
				);
			})}
		</div>
	);
}

// ============================================================================
// Panel
// ============================================================================

function RunMeta({ run }: { run: SubagentRunSummary }) {
	return (
		<div class="subagents-meta">
			<div class="subagents-meta-line">
				<span class={`status-dot ${run.status}`} />
				<span class="subagents-meta-agent">{run.agent}</span>
				<span class="subagents-meta-muted">{run.runId}</span>
				<span class={`status-label ${run.status}`}>{STATUS_LABEL[run.status]}</span>
			</div>
			<div class="subagents-meta-grid">
				<span>Started</span>
				<strong title={formatDate(run.startedAt)}>{formatTime(run.startedAt)}</strong>
				<span>Duration</span>
				<strong>{formatDuration(run.durationMs)}</strong>
				{run.model ? (
					<>
						<span>Model</span>
						<strong>{run.model}</strong>
					</>
				) : null}
				{run.toolCount !== undefined ? (
					<>
						<span>Tools</span>
						<strong>{run.toolCount}</strong>
					</>
				) : null}
				{run.usage ? (
					<>
						<span>Tokens</span>
						<strong>{formatTokens(run)}</strong>
					</>
				) : null}
				{run.exitCode !== undefined ? (
					<>
						<span>Exit</span>
						<strong class={run.exitCode === 0 ? "" : "exit-error"}>{run.exitCode}</strong>
					</>
				) : null}
			</div>
			{run.task ? <div class="subagents-task">{run.task}</div> : null}
			{run.error ? <div class="subagents-error">{run.error}</div> : null}
			{run.fromEarlierSession ? (
				<div class="subagents-stale-note">
					From an earlier session state (fork/new session/reload changed the active session file since this run
					started).
				</div>
			) : null}
		</div>
	);
}

export function SubagentsPanel() {
	const runs = subagentRuns.value;
	const selectedKey = selectedRunKey.value;
	const selected = runs.find((run) => run.key === selectedKey);
	const file = subagentFile.value;
	const loading = subagentLoading.value;
	const view = subagentView.value;

	useEffect(() => {
		startSubagentPolling();
		void refreshSubagents();
		return () => stopSubagentPolling();
	}, []);

	if (runs.length === 0) {
		return (
			<div class="subagents-panel">
				{tuiActive.value ? (
					<div class="subagents-tui-note">
						TUI is still attached in the background; chat is blocked until it closes.
					</div>
				) : null}
				<div class="subagents-empty">
					No subagent runs found in this project. Ask pi to delegate work (e.g. “Use scout to investigate this
					code”) and runs will appear here with their transcripts.
				</div>
			</div>
		);
	}

	const hasOutput = selected?.outputPath !== undefined;
	const hasFiles = (selected?.outputs?.length ?? 0) > 0;
	const earlierSessionCount = runs.filter((run) => run.fromEarlierSession).length;

	return (
		<div class="subagents-panel">
			{tuiActive.value ? (
				<div class="subagents-tui-note">
					TUI is still attached in the background; chat is blocked until it closes.
				</div>
			) : null}
			{earlierSessionCount > 0 ? (
				<div class="subagents-tui-note">
					{earlierSessionCount} run{earlierSessionCount === 1 ? "" : "s"} from an earlier session state (marked
					below).
				</div>
			) : null}
			<div class="subagents-tabs">
				{runs.map((run) => (
					<button
						type="button"
						key={run.key}
						class={`subagents-tab ${run.key === selectedKey ? "active" : ""}`}
						title={`${run.agent} · ${run.runId} · ${STATUS_LABEL[run.status]}${run.fromEarlierSession ? " · earlier session" : ""}`}
						onClick={() => void selectSubagentRun(run.key)}
					>
						<span class={`status-dot ${run.status}`} />
						<span class="subagents-tab-agent">{run.agent}</span>
						<span class="subagents-tab-runid">{run.runId.slice(0, 6)}</span>
						{run.fromEarlierSession ? <span class="subagents-tab-stale">⏴</span> : null}
					</button>
				))}
			</div>
			{selected ? (
				<div class="subagents-body">
					<RunMeta run={selected} />
					<div class="subagents-view-tabs">
						<button
							type="button"
							class={view === "transcript" ? "active" : ""}
							disabled={!selected.transcriptPath}
							onClick={() => void setSubagentView("transcript")}
						>
							Transcript
							{selected.transcriptBytes !== undefined ? (
								<span class="subagents-view-size"> ({formatBytes(selected.transcriptBytes)})</span>
							) : null}
						</button>
						<button
							type="button"
							class={view === "output" ? "active" : ""}
							disabled={!hasOutput}
							onClick={() => void setSubagentView("output")}
						>
							Output
						</button>
						{hasFiles ? (
							<button
								type="button"
								class={view === "outputs" ? "active" : ""}
								onClick={() => void setSubagentView("outputs")}
							>
								Files ({selected.outputs?.length})
							</button>
						) : null}
					</div>
					<div class="subagents-content">
						{loading && !file ? <div class="subagents-loading">Loading…</div> : null}
						{!loading && !file && view === "transcript" && !selected.transcriptPath ? (
							<div class="subagents-empty">No transcript available for this run.</div>
						) : null}
						{!loading && !file && view === "output" && !hasOutput ? (
							<div class="subagents-empty">No output available for this run.</div>
						) : null}
						{view === "outputs" && selected.outputs ? (
							<div class="subagents-files">
								{selected.outputs.map((output) => (
									<button
										type="button"
										class={`subagents-file ${file?.path === output.path ? "active" : ""}`}
										key={output.path}
										onClick={() => void selectSubagentOutput(output.path)}
									>
										<span>{output.name}</span>
										<span class="subagents-view-size">{formatBytes(output.bytes)}</span>
									</button>
								))}
							</div>
						) : null}
						{view === "transcript" && file ? <TranscriptContent content={file.content} /> : null}
						{view === "output" && file ? (
							<div class="subagents-output">
								<MarkdownView text={file.content} />
							</div>
						) : null}
						{view === "outputs" && file && selected.outputs?.some((output) => output.path === file.path) ? (
							<div class="subagents-output">
								<MarkdownView text={file.content} />
							</div>
						) : null}
						{file?.truncated ? <div class="subagents-truncated">File truncated at 4MB by the server.</div> : null}
					</div>
				</div>
			) : null}
		</div>
	);
}
