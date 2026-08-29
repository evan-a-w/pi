# @earendil-works/pi-server

Experimental. This package is under active development and may change or be removed without notice. Its CLI, APIs, and behavior are not yet stable.

Server package for pi.

## CLI

```bash
server --help
```

## Web UI

`server serve --web [--web-port <port>] [--web-host <host>]` additionally serves the pi web UI (`@earendil-works/pi-web`) over HTTP/WebSocket and prints a URL with a per-run auth token. The index page lists running instances; each instance is available at `/i/<instance-id>/` and speaks the pi RPC protocol (see `packages/coding-agent/docs/rpc.md`) over WebSocket at `/i/<instance-id>/ws`. Multiple web clients can attach to the same instance; extension dialogs are first-response-wins across all of them.

## Account namespaces

A namespace is a local, non-security grouping of sessions: each one gets its own provider credentials (`auth.json`), settings, and sessions directory, so you can run e.g. a "work" and a "personal" set of AI provider logins on the same server. It is a convenience grouping, not an isolation boundary - anyone with dashboard access can switch a session between namespaces.

The implicit `default` namespace is the normal `~/.pi/agent` directory and always exists; existing sessions and credentials are unaffected. A named namespace lives under `~/.pi/namespaces/<name>/agent` and is created from the dashboard's namespace switcher (or `POST /api/namespaces`). Namespace names are 1-32 characters: lowercase letters, digits, `-`, or `_`.

There is no credentials UI in the dashboard. To log a provider into a namespace, spawn or open any session in it and use the normal TUI/chat auth flow (for example `/login`) - it writes to that namespace's `auth.json` automatically, the same way the default namespace's credentials work today.

The dashboard's namespace switcher filters the session list (or shows "All" with a namespace tag on each row) and the spawn form's namespace select controls which namespace a new session's process runs under. A session's kebab menu has "Move to namespace…": the session's `.jsonl` file never moves, only which namespace's credentials/settings a live process uses. Moving a live session stops it and, if it has a session file, resumes it under the target namespace - the same session continuing under different provider credentials. Pinned sessions keep their namespace across auto-respawn and server restarts.

Deleting a namespace (`POST /api/namespaces/delete`) only removes its registry entry; it refuses while any session still references it, and never deletes the namespace's agent directory or credentials, even when empty. Recreating a namespace with the same name later picks its old credentials back up.
