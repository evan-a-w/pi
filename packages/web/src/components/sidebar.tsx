import { useEffect } from "preact/hooks";
import {
	instanceId,
	pinnedSessions,
	refreshPinnedSessions,
	startPinnedSessionsPolling,
	stopPinnedSessionsPolling,
} from "../state.ts";

/**
 * Slim left sidebar for quickly switching between pinned sessions. Only shown
 * when served by pi-server (instanceId defined) and only lists pinned + live
 * sessions; see refreshPinnedSessions for why. Hidden on narrow screens (see
 * .pinned-sidebar in style.css) so it never crowds the chat area on mobile.
 */
export function PinnedSidebar() {
	useEffect(() => {
		if (!instanceId) return;
		void refreshPinnedSessions();
		startPinnedSessionsPolling();
		return () => stopPinnedSessionsPolling();
	}, []);

	if (!instanceId) return null;
	const sessions = pinnedSessions.value;
	if (sessions.length === 0) return null;

	return (
		<nav class="pinned-sidebar" aria-label="Pinned sessions">
			<div class="pinned-sidebar-title">Pinned</div>
			{sessions.map((session) => (
				<a
					key={session.id}
					href={`/i/${session.id}/`}
					class={`pinned-sidebar-item${session.id === instanceId ? " current" : ""}`}
					title={session.namespace ? `${session.name} (${session.namespace})` : session.name}
				>
					{session.name}
					{session.namespace ? <span class="pinned-sidebar-item-ns">{session.namespace}</span> : null}
				</a>
			))}
		</nav>
	);
}
