#!/usr/bin/env bash
# ───────────────────────────────────────────────────────
# Unix shim for the cross-platform updater (updater.mjs).
# Invoked by the running SynaBun server inside a fresh
# terminal window — keeps the terminal open after node
# exits so the user can read npm output and any errors.
# ───────────────────────────────────────────────────────

set +e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${SYNABUN_NODE_BIN:-node}"

# Pretty terminal title (no-op in some terminals).
printf '\033]0;SynaBun Updater\007' 2>/dev/null || true

"$NODE_BIN" "$SCRIPT_DIR/updater.mjs" "$@" --no-hold
EXIT_CODE=$?

echo
if [ "$EXIT_CODE" = "0" ]; then
  echo "[Update finished. Press Enter to close this window.]"
else
  echo "[Update exited with code $EXIT_CODE. Press Enter to close this window.]"
fi
# Read one line. If stdin is closed (e.g. piped run), fall through immediately.
read -r _ || true

exit $EXIT_CODE
