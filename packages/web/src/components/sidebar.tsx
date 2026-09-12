import { useEffect } from "preact/hooks";
import {
	instanceId,
	refreshSidebarSessions,
	sessionState,
	sidebarOpen,
	sidebarSessions,
	spawnSessionAndNavigate,
	startSidebarSessionsPolling,
	stopSidebarSessionsPolling,
} from "../state.ts";
import { Explorer } from "./explorer.tsx";

function formatRelativeTime(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return undefined;
	const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function PinIcon() {
	return (
		<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<title>Pinned</title>
			<path d="M9.5 1.5l5 5-2 2-1-.3-3 3 .3 3.3-1 1-3-3-3.7 3.7-.7-.7L3.3 12l-3-3 1-1L4.6 8.3 4.3 7.3l3-3-.3-1z" />
		</svg>
	);
}

/**
 * Persistent left sidebar: app title + new-session button, current project
 * path, the live session list for this account namespace (pinned first), a
 * collapsible read-only file explorer, and dashboard/settings links. Inline
 * on desktop (>=900px); below that (see .sidebar in style.css) it becomes an
 * off-canvas drawer toggled from the topbar.
 */
export function Sidebar() {
	useEffect(() => {
		if (!instanceId) return;
		void refreshSidebarSessions();
		startSidebarSessionsPolling();
		return () => stopSidebarSessionsPolling();
	}, []);

	const isOpen = sidebarOpen.value;
	const cwd = sessionState.value?.cwd;

	return (
		<>
			{isOpen ? (
				<button
					type="button"
					class="sidebar-backdrop"
					aria-label="Close sidebar"
					onClick={() => {
						sidebarOpen.value = false;
					}}
				/>
			) : null}
			<nav class={`sidebar${isOpen ? " open" : ""}`} aria-label="Sessions">
				<div class="sidebar-header">
					<span class="sidebar-title">pi</span>
					{instanceId ? (
						<button
							type="button"
							class="sidebar-new-btn"
							title="Spawn a new session in this project"
							onClick={() => void spawnSessionAndNavigate(cwd ?? "")}
						>
							<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
								<title>New session</title>
								<path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
							</svg>
							New
						</button>
					) : null}
					<button
						type="button"
						class="sidebar-close-btn"
						title="Close sidebar"
						onClick={() => {
							sidebarOpen.value = false;
						}}
					>
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
							<title>Close</title>
							<path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
						</svg>
					</button>
				</div>
				{cwd ? (
					<div class="sidebar-project" title={cwd}>
						<span dir="ltr">{cwd}</span>
					</div>
				) : null}
				{instanceId && sidebarSessions.value.length > 0 ? (
					<div class="sidebar-sessions">
						<div class="sidebar-section-label">Sessions</div>
						{sidebarSessions.value.map((session) => (
							<a
								key={session.id}
								href={`/i/${session.id}/`}
								class={`session-item${session.id === instanceId ? " current" : ""}`}
								title={session.namespace ? `${session.name} (${session.namespace})` : session.name}
								onClick={() => {
									sidebarOpen.value = false;
								}}
							>
								<div class="session-item-title">
									{session.pinned ? <PinIcon /> : null}
									<span class="session-item-name">{session.name}</span>
									{session.namespace ? <span class="session-item-ns">{session.namespace}</span> : null}
								</div>
								<div class="session-item-meta">
									{[
										formatRelativeTime(session.modified),
										session.messageCount !== undefined ? `${session.messageCount} msgs` : undefined,
									]
										.filter((part): part is string => Boolean(part))
										.join(" · ")}
								</div>
							</a>
						))}
					</div>
				) : null}
				<Explorer />
				<div class="sidebar-footer">
					<a href="/">Dashboard</a>
					<a href="/settings">Settings</a>
				</div>
			</nav>
		</>
	);
}
