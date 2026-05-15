# AI Agent Terminal

A local Obsidian plugin that provides a right-sidebar AI coding terminal that follows the currently viewed file. Each file gets its own persistent terminal session with status badges in the file tree.

The plugin folder and manifest id intentionally remain `claude-terminal` for compatibility with existing Obsidian enablement, hotkeys, settings, and local workflows.

## How it works

1. **Open / focus** - press `Ctrl+Shift+L`. If the sidebar is closed, it opens and creates a session. If already open, it moves the cursor into the terminal so you can type immediately.
2. **File tracking** - when you switch to a different file in the editor, the sidebar automatically switches to that file's agent session. If no session exists yet, one is created.
3. **Context prompt** - each new session starts with a pre-filled prompt telling the selected agent which file to work on:
   - `.tex` files: full school context with AI-Router and post-worksheet-chain instructions.
   - All other files: `We are working on the file "path/to/file". Read it first, then help me with the following: `
4. **Backend selection** - settings let you choose Claude Code, Codex, or a Custom CLI. Claude Code remains the default.

## Backends

| Backend | Default behavior |
|---------|------------------|
| Claude Code | Auto-detects the Claude binary and can pass `--dangerously-skip-permissions` when enabled. |
| Codex | Auto-detects common installs including `~/.local/bin`, Homebrew, `/usr/local/bin`, and nvm Node versions. Launches with `--sandbox danger-full-access --ask-for-approval never`. |
| Custom CLI | Uses a configured display name, binary path, fixed arguments, and optional editable prompt templates. |

Custom CLI prompt templates support `{filePath}`, `{fileName}`, `{className}`, and `{agentName}`. If a Custom CLI template is empty, AI Agent Terminal falls back to the built-in prompt logic. The settings button **Use current prompts for Custom CLI** copies the built-in generic and `.tex` prompt wording into the editable template fields.

## Session persistence

- Each file gets its own AI agent process. Switching to a different file does not kill the previous session.
- Switching back to a file reattaches the terminal UI with full scroll history.
- Sessions survive sidebar close/reopen because the process keeps running in the background.
- Sessions are cleaned up on plugin unload or Obsidian restart.
- Changing backend in settings closes existing AI Agent Terminal sessions so new terminals use the selected backend.

## Status indicators

### Header dot

The sidebar header shows the current file name and a coloured status dot:

| Dot | Meaning |
|-----|---------|
| Grey `●` | No activity yet |
| Yellow `●` (pulsing) | Working - the selected agent is producing output |
| Yellow `●` (steady) | Paused - waiting for your input |
| Green `●` | Done - process exited |

### File tree badges

Files with active agent sessions get a badge in the file tree:

| Badge | Meaning |
|-------|---------|
| Yellow `●` (pulsing) | Agent is actively working |
| Grey `●` | Session alive, no work done yet |
| Green `✓` | Agent has done work or the process exited |

## Supported file types

tex, md, js, ts, jsx, tsx, css, scss, html, py, rb, rs, go, java, c, cpp, h, hpp, json, yaml, yml, toml, xml, svg, sh, bash, zsh, fish, lua, vim, sql, txt, csv, ini, conf, cfg

## Commands & hotkeys

| Hotkey | Action |
|--------|--------|
| `Ctrl+Shift+L` | Open AI Agent Terminal sidebar / focus terminal if already open |
| *(command palette)* | Open AI Agent Terminal for current file |
| *(command palette)* | Show active AI Agent Terminal sessions |

The session picker lists current sessions, sorted by status, and selecting an entry navigates to the file in the main editor area.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-open for supported files | On | Automatically open the sidebar when viewing a supported file |
| Notify on session exit | On | Show a notification when an agent session process exits |
| CLI backend | Claude Code | Choose Claude Code, Codex, or Custom CLI |
| Python3 path | Auto-detect | Python used by the PTY bridge |
| Extra PATH directories | Empty | Extra directories added when spawning the CLI |
| Idle session timeout | 60 seconds | Auto-close unused sessions after switching away |

## Installation

This is a local plugin.

1. The plugin remains at `.obsidian/plugins/claude-terminal/`.
2. In Obsidian: **Settings -> Community plugins** -> disable Restricted mode -> find **AI Agent Terminal** in the list -> enable it.
3. To reload after updates: disable and re-enable, or use **Reload app without saving**.

## Relationship to PDF Fit Viewer

This plugin is independent from the PDF Fit Viewer plugin. They use the same underlying technology (xterm.js + Python PTY bridge) but serve different purposes:

- PDF Fit Viewer: Claude Chat is tied to PDF viewing. Sessions are keyed by `.tex` source file, triggered from the PDF toolbar. Optimised for the worksheet fix-compile-deploy loop.
- AI Agent Terminal: works with any supported text file you're viewing. Sessions are keyed by file path. General-purpose Claude Code, Codex, or custom agent access from within Obsidian.

Both can run simultaneously without conflict. They use separate session maps and separate sidebar view types.

## Changelog

### 2026-05-15 - AI Agent Terminal rebrand and Custom CLI backend

- Rebranded visible plugin UI, commands, notices, settings, manifest, and docs to AI Agent Terminal while keeping the `claude-terminal` id and folder.
- Added `claude`, `codex`, and `custom` backend support.
- Updated Codex launch flags to `--sandbox danger-full-access --ask-for-approval never`.
- Added Codex auto-detection for `~/.local/bin`, Homebrew, `/usr/local/bin`, and nvm Node installs.
- Added Custom CLI display name, binary path, fixed arguments, prompt templates, and a settings button to copy the built-in prompt wording.
- Closed existing sessions when changing backend in settings so newly opened terminals use the selected backend.

### 2026-03-29 - Code review: bug fixes, customization, and simplification

Bug fixes:
- Fix: dead `md` branch - the markdown-specific initial prompt was identical to the generic fallback; removed.
- Fix: badge status bug - sessions with `hasWorked=true` were incorrectly shown as "done" in file tree badges while still running. Now correctly shown as "paused".
- Fix: `autoOpen` setting ignored - the setting existed but was never read. Now respects the setting.

New settings:
- Claude binary path - custom path to the Claude Code binary.
- Python3 path - custom path to Python 3.
- Extra PATH directories - comma-separated list of additional PATH entries for the spawned CLI.
- Skip permission prompts - toggle `--dangerously-skip-permissions` flag.
- Terminal font size - xterm font size.
- Terminal scrollback lines - scrollback buffer size.
- Idle session timeout - seconds before unused sessions are auto-closed.

Architecture:
- PTY bridge extracted to `pty-bridge.py` - standalone file loaded at runtime instead of embedded string.
- stdout/stderr listeners moved to `_createSession` - prevents double-output on reattach.

Simplification:
- Consolidate identical `switchSession` branches, extract `getSessionStatus()` helper.
- Reduce triple badge update to single deferred call, guard observers when no sessions.
- Sync script auto-detects vault direction.

## Technical notes

- Terminal: xterm.js with FitAddon for auto-sizing.
- PTY: Python 3 bridge script that creates a real PTY pair using `pty.openpty()`.
- Process cwd: vault root.
- PATH: augmented with TinyTeX, Homebrew, MacTeX, `~/.local/bin`, detected backend binary directory, and configured extra directories.
- File tree badges: `MutationObserver` on file tree containers, re-applied on DOM changes.
