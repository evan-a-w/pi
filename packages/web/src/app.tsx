import { ChatList } from "./components/chat-list.tsx";
import { DialogHost, ToastHost } from "./components/dialogs.tsx";
import { Editor } from "./components/editor.tsx";
import { Footer } from "./components/footer.tsx";
import { MarkdownView } from "./components/markdown-view.tsx";
import { ForkPicker, ModelPicker } from "./components/pickers.tsx";
import { PinnedSidebar } from "./components/sidebar.tsx";
import { SubagentsPanel } from "./components/subagents.tsx";
import { TerminalView, TuiView } from "./components/terminal.tsx";
import {
	activePanel,
	commandResult,
	connected,
	currentNamespace,
	instanceId,
	sessionState,
	sessionUnreachable,
	subagentRuns,
	terminalOpen,
	toggleSubagentsPanel,
	toggleTui,
	tuiActive,
	widgets,
} from "./state.ts";

function Header() {
	const name = sessionState.value?.sessionName;
	const isConnected = connected.value;
	// Review runs against the session's working location, which /cd can move.
	const cwd = sessionState.value?.cwd;
	return (
		<header class="header">
			<a href="/" class="header-home" title="All sessions">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<title>Home</title>
					<path d="M2 6l6-4 6 4v8H2V6z" stroke="currentColor" stroke-width="1.2" fill="none" />
					<rect x="6" y="9" width="4" height="5" stroke="currentColor" stroke-width="1.2" fill="none" />
				</svg>
			</a>
			<span class="header-title">{name ? `pi — ${name}` : "pi"}</span>
			{currentNamespace.value ? <span class="header-namespace-tag">{currentNamespace.value}</span> : null}
			{cwd ? (
				<a
					href={`/review?cwd=${encodeURIComponent(cwd)}${instanceId ? `&instance=${encodeURIComponent(instanceId)}` : ""}`}
					class="header-review"
					title={`Review ${cwd}`}
				>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<title>Review</title>
						<path
							d="M3 2h7l3 3v9H3V2z"
							stroke="currentColor"
							stroke-width="1.2"
							fill="none"
							stroke-linejoin="round"
						/>
						<path d="M5.5 9.5l1.5 1.5 3.5-3.5" stroke="currentColor" stroke-width="1.2" fill="none" />
					</svg>
				</a>
			) : null}
			<button
				type="button"
				class={`header-subagents ${activePanel.value === "subagents" ? "active" : ""}`}
				title="Inspect subagent runs"
				onClick={toggleSubagentsPanel}
			>
				subagents
				{subagentRuns.value.length > 0 ? (
					<span class="header-subagents-count">{subagentRuns.value.length}</span>
				) : null}
			</button>
			<button
				type="button"
				class={`header-terminal ${terminalOpen.value ? "active" : ""}`}
				title="Toggle terminal"
				onClick={() => {
					terminalOpen.value = !terminalOpen.value;
				}}
			>
				{">_"}
			</button>
			<button
				type="button"
				class={`header-terminal ${tuiActive.value ? "active" : ""}`}
				title="Toggle TUI"
				onClick={() => void toggleTui()}
			>
				tui
			</button>
			<span
				class={`connection-dot ${isConnected ? "online" : "offline"}`}
				title={isConnected ? "Connected" : "Disconnected"}
			/>
		</header>
	);
}

function WidgetArea({ placement }: { placement: "aboveEditor" | "belowEditor" }) {
	const entries = Object.entries(widgets.value).filter(([, widget]) => widget.placement === placement);
	if (entries.length === 0) return null;
	return (
		<div class="widget-area">
			{entries.map(([key, widget]) => (
				<pre key={key} class="widget">
					{widget.lines.join("\n")}
				</pre>
			))}
		</div>
	);
}

function CommandResultCard() {
	const result = commandResult.value;
	if (!result) return null;
	return (
		<div class="command-result">
			<div class="command-result-header">
				<span class="command-result-title">{result.title}</span>
				<button
					type="button"
					class="command-result-close"
					title="Dismiss"
					onClick={() => {
						commandResult.value = undefined;
					}}
				>
					×
				</button>
			</div>
			<MarkdownView text={result.markdown} />
		</div>
	);
}

function UnreachableView() {
	return (
		<div class="unreachable-view">
			<div class="unreachable-card">
				<h1>Session not found</h1>
				<p>This session is no longer running on the server.</p>
				<a href="/" class="unreachable-home">
					Go home
				</a>
			</div>
		</div>
	);
}

export function App() {
	if (sessionUnreachable.value) {
		return <UnreachableView />;
	}
	return (
		<div class="app-shell">
			<PinnedSidebar />
			<div class="app">
				<Header />
				{activePanel.value === "subagents" ? (
					<SubagentsPanel />
				) : tuiActive.value ? (
					<TuiView />
				) : (
					<>
						<ChatList />
						<CommandResultCard />
						<WidgetArea placement="aboveEditor" />
						<Editor />
						<WidgetArea placement="belowEditor" />
					</>
				)}
				<TerminalView />
				<Footer />
				<DialogHost />
				<ToastHost />
				<ModelPicker />
				<ForkPicker />
			</div>
		</div>
	);
}
