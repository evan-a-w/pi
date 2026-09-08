export type InstanceStatus = "starting" | "online" | "stopping" | "stopped" | "error";

export interface MachineRecord {
	id: string;
	createdAt: string;
	lastSeenAt?: string;
	label?: string;
}

export interface RadiusRegistration {
	heartbeatIntervalMs: number;
	expiresInMs: number;
}

/** A registered account namespace (see namespaces.ts). The implicit "default" namespace is never stored here. */
export interface NamespaceRecord {
	name: string;
	createdAt: string;
}

/** A saved reusable chunk of text, inserted into the chat composer from the snippet picker (packages/web). */
export interface SnippetRecord {
	id: string;
	name: string;
	text: string;
}

/** Persisted dashboard settings (see storage.ts loadDashboardSettings/saveDashboardSettings and settings.ts). */
export interface DashboardSettings {
	// Pre-fills the spawn form's working directory field. May contain a leading
	// '~' (expanded server-side at spawn time, not validated here).
	defaultCwd?: string;
	snippets: SnippetRecord[];
}

export interface InstanceRecord {
	id: string;
	status: InstanceStatus;
	cwd: string;
	createdAt: string;
	lastSeenAt?: string;
	// Display fallback when the session itself has no name (see session-manager's
	// SessionInfoEntry). Precedence for the name shown to users is: the session's
	// own name (stored in the session .jsonl, set via set_session_name / the
	// dashboard rename control) > label > the session's first message > id prefix.
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	// Cached copy of the session's own display name (RpcSessionState.sessionName /
	// SessionManager.getSessionName()), kept in sync while live via get_state and
	// updated directly on rename while stopped. See the name-precedence note above.
	sessionName?: string;
	radiusPiId?: string;
	// Always-up session: auto-spawned from sessionFile on server startup and
	// auto-respawned (bounded retries) if its process exits unexpectedly.
	// Mutually exclusive with archived (setting one clears the other).
	pinned?: boolean;
	// Hidden from the main dashboard list under a collapsed "Archived" section.
	// Archiving a live instance stops it first; the record is kept (unlike a
	// plain stop, which forgets the instance) so it can be unarchived later.
	archived?: boolean;
	// Account namespace (see namespaces.ts): a separate PI_CODING_AGENT_DIR tree
	// giving this session its own provider credentials and sessions directory.
	// undefined means the implicit "default" namespace (~/.pi/agent, unchanged).
	namespace?: string;
}
