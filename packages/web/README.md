# @earendil-works/pi-web

Experimental. This package is under active development and may change or be removed without notice.

Web UI for pi sessions. Speaks the pi RPC protocol over WebSocket and renders a
TUI-like chat interface (same theme files, same layout) that works on desktop
and mobile.

## Development

Two processes are needed:

```bash
# 1. Bridge: spawns `pi --mode rpc` and exposes it over WebSocket + serves theme files
PI_WEB_CWD=/path/to/project npm run dev:bridge --workspace=@earendil-works/pi-web

# 2. Vite dev server (proxies /ws, /theme, and /themes to the bridge on port 4464)
npm run dev --workspace=@earendil-works/pi-web
```

Then open http://localhost:5173.

## Mobile install

The web UI includes PWA metadata and can be installed to the home screen in standalone mode. Browsers generally require a secure origin for true PWA install: HTTPS, or `localhost` during development. Plain HTTP over a LAN IP may fall back to a bookmark with browser chrome.

Bridge environment variables:

- `PI_WEB_BRIDGE_PORT` — bridge listen port (default `4464`)
- `PI_WEB_CWD` — working directory for the spawned pi process
- `PI_WEB_PI_ARGS` — extra args for pi, e.g. `"--provider anthropic --model claude-sonnet-4-5"`

## Protocol

The client uses the exact [RPC protocol](../coding-agent/docs/rpc.md), one JSON
message per WebSocket frame instead of JSONL. On connect it issues `get_state`,
`get_messages`, `get_commands`, and `get_session_stats`, then applies the live
event stream. Reconnects re-sync from scratch; in-flight streaming is recovered
because `message_update` events carry the accumulated partial message.
