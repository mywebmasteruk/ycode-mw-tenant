# Core update process

This repository is a MasjidWeb production fork of Ycode. It contains MasjidWeb-specific tenant isolation, authentication, deployment, and safety changes inside core Ycode paths.

Do not apply upstream Ycode updates directly to `main`, and do not use one-click "Sync fork" for production without review.

**Operator workflow (prepare → preview → approve → full rollback):** see [CORE_UPDATE_WORKFLOW.md](../../masjidweb-backend/docs/CORE_UPDATE_WORKFLOW.md) in the admin backend repo.

## Current in-app update behavior

The builder update screen is informational only:

- it checks official `ycode/ycode` GitHub releases;
- it compares the latest release with `package.json` version;
- it shows release notes and MasjidWeb-safe update instructions;
- it does not download or rewrite local source files.

For this fork, do not use generic Ycode "Sync fork" instructions. Use the MasjidWeb safe update workflow in GitHub Actions.

## Why upstream updates are risky

Tenant isolation depends on app-layer filters because service-role Supabase clients bypass Postgres RLS. Upstream updates can overwrite or conflict with those filters and related auth/session behavior.

High-risk areas include:

- `proxy.ts` and tenant header/JWT alignment;
- Supabase auth, callback, invite, session, and magic-link code;
- `lib/supabase-*` server/browser helpers;
- `lib/repositories/**` and any direct `getSupabaseAdmin()` usage;
- `app/(builder)/ycode/api/**` routes;
- `app/(builder)/ycode/mcp/**` routes;
- migrations that add or enforce tenant scope/RLS;
- asset proxy and public site rendering paths;
- Netlify deployment configuration.

## Plain-language one-click flow

1. Open Admin Maintenance.
2. Click the primary safe-update button.
3. The system creates a separate update branch and pull request.
4. If GitHub marks the PR as draft, blocked, failed, or needing developer review, click **Run Premium AI Update**.
5. Premium AI uses OpenRouter's latest Claude frontier model by default, applies safe patch diffs to the PR branch only, and runs tenant safety checks, type-check, build, and PR CI.
6. If the PR checks pass, preview the deploy preview and approve when ready.
7. Production deploys only after the PR is merged into `main`.

This is intentionally not one-click production approval. The safe button can prepare, repair, and test the PR; merging is the final approval step.

## Required update workflow behind the button

1. Create an isolated update branch.
2. Fetch upstream Ycode changes.
3. Merge upstream into the isolated branch only.
4. If conflicts happen, open a draft PR and stop.
5. If no conflicts happen, classify high-risk tenant-sensitive changed files.
6. Run targeted tenant-safety tests.
7. Run type-check and build.
8. Merge to `main` and deploy production only after checks pass and the PR is approved.

## Minimum test set before production

Run relevant tests for:

- auth/magic-link/session handoff;
- tenant middleware/proxy behavior;
- repository tenant scoping;
- API keys and form submissions;
- MCP tokens and MCP route tenant context;
- page-auth verification;
- asset proxy fallback;
- update API tenant gates.

Also run `npm run type-check` and `npm run build`.

## Rule of thumb

If an upstream update touches a file that can read or write tenant data, assume it can break tenant isolation until tests and manual review prove otherwise.
