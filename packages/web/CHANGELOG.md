# Changelog

## [Unreleased]

### Added

- Initial release: Preact web UI for pi sessions, speaking the pi RPC protocol over WebSocket. Served by `pi --web`, `/web` in the TUI, and `server serve --web` (per-instance under `/i/<id>/`); includes TUI-mirrored rendering (markdown, syntax highlighting, tool executions with edit/write diffs, themes from the TUI theme JSONs including custom themes), prompting with steering and abort, slash command autocomplete, extension UI dialogs (select/confirm/input/editor) with first-response-wins semantics across clients, inline compaction summaries, and a mobile layout (touch targets, safe areas, send button).
- Added builtin slash commands in the web UI: `/compact`, `/new`, `/name`, `/model` (picker with fuzzy search, or `/model provider/id` directly), `/session` (stats card), `/export`, `/copy`, `/fork` (message picker, forked text lands in the editor), `/clone`, plus `!<cmd>` bash execution.
- Added a review icon to the session header, left of the terminal icon, linking to the review page for the session's working location. Under `pi-server` it passes the instance id so the review page can link back.
- Added the `/gas` builtin slash command, staging all changes, committing with a `😊` message, and pushing.
- Added the `/cd [path]` builtin slash command, changing the session's working location (or reporting it when called with no argument).
- Added a terminal panel (xterm.js), toggled from the header. It attaches to a persistent shell that keeps `cd`, environment variables, and running processes across commands and runs interactive programs like `vim` and `htop`. The shell lives for the whole pi run, so closing the panel or reconnecting from another device resumes the same session with its scrollback replayed. On narrow screens a key bar supplies `Esc`, `Tab`, `Ctrl-C`/`Ctrl-D`/`Ctrl-Z`, and arrow keys. Requires `tmux` on the host.
- Added PWA metadata, icons, and a service worker so the web UI can be installed to a mobile home screen in standalone mode on supported secure origins.
- Added a `tui` header button that swaps the chat area (message list, command result card, widgets, editor) for an xterm.js view of the real pi interactive TUI attached to the same session. Toggling it off (or the TUI process exiting) closes the attachment and resyncs the chat view with whatever happened in the TUI. The header, footer, dialogs, terminal panel, and subagents panel are unaffected and remain reachable while the TUI is showing.
- Added a pinned-sessions sidebar when served by `pi-server`: a slim left column lists other pinned (and currently live) sessions by name, linking to `/i/<id>/`, with the current session highlighted. Hidden below 900px so it never crowds the chat area on mobile; refreshes on WebSocket reconnect and a slow ~30s poll. Not shown under bare `pi --web`, which has no pinning concept.
- Added an account namespace tag to the header (when the session is not in the implicit `default` namespace) and to pinned-sidebar entries that span namespaces, using the pi-server dashboard-sessions data the pinned sidebar already fetches. See pi-server's account namespaces.

### Fixed

- Fixed web slash command autocomplete to keep scrolling through all matches and order commands like the TUI.
- Fixed the footer and session state not staying in sync while the TUI view was open: the app now re-syncs on a new `session_reloaded` event (broadcast when the bridge notices the TUI wrote to the session file), not only when the TUI closes.
- Fixed the theme picker not switching theme: the dev server proxy did not forward `/themes` (only `/theme`), so the theme list silently fell back to defaults.
- Fixed the subagents panel's run tabs missing a `key`, and view/output switches showing briefly stale content from the previous view while the new one loaded.
- Fixed subagent transcript/output/file fetch failures being silently swallowed, which looked like clicking a tab did nothing; failures now show a toast.
- Fixed `/i/<id>/` for an unknown or stopped instance (served by `pi-server`) rendering a blank/plain-text page with no way back: the app now shows a full-page "Session not found" state with a home link once the WebSocket closes with the server's "unknown instance" code (4404), instead of retrying the connection forever. See the matching `@earendil-works/pi-server` change to serve the app shell for these paths.
- Fixed the `tui`/terminal views failing to open silently: a failed `tui_open`/`terminal_open` now shows a toast and reverts to the chat view instead of leaving a near-empty pane behind.
- Fixed stale terminal output replaying into a freshly reopened `tui`/terminal view (a signal fires its last value immediately on subscribe): the output signal is now reset on exit and on unmount.
- Fixed the `tui`/terminal views going silent after a WebSocket reconnect: they now re-open with a fresh replay and show a "Reconnecting…" overlay while doing so, instead of only resuming future output.
- Fixed the `tui`/terminal views keeping the theme they were opened with; they now update live when the theme is switched from the footer.
- Fixed keystrokes typed immediately after opening the `tui`/terminal view being lost before the previously-focused editor unmounted; the view now focuses itself as soon as it opens, and shows a loading overlay until the first frame arrives.
- Fixed terminal/TUI keystrokes typed while disconnected throwing an unhandled promise rejection; input sent while disconnected now fails through the same toast convention as the rest of the app.
- Fixed the terminal/TUI resize RPC firing on every layout tick during a drag-resize; it is now debounced (~150ms).
- Fixed the subagents panel showing a silently blank content pane for a run with no transcript or output file (its Transcript/Output tabs were already correctly disabled, but the pane below stayed empty either way): it now shows an explicit "No transcript/output available for this run" placeholder.
