# Core update process

This repository is a MasjidWeb production fork of Ycode. It contains MasjidWeb-specific tenant isolation, authentication, deployment, and safety changes inside core Ycode paths.

Do not apply upstream Ycode updates directly to `main`, and do not use one-click "Sync fork" for production without review.

## Current in-app update behavior

The builder update screen is informational only:

- it checks official `ycode/ycode` GitHub releases;
- it compares the latest release with `package.json` version;
- it shows release notes and manual update instructions;
- it does not download or rewrite local source files.

The current instructions are generic Ycode instructions. For this fork, treat them as advisory only.

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

## Required update workflow

1. Create an isolated update branch or worktree.
2. Fetch upstream Ycode changes.
3. Merge or rebase upstream into the isolated branch only.
4. Resolve conflicts manually, preserving MasjidWeb tenant-hardening behavior.
5. Review every new or changed service-role query for explicit tenant scope.
6. Run targeted tenant-safety tests.
7. Run type-check and build.
8. Deploy to preview/staging first.
9. Smoke test template tenant, existing client tenant, newly provisioned tenant, magic-link login, publish, assets/images, forms/API keys, and MCP auth behavior.
10. Merge to `main` and deploy production only after the above passes.

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
