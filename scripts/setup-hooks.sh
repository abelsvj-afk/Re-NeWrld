#!/bin/sh
# Installs the repo's committed git hooks into .git/hooks.
set -e
HOOK_DIR="$(git rev-parse --git-dir)/hooks"
cp scripts/hooks/pre-push "$HOOK_DIR/pre-push"
chmod +x "$HOOK_DIR/pre-push"
echo "Installed pre-push hook into $HOOK_DIR/pre-push"
