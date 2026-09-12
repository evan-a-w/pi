/**
 * Live subagent status widget, published by the pi-subagents extension
 * (~/.pi/agent/npm/node_modules/pi-subagents) as a single-line `setWidget`
 * payload: `PI_SUBAGENT_ASYNC_JSON:<json>`. These types are an intentionally
 * self-contained copy of the shapes in that extension's
 * src/runs/background/async-status-snapshot.ts (AsyncStatusSnapshotV1) - the
 * web package does not depend on extension packages, so keep this in sync by
 * hand if that schema changes.
 */

/** Prefix identifying a widget line as an encoded async status snapshot, not free text. */
export const ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

export type AsyncStatusSnapshotState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";

export type AsyncStatusSnapshotKind = "subagent" | "workflow" | "step";

export interface AsyncStatusSnapshotActivity {
	state?: string;
	currentTool?: string;
	lastActivityAt?: number;
	currentToolStartedAt?: number;
	turnCount?: number;
	toolCount?: number;
}

export interface AsyncStatusSnapshotNode {
	id: string;
	kind: AsyncStatusSnapshotKind;
	label: string;
	state: AsyncStatusSnapshotState;
	startedAt?: number;
	updatedAt?: number;
	endedAt?: number;
	activity?: AsyncStatusSnapshotActivity;
	children?: AsyncStatusSnapshotNode[];
}

export interface AsyncStatusSnapshotOmitted {
	runs: number;
	children: number;
	byteLimitExceeded: boolean;
}

export interface AsyncStatusSnapshot {
	generatedAt: number;
	omitted: AsyncStatusSnapshotOmitted;
	runs: AsyncStatusSnapshotNode[];
}

const VALID_STATES: ReadonlySet<string> = new Set([
	"queued",
	"running",
	"complete",
	"failed",
	"paused",
	"stopped",
	"rejected",
]);

function isValidState(value: unknown): value is AsyncStatusSnapshotState {
	return typeof value === "string" && VALID_STATES.has(value);
}

function isValidKind(value: unknown): value is AsyncStatusSnapshotKind {
	return value === "subagent" || value === "workflow" || value === "step";
}

function sanitizeActivity(value: unknown): AsyncStatusSnapshotActivity | undefined {
	if (!value || typeof value !== "object") return undefined;
	const source = value as Record<string, unknown>;
	const activity: AsyncStatusSnapshotActivity = {};
	if (typeof source.state === "string") activity.state = source.state;
	if (typeof source.currentTool === "string") activity.currentTool = source.currentTool;
	if (typeof source.lastActivityAt === "number") activity.lastActivityAt = source.lastActivityAt;
	if (typeof source.currentToolStartedAt === "number") activity.currentToolStartedAt = source.currentToolStartedAt;
	if (typeof source.turnCount === "number") activity.turnCount = source.turnCount;
	if (typeof source.toolCount === "number") activity.toolCount = source.toolCount;
	return Object.keys(activity).length > 0 ? activity : undefined;
}

/** Drops any node (and its subtree) that doesn't match the expected shape, rather than failing the whole snapshot. */
function sanitizeNode(value: unknown): AsyncStatusSnapshotNode | undefined {
	if (!value || typeof value !== "object") return undefined;
	const source = value as Record<string, unknown>;
	if (
		typeof source.id !== "string" ||
		typeof source.label !== "string" ||
		!isValidKind(source.kind) ||
		!isValidState(source.state)
	) {
		return undefined;
	}
	const node: AsyncStatusSnapshotNode = { id: source.id, kind: source.kind, label: source.label, state: source.state };
	if (typeof source.startedAt === "number") node.startedAt = source.startedAt;
	if (typeof source.updatedAt === "number") node.updatedAt = source.updatedAt;
	if (typeof source.endedAt === "number") node.endedAt = source.endedAt;
	const activity = sanitizeActivity(source.activity);
	if (activity) node.activity = activity;
	if (Array.isArray(source.children)) {
		const children = source.children
			.map(sanitizeNode)
			.filter((child): child is AsyncStatusSnapshotNode => child !== undefined);
		if (children.length > 0) node.children = children;
	}
	return node;
}

/**
 * Parse one widget line into a snapshot. Returns undefined for lines that
 * aren't a snapshot (no prefix) or that fail to parse/validate (malformed
 * JSON, wrong shape) - callers should keep the last good snapshot in that case
 * rather than clearing it.
 */
export function parseAsyncStatusSnapshotWidgetLine(line: string): AsyncStatusSnapshot | undefined {
	if (!line.startsWith(ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX)) return undefined;
	const jsonText = line.slice(ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX.length);
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const data = parsed as Record<string, unknown>;
	if (typeof data.generatedAt !== "number" || !Array.isArray(data.runs)) return undefined;
	const omittedSource = data.omitted as Record<string, unknown> | undefined;
	const omitted: AsyncStatusSnapshotOmitted = {
		runs: typeof omittedSource?.runs === "number" ? omittedSource.runs : 0,
		children: typeof omittedSource?.children === "number" ? omittedSource.children : 0,
		byteLimitExceeded: omittedSource?.byteLimitExceeded === true,
	};
	const runs = data.runs.map(sanitizeNode).filter((node): node is AsyncStatusSnapshotNode => node !== undefined);
	return { generatedAt: data.generatedAt, omitted, runs };
}

/** Recursively counts nodes (runs, workflow steps, nested subagents) currently running, for the topbar badge. */
export function countRunningNodes(snapshot: AsyncStatusSnapshot | undefined): number {
	if (!snapshot) return 0;
	let count = 0;
	const walk = (nodes: AsyncStatusSnapshotNode[]): void => {
		for (const node of nodes) {
			if (node.state === "running") count++;
			if (node.children) walk(node.children);
		}
	};
	walk(snapshot.runs);
	return count;
}
