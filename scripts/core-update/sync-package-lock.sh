#!/usr/bin/env bash
# Always reconcile package-lock.json to package.json after source repairs.
# Conflict-marker detection is not enough: a resolved lockfile can still be
# out of sync and fail `npm ci` (PR #46).
set -euo pipefail

if [ -f package-lock.json ] && grep -qE '^(<<<<<<<|=======|>>>>>>>)' package-lock.json; then
  echo "package-lock.json still has conflict markers — starting from origin/main's lockfile."
  git show origin/main:package-lock.json > package-lock.json
fi

npm install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps

git add package-lock.json
if git diff --cached --quiet -- package-lock.json; then
  echo "package-lock.json already in sync with package.json."
  exit 0
fi

git commit -m "fix(deps): sync package-lock.json for safe update [automated]"
echo "Committed package-lock.json to match package.json."
