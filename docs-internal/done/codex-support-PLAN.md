# Add Codex CLI Support to Claude Terminal

## Goal
Add a dropdown setting to choose between Claude and Codex as the CLI backend. Same PTY terminal approach — just swap the binary and flags.

## Changes needed

- [x] Add `cliBackend` setting (`'claude'` | `'codex'`) with default `'claude'`
- [x] Add `codexBinaryPath` setting (default: auto-detect)
- [x] Update `_createSession` to resolve the correct binary + flags based on backend
  - Claude: `claude [--dangerously-skip-permissions]`
  - Codex: `codex --full-auto`
- [x] Update settings tab: add dropdown, add codex binary path field, conditionally show claude/codex-specific settings
- [x] Update notice messages to say the right CLI name
- [x] Update ready-detection to also match Codex prompt patterns

## Files
- `main.js` — all changes in this single file

**Status:** DONE
**Date Completed:** 2026-04-04
