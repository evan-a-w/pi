# Changelog

## [Unreleased]

### Added

- Added account namespaces: local, non-security groupings of sessions where each namespace gets its own provider credentials (`auth.json`), settings, and sessions directory. The implicit `default` namespace is `~/.pi/agent` (unchanged); named namespaces live under `~/.pi/namespaces/<name>/agent`, set as `PI_CODING_AGENT_DIR` for that namespace's session processes. A namespace's credentials are set up by opening any session in it and running the normal TUI/chat auth flow (e.g. `/login`), which writes to that namespace's `auth.json` via the env var, same as the default namespace today. New endpoints: `GET /api/namespaces`, `POST /api/namespaces` (create), `POST /api/namespaces/delete` (registry entry only when no sessions reference it; never deletes credential files), and `POST /api/sessions/move` (moves a session to another namespace - the session file itself stays put; a live instance is stopped and, if resumable, respawned under the target namespace's credentials, continuing the same session file under a different provider account). `InstanceRecord` gained `namespace`, `/api/spawn` and `/api/dashboard-sessions` gained a `namespace` field, and pinned auto-spawn/respawn preserve a session's namespace. The dashboard gained a namespace switcher (header dropdown, "All" or a specific namespace, persisted in `localStorage`), a namespace tag on session rows, a namespace select on the spawn form (hidden until a second namespace exists), and a "Move to namespace…" kebab action.
- Added session management to the web dashboard: rename (live sessions via RPC `set_session_name`, stopped sessions by writing directly to the session file), pin ("always up" - auto-spawned on server startup and auto-respawned, with a bounded retry/backoff, if the process exits unexpectedly), archive (stops a live session and hides it under a collapsed "Archived" section; pinned and archived are mutually exclusive), and delete (stops if live, forgets the instance, and removes the session's `.jsonl` file). New endpoints: `GET /api/dashboard-sessions`, `POST /api/sessions/rename`, `POST /api/sessions/pin`, `POST /api/sessions/archive`, `POST /api/sessions/delete`. The dashboard now shows one merged list of live, stopped, and past sessions (deduplicated by session file) instead of separate "Active"/"Past" lists, sorted with pinned sessions first and everyone else by last-accessed (most recent first); opening a session's WS stream, prompting, and resuming all count as access.
- Added checkboxes per dashboard session row for bulk archive and bulk delete (single confirm showing the selected count); pin/unpin stays per-row only.
- Added directory autocomplete to the dashboard's "Working directory" field, backed by a new `GET /api/fs/dirs?prefix=<path>` endpoint (directory-only completions, `~` expansion, capped results, unreadable directories skipped).
- Added a file-list summary to the review page, modelled on the cranium spacemacs UI: the top-level view now lists every file in the review with a tick when reviewed and an empty box when not, marking files changed since review with a "changed" tag. Clicking a file drills into its diff, a "Files" button (or `q`/`Escape`) returns to the list, and "Mark reviewed" (or `m`) now advances straight to the next file needing review instead of leaving the review on one file at a time. `n` skips to the next file without marking.
- Added a `git pull` after a successful merge on the review page. The merge happens on GitHub, so the local branches were left behind; the base branch is fast-forwarded too (unless it is checked out), which otherwise leaves reviews diffing against the pre-merge commit.
- Added pull request creation to the review page's "Merge PR": when the branch has no open pull request, it offers to create one and merge it, instead of only reporting that none exists. Requires the matching `cranium review merge --create-pr` support.
- Fixed review action results (merge, commit review, swap, restart) being reported at the bottom of the panel, below the file list and diff, where they were off-screen and looked like nothing had happened. They now appear directly under the action buttons.
- Fixed the review page's merge silently doing nothing: the merge endpoint did not pass `--json`, so cranium emitted human-readable output and the success path could not read the merged pull request. Merge failures now also explain the cause, including an origin remote GitHub cannot be parsed from (for example `git@github.com:/owner/repo`, with a slash after the colon) and a branch with no open pull request.
- Changed the review page's "Merge" button to "Merge PR": it now asks which branch to merge into (defaulting to `main`) instead of assuming `main`, confirms first, warns when files are still unreviewed, and reports which pull request was merged. Merging targets this branch's GitHub pull request, as before.
- Added a "Swap base/head" button to the review page, and an explicit empty-range warning: a review whose range contains no files now says so and names the reversed range, instead of reporting "All files reviewed" as though the review were complete.
- Added a session icon to the review page header, linking back to the session the review was opened from. The dashboard and session-view review links now carry the instance id; the icon is hidden when the review page is opened without one.
- Added a "Commit review" button to the review page (see below), and changed the review page's "Clear" button to "Restart": it now discards the session and immediately starts a new review over the same range (or the same pull request), instead of leaving no review behind. It asks for confirmation first, and falls back to the start panel if the new review cannot be created.
- Added a "Commit review" button to the review page, backed by a new `POST /api/review/refresh` endpoint (`cranium review refresh`). It re-anchors the review to the repository's current HEAD while keeping existing checkpoints, so files reviewed at an older revision come back as changed showing only what moved since you reviewed them, and files touched by new commits are added as unreviewed.
- Added the current git branch to the review page header, backed by a new `GET /api/git/branch?repo=<path>` endpoint. The badge is hidden on detached HEAD or outside a git repo, and refreshes when the repo changes or `--create-pr` moves HEAD.
- Added tracking of a session's working location: when a session changes location with `/cd`, the supervised instance record follows it, so the dashboard's review link targets the session's current directory.
- Added `server serve --web [--web-port <port>] [--web-host <host>]`: serves the pi web UI for all supervised instances with token auth (instance index at `/`, per-instance UI at `/i/<id>/`, RPC protocol over WebSocket at `/i/<id>/ws`).
- Added PWA asset serving for per-instance web UI paths, so installing `/i/<id>/` to a mobile home screen keeps the standalone app scoped to that session.
- Added PWA metadata and service worker registration to the server home page, so Android browsers can install it from Add to home screen on supported secure origins.
- Added a kebab ("...") menu per dashboard session row for Rename/Pin/Unpin/Archive/Unarchive/Delete, replacing four-to-five separate buttons; only the name, status, and the primary Open/Resume action stay directly on the row. Only one menu is open at a time and it closes on outside click or Escape.
- Added pagination to the dashboard's session list (10 per page, Prev/Next and a page indicator), so a large session list no longer renders as one long scroll. Pinned sessions still sort first and stay on page 1; "Select all" in select mode selects the current page, not the whole list. The collapsed "Archived" section is unpaginated.
- Added transcript/output serving for async (background) subagent runs in the web UI's subagents panel: their child transcript and output files live next to the session file (`<sessionDir>/subagent-artifacts/`), not under the run's own temp directory, so they previously never populated and the Transcript/Output tabs stayed empty. `GET /i/<id>/subagents/file` now also serves from that directory and from the async run's own directory (for its orchestration-level `output-N.log` and `subagent-log-*.md`, exposed as named files), in addition to the existing foreground `.pi-subagents/artifacts` root.

### Changed

- Removed the "Label" field from the dashboard's new-session/resume forms: session identity is now the session's own name (renameable, or model-generated - see coding-agent). Old records with a stored label still display it when the session has no name of its own; nothing in the dashboard sets a label anymore.

### Fixed

- Fixed the server web dashboard's past-sessions list being scoped to the working-directory field, which hid sessions from other projects; it now lists every session across all project directories, newest first, and scopes to a single directory only when one is typed.
- Fixed the server review page to start from the current branch's GitHub PR by default, creating the PR when one does not already exist.
- Removed the standalone terminal link from the server home page.
- Fixed extension UI requests only reaching the last attached rpc_stream client: requests now fan out to all stream clients, dialog responses are first-response-wins, and other clients receive `extension_ui_cancel`.
- Fixed spawning RPC child processes under Node (the `./rpc-entry` package subpath only declares an `import` condition; resolution now uses `import.meta.resolve`).
- Fixed the `/theme/<name>.json` endpoint (used by the web UI's theme picker) always returning 404: it appended `.json` to a theme name that already carried it from the request path.
- Fixed the supervised instance record (cwd, session id/file) going stale after closing the TUI view from the web UI, since `tui_close` can change any of those (the TUI can `/cd` or `/new` while attached) but was not in the set of commands that refresh it.
- Fixed `/i/<id>/` for an unknown or stopped instance returning a bare-text "Unknown instance" page instead of the web app: it now serves the same SPA shell as a live instance, so the client can render a proper "session not found" state (the WebSocket upgrade still closes with code 4404 for these ids, which the client uses to distinguish this from a transient drop).
- Fixed a malformed line on a supervised instance's RPC child stdout crashing the entire server (an uncaught `JSON.parse` took down every instance, not just the offending one); malformed lines are now dropped, matching the externally-registered-instance socket path.
- Fixed the supervised instance record not refreshing on a live `session_reloaded` push (the TUI writing to the session file while still attached, e.g. `/cd` or `/new` from inside it): only command responses refreshed it before, so the record stayed stale until the TUI closed.
- Fixed the dashboard's cached session name occasionally regressing to a worse fallback (id prefix, or an old label): `get_state` briefly reports no `sessionName` while the coding-agent's model-generated title is still being generated in the background, and the instance record was unconditionally overwritten with whatever `get_state` returned, including that transient absence. The cached name is now only updated when `get_state` reports a non-empty one.
- Fixed the dashboard's select mode shifting the whole session list: entering it toggled per-row checkboxes from `display:none` (indenting every row) and inserted a bulk-actions toolbar above the list (pushing everything down). Checkboxes now reserve their column space via `visibility` instead of `display`, and the bulk toolbar swaps in place of the "Sessions" header line instead of adding a row, so nothing jumps. The "Select" trigger moved from a full button next to the heading to a small text link right-aligned on that same header line.

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

## [0.81.1] - 2026-07-21

## [0.81.0] - 2026-07-21

### Changed

- Renamed the orchestrator workspace package and internal server references to server ([#6898](https://github.com/earendil-works/pi/pull/6898) by [@cristinaponcela](https://github.com/cristinaponcela)).

## [0.80.10] - 2026-07-16

## [0.80.9] - 2026-07-16

## [0.80.8] - 2026-07-16

## [0.80.7] - 2026-07-14

## [0.80.6] - 2026-07-09

## [0.80.5] - 2026-07-09

## [0.80.4] - 2026-07-09

## [0.80.3] - 2026-06-30
