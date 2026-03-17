#!/bin/zsh
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DST_DIR="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/.obsidian/plugins/claude-terminal"

if [[ ! -d "$DST_DIR" ]]; then
  echo "Destination does not exist: $DST_DIR" >&2
  exit 1
fi

echo "Syncing plugin files to iCloud mirror..."
rsync -av \
  --exclude '.git' \
  --exclude 'data.json' \
  "$SRC_DIR/" "$DST_DIR/"

echo "Done."
