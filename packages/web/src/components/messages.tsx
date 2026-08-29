import { useState } from "preact/hooks";
import { copyText } from "../copy.ts";
import type { AgentMessage, AssistantMessage, ImageContent, ThinkingContent, UserMessage } from "../protocol.ts";
import { MarkdownView } from "./markdown-view.tsx";
import { ToolExecution } from "./tool-execution.tsx";

/** Hover copy button for a chunk of message text. */
function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			class="copy-btn"
			title="Copy text"
			onClick={() => {
				void copyText(text).then((ok) => {
					if (!ok) return;
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1200);
				});
			}}
		>
			{copied ? (
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
				</svg>
			) : (
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<rect x="5.5" y="5.5" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.2" />
					<path
						d="M10.5 5.5V3.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2"
						stroke="currentColor"
						stroke-width="1.2"
					/>
				</svg>
			)}
		</button>
	);
}

function userContentParts(message: UserMessage): { text: string; images: ImageContent[] } {
	if (typeof message.content === "string") {
		return { text: message.content, images: [] };
	}
	const textParts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		} else if (block.type === "image") {
			images.push(block);
		}
	}
	return { text: textParts.join("\n"), images };
}

export function UserMessageView({ message }: { message: UserMessage }) {
	const { text, images } = userContentParts(message);
	return (
		<div class="msg msg-user copy-wrap">
			{text && <CopyButton text={text} />}
			{text && <div class="msg-user-text">{text}</div>}
			{images.map((image, index) => (
				<img
					key={`${image.mimeType}-${index}`}
					class="msg-image"
					src={`data:${image.mimeType};base64,${image.data}`}
					alt="attached"
				/>
			))}
		</div>
	);
}

function ThinkingBlock({ block }: { block: ThinkingContent }) {
	if (block.redacted) {
		return <div class="thinking redacted">Thinking (redacted)</div>;
	}
	return (
		<details class="thinking">
			<summary>Thinking</summary>
			<div class="thinking-content">{block.thinking}</div>
		</details>
	);
}

export function AssistantMessageView({ message }: { message: AssistantMessage }) {
	const hasVisibleContent = message.content.some(
		(block) =>
			(block.type === "text" && block.text.trim() !== "") || block.type === "thinking" || block.type === "toolCall",
	);
	return (
		<div class="msg msg-assistant">
			{message.content.map((block, index) => {
				if (block.type === "thinking") {
					return <ThinkingBlock key={`thinking-${index}`} block={block} />;
				}
				if (block.type === "text") {
					if (block.text.trim() === "") return null;
					return (
						<div key={`text-${index}`} class="copy-wrap">
							<CopyButton text={block.text} />
							<MarkdownView text={block.text} />
						</div>
					);
				}
				if (block.type === "toolCall") {
					return <ToolExecution key={block.id} toolCallId={block.id} name={block.name} args={block.arguments} />;
				}
				return null;
			})}
			{!hasVisibleContent && message.stopReason !== "error" && message.stopReason !== "aborted" && (
				<div class="msg-empty">…</div>
			)}
			{message.stopReason === "error" && <div class="msg-error">{message.errorMessage ?? "Unknown error"}</div>}
			{message.stopReason === "aborted" && <div class="msg-note">(aborted)</div>}
		</div>
	);
}

export function BashExecutionView({ message }: { message: AgentMessage }) {
	if (message.role !== "bashExecution") return null;
	const exitNote = message.cancelled
		? "cancelled"
		: message.exitCode !== undefined && message.exitCode !== 0
			? `exit code ${message.exitCode}`
			: undefined;
	return (
		<div class="msg msg-bash">
			<div class="bash-command">$ {message.command}</div>
			{message.output && <pre class="bash-output">{message.output}</pre>}
			{exitNote && <div class="msg-note">({exitNote})</div>}
		</div>
	);
}

export function CustomMessageView({ message }: { message: AgentMessage }) {
	if (message.role !== "custom") return null;
	return (
		<div class="msg msg-custom">
			<div class="custom-label">{message.customType}</div>
			{typeof message.content === "string" ? <MarkdownView text={message.content} /> : null}
		</div>
	);
}

export function CompactionSummaryView({ message }: { message: AgentMessage }) {
	if (message.role !== "compactionSummary") return null;
	return (
		<details class="msg msg-summary">
			<summary>Context compacted ({message.tokensBefore.toLocaleString()} tokens before)</summary>
			<div class="summary-content">{message.summary}</div>
		</details>
	);
}

export function BranchSummaryView({ message }: { message: AgentMessage }) {
	if (message.role !== "branchSummary") return null;
	return (
		<details class="msg msg-summary">
			<summary>Branch summary</summary>
			<div class="summary-content">{message.summary}</div>
		</details>
	);
}
