#!/usr/bin/env bash
# Push the current repair branch even if another Fix run (or Copilot) landed
# commits while this job was verifying. Rebase onto origin and retry; do not
# force-push — a rebase conflict means click Fix again on a consistent tip.
set -euo pipefail

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  echo "Not on a named branch; refusing to push." >&2
  exit 1
fi

git fetch origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date with origin/${BRANCH}"
  exit 0
fi

for attempt in 1 2 3 4 5; do
  echo "Push attempt ${attempt}: rebase onto origin/${BRANCH} then push."
  git fetch origin "$BRANCH"
  if git rebase "origin/${BRANCH}"; then
    if git push origin "HEAD:${BRANCH}"; then
      echo "Pushed ${BRANCH}."
      exit 0
    fi
  else
    echo "Rebase conflicted with origin/${BRANCH}; aborting rebase." >&2
    git rebase --abort || true
    exit 1
  fi
  sleep $((attempt * 4))
done

echo "Could not push ${BRANCH} after retries (non-fast-forward)." >&2
exit 1
