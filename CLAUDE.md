# Claude Terminal

> **Required Reading:** See [ARCHITECTURE.md](ARCHITECTURE.md) for full system design, data flow, and patterns.

## Stack
- Vanilla JavaScript, no build step
- Obsidian Plugin API (desktop-only, manifest v1)
- xterm.js (bundled), Python 3 PTY bridge (`pty-bridge.py`)
- CLI backend: Claude Code or Codex (switchable in settings)

## Dev / Deploy
| Task | Command |
|---|---|
| Load plugin | Symlink repo into vault's `.obsidian/plugins/claude-terminal/`, enable in Obsidian |
| Deploy to iCloud vault | `./sync-to-icloud.sh` |
| Reload plugin | Disable + re-enable in Obsidian Community Plugins |

No npm install, no build, no test suite.

## Critical Gotchas
- **Python 3 required** — auto-detected; must be present or set in plugin settings.
- **PATH is extended at spawn** — Obsidian strips PATH; plugin adds `/opt/homebrew/bin`, `~/.local/bin`, TinyTeX, etc.
- **One xterm instance per session** — DOM node is moved on file switch, not recreated (preserves scrollback).
- **Resize via fd 3** — `pty-bridge.py` reads `cols,rows\n` on stdio[3]; plugin writes from `ResizeObserver`.
- **`styles.css` is unused** — all styles are injected as a `<style>` tag in `onload`.
- **`CLAUDECODE` env var deleted** before spawning to avoid confusing the CLI.
