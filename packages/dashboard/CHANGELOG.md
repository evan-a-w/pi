# Changelog

## [Unreleased]

### Changed

- Relocated the fork's supervised web dashboard from `packages/server` (now upstream's protocol server) into this package, `@caduc-ai/pi-dashboard`. The supervisor, per-namespace child spawning, dashboard/settings pages, REST and WebSocket surface, and the SPA protocol are unchanged. The `pi-server list|spawn|status|stop|rpc|rpc-stream` IPC subcommands were dropped; the IPC socket itself is kept because `pi --web` and the TUI's `/web` command register running sessions through it.

### Fixed

- Fixed Edit, Delete, and Save doing nothing on the settings page's snippet rows: snippet ids are UUID strings, and interpolating them into inline `onclick` attributes ended the attribute at the id's first quote. Row buttons now carry `data-action` and are wired by one delegated click listener on the list.
