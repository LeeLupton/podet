#!/bin/bash
# Installs dependencies so tests and linters work in Claude Code on the web.
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

# Ensure origin/HEAD is set so commands that diff against the default branch
# (e.g. the built-in /security-review's `git diff origin/HEAD...`) resolve a
# range instead of failing with "ambiguous argument 'origin/HEAD'". Containers
# that fetch specific branches (rather than a full clone) leave this ref unset.
if git rev-parse --git-dir >/dev/null 2>&1; then
  git remote set-head origin --auto >/dev/null 2>&1 \
    || git remote set-head origin main >/dev/null 2>&1 \
    || true
fi

# Only needed in the remote (web) environment; local setups manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Idempotent and cache-friendly (npm install over npm ci so the cached container
# state is reused across sessions).
npm install
