#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# The front end is dependency-free: node's built-in test runner (`node --test`)
# and `node --check` need nothing installed. The one tool a fresh web session
# lacks is Deno, which CI uses to type-check the Supabase Edge Functions
# (`deno check supabase/functions/*/index.ts`) — install it so those checks work
# here too. Idempotent and non-interactive; safe to re-run.
set -euo pipefail

# Only needed in the remote (web) environment; do nothing on a local machine.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install Deno if it isn't already present (cached containers skip the download).
if ! command -v deno >/dev/null 2>&1 && [ ! -x "$HOME/.deno/bin/deno" ]; then
  curl -fsSL https://deno.land/install.sh | sh -s -- -y >/dev/null 2>&1 || true
fi

# Persist Deno on PATH for the rest of the session.
if [ -x "$HOME/.deno/bin/deno" ]; then
  echo "export PATH=\"$HOME/.deno/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
