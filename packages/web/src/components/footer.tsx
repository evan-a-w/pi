import {
	executeBuiltinCommand,
	modelPickerOpen,
	sessionState,
	setThinkingLevelCommand,
	slashCommands,
	stats,
	statusEntries,
	workingMessage,
} from "../state.ts";

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

/**
 * Bottom status strip, pinned under the composer: current model (click cycles
 * the model picker), thinking level (click cycles it), a Compact shortcut
 * when the session exposes /compact, and session cost/tokens. Theme switching
 * lives in the topbar toggle (see app.tsx ThemeToggle) - keeping a single
 * control avoids two dark/light toggles disagreeing with each other.
 */
export function StatusStrip() {
	const state = sessionState.value;
	const sessionStats = stats.value;
	const statusTexts = Object.values(statusEntries.value);
	const hasCompact = slashCommands.value.some((command) => command.name === "compact");

	return (
		<footer class="status-strip">
			{workingMessage.value && (
				<div class="working-indicator">
					{workingMessage.value}
					<span class="working-dots" />
				</div>
			)}
			{statusTexts.length > 0 && <div class="status-entries">{statusTexts.join(" · ")}</div>}
			<div class="status-strip-row">
				<span class="status-strip-left">
					{state?.model ? (
						<button
							type="button"
							class="status-strip-btn"
							title="Change model"
							onClick={() => {
								modelPickerOpen.value = true;
							}}
						>
							{state.model.name}
						</button>
					) : (
						<span>no model</span>
					)}
					{state?.model ? (
						<button
							type="button"
							class="status-strip-btn"
							title="Thinking level (click to cycle)"
							onClick={() => void setThinkingLevelCommand("")}
						>
							{state.thinkingLevel}
						</button>
					) : null}
					{hasCompact ? (
						<button
							type="button"
							class="status-strip-btn"
							title="Compact context"
							onClick={() => void executeBuiltinCommand("/compact")}
						>
							Compact
						</button>
					) : null}
				</span>
				<span class="status-strip-right">
					{sessionStats && <span title="Session cost">${sessionStats.cost.toFixed(4)}</span>}
					{sessionStats && <span title="Total tokens">{formatTokens(sessionStats.tokens.total)}</span>}
				</span>
			</div>
		</footer>
	);
}
