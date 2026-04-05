# Claude Terminal

Obsidian plugin — right-sidebar Claude Code terminal that follows the active file. Persistent sessions per file with status badges.

## Stack
- JavaScript (vanilla), CSS
- Obsidian Plugin API (manifest v1)
- Python pty-bridge for terminal I/O

## Dev
- No build step — load as Obsidian community plugin via symlink
- `sync-to-icloud.sh` copies plugin to iCloud vault's plugins dir
