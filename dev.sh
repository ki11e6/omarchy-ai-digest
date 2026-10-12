#!/bin/bash
#
# Install this plugin into the local Omarchy config for development and
# restart the shell. Safe to re-run; the destination is fully synced.

set -euo pipefail

ID="io.github.ki11e6.ai-digest"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.config/omarchy/plugins/$ID"

mkdir -p "$DEST"
rsync -a --delete --exclude '.git' --exclude '.github' --exclude 'docs' --exclude 'test' --exclude 'dev.sh' --exclude '.gitignore' "$SRC/" "$DEST/"
omarchy plugin validate "$DEST"
omarchy-restart-shell
# Enable must run after the restart: on first install the running shell
# hasn't discovered the new plugin directory yet and enable fails.
omarchy plugin enable "$ID" || echo "enable failed; run: omarchy plugin enable $ID" >&2
