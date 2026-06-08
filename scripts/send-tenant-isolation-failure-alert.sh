#!/usr/bin/env bash
# send-tenant-isolation-failure-alert.sh
#
# Sends a Resend email when the daily tenant isolation workflow fails.
# Prefers the admin-dashboard notify webhook (same as core-update); falls back
# to direct Resend when RESEND_API_KEY is set on the runner.
#
# Usage: bash scripts/send-tenant-isolation-failure-alert.sh [log-file]
#
# Env (webhook — preferred, secrets on Netlify admin dashboard):
#   NOTIFY_URL              — ADMIN_DASHBOARD_NOTIFY_URL (e.g. .../api/updates/notify)
#   NOTIFY_SECRET           — CORE_UPDATE_NOTIFY_SECRET
#
# Env (direct Resend fallback — optional GitHub Actions secrets on ycode-mw-tenant):
#   RESEND_API_KEY
#   TENANT_ISOLATION_ALERT_EMAIL or CORE_UPDATE_ALERT_EMAIL
#   CORE_UPDATE_EMAIL_FROM  — optional sender

set -euo pipefail

LOG_FILE="${1:-tenant-isolation.log}"
MAX_CHARS=50000

WORKFLOW_NAME="${GITHUB_WORKFLOW:-Daily tenant isolation check}"
RUN_URL="${GITHUB_RUN_URL:-}"
BRANCH="${GITHUB_REF_NAME:-unknown}"
COMMIT_SHA="${GITHUB_SHA:-unknown}"

if [[ -f "$LOG_FILE" ]]; then
  FAILURE_OUTPUT="$(cat "$LOG_FILE")"
else
  FAILURE_OUTPUT="(log file missing at ${LOG_FILE} — open the Actions run for full output)"
fi

if (( ${#FAILURE_OUTPUT} > MAX_CHARS )); then
  TRUNC=$(( ${#FAILURE_OUTPUT} - MAX_CHARS ))
  FAILURE_OUTPUT="${FAILURE_OUTPUT:0:MAX_CHARS}

...[truncated ${TRUNC} characters; see Actions run for full log]..."
fi

SUMMARY="$(printf '%s\n' "$FAILURE_OUTPUT" | grep -E 'FAIL |AssertionError|Expected|Tests +[0-9]+ failed|✗|×' | head -6 | tr '\n' ' ' | sed 's/  */ /g' || true)"
if [[ -z "$SUMMARY" ]]; then
  SUMMARY="Vitest tenant isolation suite failed (see output below)."
fi

send_via_notify() {
  local url="$1"
  local secret="$2"
  curl -fsS -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "X-Core-Update-Notify-Secret: $secret" \
    -d "$(jq -n \
      --arg event "tenant_isolation_failed" \
      --arg workflowName "$WORKFLOW_NAME" \
      --arg runUrl "$RUN_URL" \
      --arg branch "$BRANCH" \
      --arg commitSha "$COMMIT_SHA" \
      --arg failureOutput "$FAILURE_OUTPUT" \
      --arg summary "$SUMMARY" \
      '{
        event: $event,
        workflowName: $workflowName,
        runUrl: $runUrl,
        branch: $branch,
        commitSha: $commitSha,
        failureOutput: $failureOutput,
        summary: $summary
      }')"
}

send_via_resend() {
  local api_key="$1"
  local to="$2"
  local from="${CORE_UPDATE_EMAIL_FROM:-MasjidWeb Updates <updates@masjidweb.com>}"
  local short_sha="${COMMIT_SHA:0:12}"

  local ai_prompt
  ai_prompt="$(cat <<EOF
Fix tenant isolation regression: ${SUMMARY}

Context: workflow "${WORKFLOW_NAME}" failed on branch ${BRANCH} at commit ${short_sha}.
Actions run: ${RUN_URL}

Reproduce locally:
  cd ycode-mw-tenant && npm ci && bash scripts/check-tenant-isolation.sh

Read masjidweb-backend/docs/TENANCY.md and docs/TENANT_ISOLATION_DAILY_CHECK.md before changing repository scoping.
Do not remove tenant_id filters to make tests pass.
EOF
)"

  local body
  body="$(cat <<EOF
MasjidWeb daily tenant isolation regression check failed.

Workflow: ${WORKFLOW_NAME}
Run: ${RUN_URL}
Branch: ${BRANCH}
Commit: ${COMMIT_SHA}

--- Test failure output (paste into AI agent) ---
${FAILURE_OUTPUT}

--- Suggested AI agent prompt ---
${ai_prompt}

--- References ---
TENANT_ISOLATION_DAILY_CHECK.md: https://github.com/mywebmasteruk/masjidweb-backend/blob/main/docs/TENANT_ISOLATION_DAILY_CHECK.md
TENANCY.md: https://github.com/mywebmasteruk/masjidweb-backend/blob/main/docs/TENANCY.md

Tip: forward this email to a Cursor agent or paste the sections above into a new chat.
EOF
)"

  jq -n \
    --arg from "$from" \
    --arg to "$to" \
    --arg subject "[MasjidWeb] Daily tenant isolation check FAILED" \
    --arg text "$body" \
    '{from: $from, to: [$to], subject: $subject, text: $text}' \
    | curl -fsS -X POST "https://api.resend.com/emails" \
        -H "Authorization: Bearer ${api_key}" \
        -H "Content-Type: application/json" \
        -d @-
}

if [[ -n "${NOTIFY_URL:-}" && -n "${NOTIFY_SECRET:-}" ]]; then
  echo "==> Sending tenant isolation failure alert via admin notify webhook"
  send_via_notify "$NOTIFY_URL" "$NOTIFY_SECRET"
  echo "==> Notify webhook accepted"
  exit 0
fi

ALERT_TO="${TENANT_ISOLATION_ALERT_EMAIL:-${CORE_UPDATE_ALERT_EMAIL:-}}"
if [[ -n "${RESEND_API_KEY:-}" && -n "$ALERT_TO" ]]; then
  echo "==> Sending tenant isolation failure alert via Resend (direct)"
  send_via_resend "$RESEND_API_KEY" "$ALERT_TO"
  echo "==> Resend accepted"
  exit 0
fi

echo "WARN: No alert channel configured."
echo "  Set ADMIN_DASHBOARD_NOTIFY_URL + CORE_UPDATE_NOTIFY_SECRET (preferred),"
echo "  or RESEND_API_KEY + CORE_UPDATE_ALERT_EMAIL on the workflow runner."
exit 0
