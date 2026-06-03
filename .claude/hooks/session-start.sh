#!/bin/bash
# Installs dependencies so tests and linters work in Claude Code on the web.
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

# Only needed in the remote (web) environment; local setups manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Idempotent and cache-friendly (npm install over npm ci so the cached container
# state is reused across sessions).
npm install
