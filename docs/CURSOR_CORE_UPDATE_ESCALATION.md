# Cursor cloud agent — core update escalation

Use this document as the **instructions** for a Cursor Automation (cloud runtime) that runs when a `safe-ycode-update/*` pull request still has failing CI after mechanical repair.

## When to run

Proceed **only if all** are true:

1. The failed check is on repo `mywebmasteruk/ycode-mw-tenant`.
2. The pull request head branch starts with `safe-ycode-update/`.
3. CI or `AI repair safe update PR` workflow **failed** (do not act on green runs).

If mechanical repair already fixed everything and CI is green, **stop** — no changes needed.

## Goal

Resolve **remaining** merge conflicts on the PR branch, preserve MasjidWeb tenant isolation, pass local verification, push to the **same PR branch**. **Never merge** the PR and **never push to `main`**.

## Required reading (in repo)

1. `docs/masjidweb-core-seams.md`
2. `masjidweb-backend/docs/TENANCY.md` (tenant isolation contract)
3. `masjidweb-backend/docs/MT_VALIDATION_CHECKLIST.md` (if auth/proxy/repositories changed)

## Fix order

1. Check out the **PR head branch** (not `main`).
2. List conflict markers: `git grep -l '^<<<<<<<' -- . ':(exclude)node_modules'` or `git diff --name-only --diff-filter=U`.
3. **Mechanical tier-2 first** (no LLM guesswork for known repos):
   ```bash
   git fetch origin main
   git remote add upstream https://github.com/ycode/ycode.git 2>/dev/null || true
   git fetch upstream main
   npx --yes tsx scripts/ai-repair-safe-update.ts
   ```
   Set `AI_REPAIR_MECHANICAL_ONLY=true` and `AI_REPAIR_SKIP_TIER2_LLM=true` if invoking the script directly.
4. For remaining conflicts in routes/services/auth/proxy: merge manually or run full repair with OpenRouter only if `OPENROUTER_API_KEY` is available in the environment (otherwise fix by hand using seam doc).
5. **Never** remove `tenant_id` filters, `applyTenantEq`, `resolveEffectiveTenantId`, cookie-domain helpers, or `/ycode/accept-invite` standalone behavior to “make it compile.”

## Verification (must pass before push)

```bash
npm run type-check
npm run updates:safety-check
npx vitest run \
  lib/masjidweb/bootstrap-tenant-owner.test.ts \
  lib/masjidweb/provisioned-tenant-rbac.test.ts
bash scripts/check-repair-completeness.sh
npm run build
```

Also confirm **zero** conflict markers remain.

## Commit and push

- One commit message: `fix(ai): resolve safe update conflicts [cursor escalation]`
- Push to the **PR head branch** only.
- Comment on the PR: what you fixed, what was deferred, and that the operator should refresh Maintenance and wait for CI green before Approve merge.

## Hard stops (do not proceed)

- Would weaken tenant isolation or remove MasjidWeb seams without re-applying them
- `check-repair-completeness.sh` fails (truncated file / missing exports)
- Build or type-check still fails after one focused retry
- Touching magic-link / invite / cookie domain without reading fragile-flow sources listed in workspace rules

In those cases: push nothing, comment on the PR with the blocker, and stop.
