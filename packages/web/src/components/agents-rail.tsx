import { useEffect, useState } from "preact/hooks";
import {
	activePanel,
	agentsRailOpen,
	focusSubagentRun,
	subagentSnapshot,
	toggleAgentsRail,
	toggleSubagentsPanel,
} from "../state.ts";
import type { AsyncStatusSnapshotNode, AsyncStatusSnapshotState } from "../subagent-status.ts";

const STATE_LABEL: Record<AsyncStatusSnapshotState, string> = {
	queued: "queued",
	running: "running",
	complete: "complete",
	failed: "failed",
	paused: "paused",
	stopped: "stopped",
	rejected: "rejected",
};

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatAgo(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ago`;
}

function nodeElapsedMs(node: AsyncStatusSnapshotNode, now: number): number | undefined {
	if (node.state === "running" && node.startedAt !== undefined) return Math.max(0, now - node.startedAt);
	if (node.endedAt !== undefined && node.startedAt !== undefined) return Math.max(0, node.endedAt - node.startedAt);
	return undefined;
}

function StatePill({ state }: { state: AsyncStatusSnapshotState }) {
	return <span class={`agents-rail-pill ${state}`}>{STATE_LABEL[state]}</span>;
}

function NodeStats({ node }: { node: AsyncStatusSnapshotNode }) {
	const turns = node.activity?.turnCount;
	const tools = node.activity?.toolCount;
	if (turns === undefined && tools === undefined) return null;
	return (
		<span class="agents-rail-stats">
			{turns !== undefined ? `${turns} turn${turns === 1 ? "" : "s"}` : null}
			{turns !== undefined && tools !== undefined ? " · " : null}
			{tools !== undefined ? `${tools} tool${tools === 1 ? "" : "s"}` : null}
		</span>
	);
}

function NodeCard({ node, now, depth }: { node: AsyncStatusSnapshotNode; now: number; depth: number }) {
	const elapsed = nodeElapsedMs(node, now);
	const currentTool = node.activity?.currentTool;
	const toolElapsed =
		currentTool && node.activity?.currentToolStartedAt !== undefined
			? Math.max(0, now - node.activity.currentToolStartedAt)
			: undefined;
	return (
		<div class="agents-rail-node">
			<button
				type="button"
				class="agents-rail-node-header"
				title={`Open ${node.label} in the Subagents panel`}
				onClick={() => void focusSubagentRun(node.id)}
			>
				<span class="agents-rail-node-label">{node.label}</span>
				<span class="agents-rail-node-kind">{node.kind}</span>
				<StatePill state={node.state} />
			</button>
			<div class="agents-rail-node-meta">
				{elapsed !== undefined ? <span>{formatElapsed(elapsed)}</span> : null}
				<NodeStats node={node} />
			</div>
			{currentTool ? (
				<div class="agents-rail-current-tool">
					running: {currentTool}
					{toolElapsed !== undefined ? ` (${formatElapsed(toolElapsed)})` : null}
				</div>
			) : null}
			{node.children && node.children.length > 0 ? (
				<div class="agents-rail-children">
					{node.children.map((child) => (
						<NodeCard key={child.id} node={child} now={now} depth={depth + 1} />
					))}
				</div>
			) : null}
		</div>
	);
}

/**
 * Collapsible right-hand rail showing live pi-subagents activity (parsed from
 * the PI_SUBAGENT_ASYNC_JSON: widget, see state.ts subagentSnapshot). Desktop:
 * a ~300px column beside the chat (outside its centered reading column, see
 * .main-content-row in style.css). Below the 900px breakpoint it becomes a
 * bottom sheet, same pattern as the sidebar's off-canvas drawer.
 */
export function AgentsRail() {
	const open = agentsRailOpen.value;
	const snapshot = subagentSnapshot.value;
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!open) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [open]);

	const hasOmitted = Boolean(snapshot && (snapshot.omitted.runs > 0 || snapshot.omitted.children > 0));

	return (
		<>
			{open ? (
				<button
					type="button"
					class="agents-rail-backdrop"
					aria-label="Close agents panel"
					onClick={toggleAgentsRail}
				/>
			) : null}
			<aside class={`agents-rail ${open ? "open" : "closed"}`} aria-label="Subagent activity">
				<div class="agents-rail-header">
					<span class="agents-rail-title">Agents</span>
					{snapshot ? (
						<span class="agents-rail-updated">updated {formatAgo(now - snapshot.generatedAt)}</span>
					) : null}
					<button type="button" class="agents-rail-close" title="Close" onClick={toggleAgentsRail}>
						×
					</button>
				</div>
				<div class="agents-rail-body">
					{!snapshot || snapshot.runs.length === 0 ? (
						<div class="agents-rail-empty">No subagents running</div>
					) : (
						snapshot.runs.map((run) => <NodeCard key={run.id} node={run} now={now} depth={0} />)
					)}
					{hasOmitted && snapshot ? (
						<div class="agents-rail-omitted">
							{snapshot.omitted.runs > 0
								? `+${snapshot.omitted.runs} more run${snapshot.omitted.runs === 1 ? "" : "s"}`
								: null}
							{snapshot.omitted.runs > 0 && snapshot.omitted.children > 0 ? " · " : null}
							{snapshot.omitted.children > 0 ? `+${snapshot.omitted.children} more nested` : null}
						</div>
					) : null}
				</div>
				<footer class="agents-rail-footer">
					<button
						type="button"
						class="agents-rail-history"
						onClick={() => {
							if (activePanel.value !== "subagents") toggleSubagentsPanel();
							if (window.matchMedia("(max-width: 900px)").matches) toggleAgentsRail();
						}}
					>
						View run history
					</button>
				</footer>
			</aside>
		</>
	);
}
