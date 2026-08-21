#!/usr/bin/env bash
# Push the current repair branch even if another Fix run landed commits while
# this job was verifying. Rebase onto origin and retry; do not force-push.
#
# If rebase conflicts because another writer (Cursor, a second Fix click)
# already resolved the same files on origin, take origin's tip instead of
# failing. Do not keep a second competing tree. The caller must then sync
# package-lock.json and let PR CI gate approval.
set -euo pipefail

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  echo "Not on a named branch; refusing to push." >&2
  exit 1
fi

origin_has_conflict_markers() {
  git grep -l '^<<<<<<<' "origin/${BRANCH}" -- . ':(exclude)node_modules' >/dev/null 2>&1
}

git fetch origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date with origin/${BRANCH}"
  echo "used_remote_tip=false"
  exit 0
fi

for attempt in 1 2 3 4 5; do
  echo "Push attempt ${attempt}: rebase onto origin/${BRANCH} then push."
  git fetch origin "$BRANCH"
  if git rebase "origin/${BRANCH}"; then
    if git push origin "HEAD:${BRANCH}"; then
      echo "Pushed ${BRANCH}."
      echo "used_remote_tip=false"
      exit 0
    fi
  else
    echo "Rebase conflicted with origin/${BRANCH}; aborting rebase." >&2
    git rebase --abort || true
    git fetch origin "$BRANCH"
    if origin_has_conflict_markers; then
      echo "origin/${BRANCH} still has conflict markers; not overwriting." >&2
      echo "used_remote_tip=false"
      exit 1
    fi
    echo "origin/${BRANCH} already resolved conflicts; using that tip."
    git reset --hard "origin/${BRANCH}"
    echo "used_remote_tip=true"
    exit 0
  fi
  sleep $((attempt * 4))
done

echo "Could not push ${BRANCH} after retries (non-fast-forward)." >&2
echo "used_remote_tip=false"
exit 1
