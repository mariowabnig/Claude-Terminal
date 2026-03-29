#!/bin/zsh
set -euo pipefail

# Syncs plugin files between the two Obsidian vaults (iCloud ↔ OneDrive).
# Run from either vault — detects which one you're in and syncs to the other.

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_NAME="claude-terminal"

ICLOUD_DIR="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/.obsidian/plugins/$PLUGIN_NAME"
ONEDRIVE_DIR="$HOME/Library/CloudStorage/OneDrive-Bundesrealgymnasium/.obsidian/plugins/$PLUGIN_NAME"

if [[ "$SRC_DIR" == "$ICLOUD_DIR" ]]; then
  DST_DIR="$ONEDRIVE_DIR"
  echo "Syncing from iCloud → OneDrive..."
elif [[ "$SRC_DIR" == "$ONEDRIVE_DIR" ]]; then
  DST_DIR="$ICLOUD_DIR"
  echo "Syncing from OneDrive → iCloud..."
else
  echo "Error: Script is not inside either known vault location." >&2
  echo "  Expected: $ICLOUD_DIR" >&2
  echo "       or: $ONEDRIVE_DIR" >&2
  exit 1
fi

if [[ ! -d "$DST_DIR" ]]; then
  echo "Destination does not exist: $DST_DIR" >&2
  exit 1
fi

rsync -av \
  --exclude '.git' \
  --exclude 'data.json' \
  "$SRC_DIR/" "$DST_DIR/"

echo "Done."
