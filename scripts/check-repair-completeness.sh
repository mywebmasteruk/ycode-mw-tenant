#!/usr/bin/env bash
# check-repair-completeness.sh
#
# Post-AI-repair guard: confirm that critical exports/functions survived the
# AI conflict resolution. Run after ai-repair-safe-update before committing
# so a truncated file cannot silently ship.
#
# Usage: bash scripts/check-repair-completeness.sh [--changed-files file]
#
# If --changed-files is supplied, only checks files that appear in that list.
# Without it, checks all critical files unconditionally.
#
# Exit 0 = all checks pass. Non-zero = at least one check failed (will abort
# the repair workflow step).

set -euo pipefail

CHANGED_FILES_ARG="${1:-}"
CHANGED_LIST_FILE=""
if [[ "$CHANGED_FILES_ARG" == "--changed-files" ]]; then
  CHANGED_LIST_FILE="${2:-}"
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

# ---------------------------------------------------------------------------
# Helper: check that every listed symbol exists in the file
# ---------------------------------------------------------------------------
check_symbols() {
  local file="$1"; shift
  local full_path="${REPO_ROOT}/${file}"

  # If a changed-files list was given, skip files not in it
  if [[ -n "$CHANGED_LIST_FILE" ]] && [[ -f "$CHANGED_LIST_FILE" ]]; then
    if ! grep -qF "$file" "$CHANGED_LIST_FILE"; then
      return 0
    fi
  fi

  if [[ ! -f "$full_path" ]]; then
    echo "SKIP (not found): $file"
    return 0
  fi

  local missing=0
  for symbol in "$@"; do
    if ! grep -qF "$symbol" "$full_path"; then
      echo "MISSING in $file: $symbol"
      missing=1
    fi
  done

  if [[ "$missing" -eq 0 ]]; then
    echo "OK: $file"
  else
    FAIL=1
  fi
}

# ---------------------------------------------------------------------------
# Helper: check that getSupabaseAdmin is NOT called with arguments
#         (the invalid getSupabaseAdmin(tenantId) pattern introduced by AI)
# ---------------------------------------------------------------------------
check_no_admin_with_args() {
  local file="$1"
  local full_path="${REPO_ROOT}/${file}"

  if [[ -n "$CHANGED_LIST_FILE" ]] && [[ -f "$CHANGED_LIST_FILE" ]]; then
    if ! grep -qF "$file" "$CHANGED_LIST_FILE"; then
      return 0
    fi
  fi

  if [[ ! -f "$full_path" ]]; then
    return 0
  fi

  # getSupabaseAdmin() is valid; getSupabaseAdmin(anything) is not
  if grep -nE 'getSupabaseAdmin\([^)]+\)' "$full_path"; then
    echo "ERROR in $file: getSupabaseAdmin() called with arguments (invalid pattern)"
    FAIL=1
  else
    echo "OK (no getSupabaseAdmin misuse): $file"
  fi
}

# ---------------------------------------------------------------------------
# Critical symbol checks
# collectionItemRepository: stage/unpublish/publish helpers were truncated by
# AI repair in commit 084af0b and had to be restored manually (c53d63d).
# ---------------------------------------------------------------------------
check_symbols \
  "lib/repositories/collectionItemRepository.ts" \
  "stageSingleItem" \
  "publishSingleItem" \
  "unpublishSingleItem" \
  "publishItem" \
  "getItemsByCollectionId" \
  "applyTenantEq" \
  "resolveEffectiveTenantId"

# mcpTokenRepository: validateToken + createToken + deleteToken are the core ops.
# The public authenticateToken wrapper lives in lib/mcp/handler.ts (also checked below).
check_symbols \
  "lib/repositories/mcpTokenRepository.ts" \
  "validateToken" \
  "createToken" \
  "deleteToken"

# mcp/handler: authenticateToken must return McpToken (not void/boolean) for
# URL-based MCP tenant routing (regression introduced by AI repair in 084af0b,
# fixed in c53d63d).
check_symbols \
  "lib/mcp/handler.ts" \
  "authenticateToken"

# pageRepository: must retain tenant-scoped getAllPages
check_symbols \
  "lib/repositories/pageRepository.ts" \
  "getAllPages" \
  "getPageById" \
  "applyTenantEq"

# collectionFieldRepository: must retain getFieldsByCollectionId
check_symbols \
  "lib/repositories/collectionFieldRepository.ts" \
  "getFieldsByCollectionId"

# Key MasjidWeb lib files that must keep their bootstrap/role helpers
check_symbols \
  "lib/masjidweb/bootstrap-tenant-owner.ts" \
  "bootstrapTenantOwnerIfNeeded" \
  "tenantHasOwnerOrAdmin" \
  "isPendingTenantInvite"

check_symbols \
  "lib/roles.ts" \
  "resolveRole" \
  "canManageMembers" \
  "ASSIGNABLE_ROLES"

check_symbols \
  "lib/roles-server.ts" \
  "requireManageMembers" \
  "getCallerInfo"

# Auth routes must gate invite on requireManageMembers
check_symbols \
  "app/(builder)/ycode/api/auth/invite/route.ts" \
  "requireManageMembers"

# ---------------------------------------------------------------------------
# No-args getSupabaseAdmin misuse scan on touched repositories
# ---------------------------------------------------------------------------
check_no_admin_with_args "lib/repositories/collectionItemRepository.ts"
check_no_admin_with_args "lib/repositories/assetRepository.ts"
check_no_admin_with_args "lib/repositories/pageRepository.ts"
check_no_admin_with_args "lib/repositories/pageLayersRepository.ts"
check_no_admin_with_args "lib/mcp/handler.ts"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [[ "$FAIL" -ne 0 ]]; then
  echo ""
  echo "COMPLETENESS CHECK FAILED: one or more critical exports are missing or"
  echo "getSupabaseAdmin() was called with arguments. The AI repair likely"
  echo "truncated or corrupted one of the files above. Review the diff and"
  echo "restore the missing code before merging."
  exit 1
else
  echo ""
  echo "Completeness check passed."
fi
