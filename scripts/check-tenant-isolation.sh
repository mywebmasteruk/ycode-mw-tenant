#!/usr/bin/env bash
# check-tenant-isolation.sh
#
# Runs MasjidWeb tenant-isolation regression tests (Vitest, no live Supabase).
# Used by PR CI and the daily tenant-isolation GitHub Actions workflow.
#
# Usage: bash scripts/check-tenant-isolation.sh
#
# Exit 0 = all isolation tests passed. Non-zero = regression detected.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx not found. Install Node.js 20+ and run npm ci first." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "==> Installing dependencies (node_modules missing)"
  npm ci
fi

# Keep in sync with masjidweb-backend/docs/TENANT_ISOLATION_DAILY_CHECK.md
TENANT_ISOLATION_TESTS=(
  lib/masjidweb/update-safety-check.test.ts
  lib/masjidweb/tenant-or-legacy-scope.test.ts
  lib/masjidweb/tenant-session-alignment.test.ts
  lib/masjidweb/bootstrap-tenant-owner.test.ts
  lib/masjidweb/provisioned-tenant-rbac.test.ts
  lib/masjidweb/auth-users-tenant-scope.test.ts
  lib/masjidweb/apply-tenant-eq.test.ts
  lib/masjidweb/collection-item-timestamp-scope.test.ts
  lib/masjidweb/tenant-cache-tags.test.ts
  lib/masjidweb/api-keys-form-submissions-rls-migration.test.ts
  lib/repositories/apiKeyRepository.test.ts
  lib/repositories/formSubmissionRepository.test.ts
  lib/repositories/mcpTokenRepository.test.ts
  lib/mcp-token-route-tenant-context.test.ts
  lib/tenant/middleware-utils.test.ts
  lib/useAuthStore.test.ts
  lib/asset-proxy-response.test.ts
)

echo "==> Tenant isolation regression tests (${#TENANT_ISOLATION_TESTS[@]} files)"
echo "    Repo: ${REPO_ROOT}"
echo ""

npx vitest run "${TENANT_ISOLATION_TESTS[@]}"

echo ""
echo "==> Tenant isolation checks passed."
