# Claude Terminal — Architecture

## Purpose
An Obsidian desktop plugin that adds a right-sidebar terminal running Claude Code (or Codex CLI) in a real PTY. The terminal follows the active file — each file gets its own persistent session with status badges shown in the file tree.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Plugin host | Obsidian Plugin API (manifest v1, desktop-only) |
| UI / language | Vanilla JavaScript (no build step, no TypeScript) |
| Terminal emulator | xterm.js (bundled: `xterm.js`, `addon-fit.js`, `xterm.css`) |
| PTY bridge | Python 3 (`pty-bridge.py`) — spawns CLI in a real PTY |
| CLI backend | Claude Code (`~/.local/bin/claude`) or Codex CLI (auto-detected) |
| Styling | Inline `<style>` injected at load + `styles.css` (unused/legacy) |

---

## Folder Structure

```
Claude-Terminal/
├── main.js              # Entire plugin — all classes, logic, styles
├── pty-bridge.py        # Python PTY wrapper (spawned as child process)
├── xterm.js             # Bundled xterm.js terminal emulator
├── addon-fit.js         # Bundled xterm FitAddon
├── xterm.css            # Bundled xterm base styles
├── manifest.json        # Obsidian plugin manifest
├── data.json            # Persisted plugin settings (written by Obsidian)
├── sync-to-icloud.sh    # Deploy script: copies plugin folder to iCloud vault
├── styles.css           # Legacy/unused stylesheet
└── docs-internal/
    └── done/
        └── codex-support-PLAN.md   # Completed feature plan
```

---

## Key Modules (all in `main.js`)

| Class / Function | Responsibility |
|---|---|
| `ClaudeTerminalPlugin` | Plugin lifecycle (`onload`/`onunload`), session map, workspace event listeners, commands, file-tree badges |
| `ClaudeTerminalView` | Obsidian `ItemView` — renders header + xterm terminal in right sidebar, manages attach/detach across file switches |
| `ClaudeTerminalSettingTab` | Settings UI — backend picker, binary paths, appearance, timeouts |
| `SessionPickerModal` | Fuzzy-search modal to jump between open sessions |
| `getSessionStatus()` | Derives `idle / working / active / paused / done` from session state flags |
| `isSupportedFile()` | Checks file extension against `SUPPORTED_EXTENSIONS` set |

---

## Data Flow

```
User focuses a file
        │
        ▼
ClaudeTerminalPlugin._onFileFocused()
        │  looks up sessions Map (fileKey → session)
        ▼
ClaudeTerminalView.switchSession()
        │
        ├─ session exists → _attachTerminal() (reuse xterm instance)
        │
        └─ no session → _createSession()
                │
                ├─ spawn: python3 pty-bridge.py <claude|codex> [flags]
                │         cwd = vault root
                │         stdio[3] = resize pipe
                │
                ├─ wait for CLI ready prompt (>, ❯, "Claude", "Codex")
                │
                └─ send context-aware initial prompt via stdin
                        │
                        ▼
                proc.stdout → session.terminal.write()  (xterm renders)
                session.terminal.onData() → proc.stdin.write()  (user input)
                ResizeObserver → fitAddon.fit() + resize pipe → pty-bridge SIGWINCH
```

**Session state flags** (on each session object):

| Flag | Meaning |
|---|---|
| `isWorking` | stdout received in last 3 s |
| `hasWorked` | any output ever received |
| `userInteracted` | user typed at least once |
| `exited` | process has exited |
| `initialPromptSent` | context prompt already sent |

**Settings persistence:** Obsidian calls `loadData()` / `saveData()` → writes to `data.json`.

---

## Important Patterns & Conventions

- **No build step.** Load via Obsidian's "Load unpacked plugin" or symlink. `sync-to-icloud.sh` deploys to the iCloud vault.
- **One xterm instance per session, not per view.** On file switch, the terminal DOM node is moved (`appendChild`), not recreated. This preserves scrollback across switches.
- **PTY via Python.** Obsidian's Node.js `child_process.spawn` cannot allocate a PTY directly; `pty-bridge.py` uses `os.fork` + `pty.openpty` to give the CLI a proper TTY (required for colors, interactive prompts, escape sequences).
- **Resize over fd 3.** `pty-bridge.py` reads `cols,rows\n` from file descriptor 3 (the 4th stdio pipe) and sends `SIGWINCH` to the child. The plugin writes to `proc.stdio[3]` from the `ResizeObserver`.
- **Context-aware initial prompt.** `.tex` files get a school-specific prompt (reads AI-Router, runs post-worksheet-chain). All other files get a generic "read the file first" prompt.
- **File-tree badges.** A `MutationObserver` watches `.nav-files-container` (standard) and `.oz-file-tree-files` (Oz File Tree plugin). Badges are re-injected on every DOM change.
- **Auto-close timer.** Sessions with no user interaction are killed after `idleSessionTimeout` seconds (default 60 s) when the user navigates away.
- **xterm loading.** Tries `window.require` (Electron cache) first, falls back to reading the file and evaluating as UMD via `new Function`.

---

## Known Quirks & Gotchas

- **Desktop-only.** `isDesktopOnly: true` in manifest. Will not load in the mobile app.
- **Python 3 required.** Auto-detected at `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `/usr/bin/python3`. If none exist, the session will not start — set the path in settings.
- **PATH is extended at spawn time.** Obsidian's process inherits a stripped macOS GUI PATH. The plugin prepends common tool directories (`~/.local/bin`, `/opt/homebrew/bin`, TinyTeX, TeX Live). Add extras via the "Extra PATH directories" setting.
- **Codex binary auto-detection** scans nvm version directories in reverse order (newest first). If codex lives in an nvm-managed node, this should find it.
- **xterm cache bust.** `delete nodeRequire.cache[...]` is called before each load to avoid stale modules after plugin reload.
- **`CLAUDECODE` env var is deleted** before spawning to avoid confusing the CLI about its environment.
- **`styles.css` is not used.** All styles are injected via a `<style>` tag in `onload`. The CSS file appears to be a legacy artifact.
