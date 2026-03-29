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

### 2026-03-29 — Code review: bug fixes and simplification

- **Fix: dead `md` branch** — the markdown-specific initial prompt was identical to the generic fallback; removed the redundant branch.
- **Fix: badge status bug** — sessions with `hasWorked=true` were incorrectly shown as "done" (green checkmark) in file tree badges while still running. Now correctly shown as "paused".
- **Fix: `autoOpen` setting ignored** — the setting existed but was never read; sidebar always auto-opened. Now respects the setting: when disabled, the sidebar only switches sessions if already open.
- **Simplify: consolidate `switchSession` branches** — two identical `if/else if` branches (dead session vs live session) unified into one.
- **Simplify: extract `getSessionStatus()` helper** — session status derivation was duplicated in 3 places; now a single shared function.
- **Performance: reduce triple badge update to single deferred call**, guard MutationObserver when no sessions exist, single `getComputedStyle` call for xterm theme.

## Technical notes

- Terminal: xterm.js (bundled) with FitAddon for auto-sizing.
- PTY: Python 3 bridge script that creates a real PTY pair using `pty.openpty()`, provides full TTY support.
- Process: `~/.local/bin/claude --dangerously-skip-permissions` running in the vault root.
- PATH augmented with TinyTeX, Homebrew, MacTeX, and `~/.local/bin`.
- Resize: `ResizeObserver` on the terminal container → `FitAddon.fit()` → resize command via fd 3 pipe → `SIGWINCH` to the child process.
- File tree badges: `MutationObserver` on file tree containers, re-applied on DOM changes (debounced 150ms).
