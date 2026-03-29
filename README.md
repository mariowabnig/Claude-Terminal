# Claude Terminal

A local Obsidian plugin that provides a right-sidebar Claude Code terminal that follows the currently viewed file. Each file gets its own persistent terminal session with status badges in the file tree.

## How it works

1. **Open / focus** — press `Ctrl+Shift+L`. If the sidebar is closed, it opens and creates a session. If already open, it moves the cursor into the terminal so you can type immediately. The shortcut never closes the sidebar.
2. **File tracking** — when you switch to a different file in the editor, the sidebar automatically switches to that file's Claude session. If no session exists yet, one is created.
3. **Context prompt** — each new session starts with a pre-filled prompt telling Claude which file to work on:
   - `.tex` files: full school context (AI-Router, post-worksheet-chain instructions, class info)
   - All other files: `We are working on "path/to/file". Read it first, then help me with the following: `
4. **You type your request** — the terminal auto-focuses after the prompt appears, so your cursor is already at the end. Just type what you want Claude to fix/change and press Enter.

## Session persistence

- Each file gets its own Claude Code process. Switching to a different file **does not kill** the previous session.
- Switching back to a file reattaches the terminal UI with full scroll history — you can see everything Claude did.
- Sessions survive sidebar close/reopen (the process keeps running in the background).
- Sessions are cleaned up on plugin unload or Obsidian restart.

## Status indicators

### Header dot

The sidebar header shows the current file name and a coloured status dot:

| Dot | Meaning |
|-----|---------|
| Grey `●` | No activity yet |
| Yellow `●` (pulsing) | Working — Claude is producing output |
| Yellow `●` (steady) | Paused — waiting for your input |
| Green `●` | Done — process exited |

### File tree badges

Files with active Claude sessions get a badge in the file tree (both the alternative file tree plugin and Obsidian's native explorer):

| Badge | Meaning |
|-------|---------|
| Yellow `●` (pulsing) | Claude is actively working |
| Grey `●` | Session alive, no work done yet |
| Green `✓` | Claude has done work (task completed or process exited) |

Badges turn green as soon as Claude finishes working on a task — even if the process is still alive and waiting for the next instruction. They stay green so you can see which files Claude has worked on.

## Supported file types

tex, md, js, ts, jsx, tsx, css, scss, html, py, rb, rs, go, java, c, cpp, h, hpp, json, yaml, yml, toml, xml, svg, sh, bash, zsh, fish, lua, vim, sql, txt, csv, ini, conf, cfg

## Commands & hotkeys

| Hotkey | Action |
|--------|--------|
| `Ctrl+Shift+L` | Open Claude Terminal sidebar / focus terminal if already open |
| *(command palette)* | Open Claude Terminal for current file |
| *(command palette)* | Show active Claude sessions |

### Session picker

**"Show active Claude sessions"** in the command palette opens a fuzzy-search modal listing all current sessions. Each entry shows:
- File name and parent directory
- Status: `● Working` / `● Active` (user typed something) / `○ Idle` (never used) / `✓ Done`
- Sorted by status — working sessions first, done sessions last

Selecting an entry **navigates to the file** in the main editor area (reuses an existing tab if already open) and switches the sidebar terminal to that session.

### Auto-close unused sessions

To avoid accumulating idle Claude processes when browsing through files, sessions that were **never interacted with** (no user keystrokes) are automatically killed after **60 seconds** of being switched away from. Sessions where you typed anything are never auto-closed — they persist until the process exits or the plugin is unloaded.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-open for supported files | On | Automatically open the sidebar when viewing a supported file |
| Notify on session exit | On | Show a notification when a Claude session process exits |
| Claude binary path | *(auto-detect)* | Path to the Claude Code binary. Leave empty for `~/.local/bin/claude` |
| Python3 path | *(auto-detect)* | Path to Python 3 binary. Leave empty to search common locations |
| Extra PATH directories | *(empty)* | Comma-separated extra directories added to PATH when spawning Claude |
| Skip permission prompts | On | Pass `--dangerously-skip-permissions` to Claude Code |
| Terminal font size | 13 | xterm terminal font size |
| Terminal scrollback lines | 10000 | Lines kept in terminal scrollback buffer |
| Idle session timeout | 60 | Seconds before unused sessions are auto-closed (0 = never) |

## Relationship to PDF Fit Viewer

This plugin is **independent** from the PDF Fit Viewer plugin. They use the same underlying technology (xterm.js + Python PTY bridge) but serve different purposes:

- **PDF Fit Viewer** → Claude Chat is tied to PDF viewing. Sessions are keyed by `.tex` source file, triggered from the PDF toolbar. Optimised for the worksheet fix-compile-deploy loop.
- **Claude Terminal** → works with any text file you're viewing. Sessions are keyed by file path. General-purpose Claude Code access from within Obsidian.

Both can run simultaneously without conflict. They use separate session maps and separate sidebar view types.

## Installation

This is a local plugin.

1. The plugin is already at `.obsidian/plugins/claude-terminal/`.
2. In Obsidian: **Settings → Community plugins** → disable Restricted mode → find **Claude Terminal** in the list → enable it.
3. To reload after updates: disable and re-enable, or use **Reload app without saving**.

## Changelog

### 2026-03-29 — Code review: bug fixes, customization, and simplification

**Bug fixes:**
- **Fix: dead `md` branch** — the markdown-specific initial prompt was identical to the generic fallback; removed.
- **Fix: badge status bug** — sessions with `hasWorked=true` were incorrectly shown as "done" in file tree badges while still running. Now correctly shown as "paused".
- **Fix: `autoOpen` setting ignored** — the setting existed but was never read. Now respects the setting.

**New settings:**
- **Claude binary path** — custom path to the Claude Code binary (default: auto-detect `~/.local/bin/claude`)
- **Python3 path** — custom path to Python 3 (default: auto-detect common locations)
- **Extra PATH directories** — comma-separated list of additional PATH entries for Claude's environment
- **Skip permission prompts** — toggle `--dangerously-skip-permissions` flag (default: on)
- **Terminal font size** — xterm font size (default: 13)
- **Terminal scrollback lines** — scrollback buffer size (default: 10,000)
- **Idle session timeout** — seconds before unused sessions are auto-closed (default: 60, set 0 to disable)

**Architecture:**
- **PTY bridge extracted to `pty-bridge.py`** — standalone file loaded at runtime instead of embedded string.
- **stdout/stderr listeners moved to `_createSession`** — prevents double-output on reattach.

**Simplification:**
- Consolidate identical `switchSession` branches, extract `getSessionStatus()` helper.
- Reduce triple badge update to single deferred call, guard observers when no sessions.
- Sync script auto-detects vault direction (iCloud ↔ OneDrive).

## Technical notes

- Terminal: xterm.js (bundled) with FitAddon for auto-sizing.
- PTY: `pty-bridge.py` — Python 3 script that creates a real PTY pair using `pty.openpty()`, provides full TTY support.
- Process: Claude Code binary (configurable) running in the vault root.
- PATH augmented with TinyTeX, Homebrew, MacTeX, `~/.local/bin`, and user-configured extra directories.
- Resize: `ResizeObserver` on the terminal container → `FitAddon.fit()` → resize command via fd 3 pipe → `SIGWINCH` to the child process.
- File tree badges: `MutationObserver` on file tree containers, re-applied on DOM changes (debounced 150ms).
