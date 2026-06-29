# MasjidWeb core seams (single-project multi-tenant)

This document is the **contract** for how MasjidWeb customizes Ycode while keeping **one Netlify deploy** and **one Supabase project**.

**Goal:** tenant isolation stays correct; upstream Ycode updates stay **repeatable** by re-applying a **known, small set** of patterns instead of rediscovering drift on every merge.

**Related:** [core-update-process.md](./core-update-process.md), [CORE_UPDATE_WORKFLOW.md](../../masjidweb-backend/docs/CORE_UPDATE_WORKFLOW.md), backend [UPSTREAM_MERGE_HOTSPOTS.md](../../masjidweb-backend/docs/UPSTREAM_MERGE_HOTSPOTS.md), [TENANCY.md](../../masjidweb-backend/docs/TENANCY.md).

---

## Principles

1. **New MasjidWeb logic belongs in `lib/masjidweb/`** unless it is impossible (cache/publish hooks tied to upstream flow).
2. **Core file edits should be mechanical** where possible: imports + `resolveEffectiveTenantId()` + `applyTenantEq()` + `tenant_id` on upsert.
3. **Mark non-mechanical blocks** with `MASJIDWEB_SEAM` comments (see below) so merges and AI repair prompts have anchors.
4. **Never remove tenant scoping** to “make upstream compile” — use the patterns in this doc instead.
5. **One shared database** → every `getSupabaseAdmin()` read/write path must respect the effective tenant.

---

## `MASJIDWEB_SEAM` comment convention

Wrap non-trivial custom blocks:

```ts
// MASJIDWEB_SEAM: <short label> — see docs/masjidweb-core-seams.md#<anchor>
// ... custom lines ...
// MASJIDWEB_SEAM_END
```

Use for: publish cache invalidation, tenant cache tags on public pages, proxy auth alignment, Netlify purge, composite publish steps.

**Do not** wrap every `applyTenantEq` line — that is the standard repository pattern (below).

---

## Tier 0 — MasjidWeb-only (preferred for new work)

Upstream rarely touches these. **No Ycode merge** for tenant behavior here.

| Area | Path |
|------|------|
| Tenant resolution | `lib/masjidweb/effective-tenant-id.ts`, `runWithEffectiveTenantId` |
| Query helper | `lib/masjidweb/apply-tenant-eq.ts` |
| Cache tag helpers | `lib/masjidweb/tenant-cache-tags.ts` |
| Session alignment | `lib/masjidweb/tenant-session-alignment.ts` |
| Auth user scope | `lib/masjidweb/auth-users-tenant-scope.ts` |
| Update gates | `lib/masjidweb/update-tenant-access.ts` |
| Isolation gate table list | `lib/masjidweb/tenant-scoped-tables.generated.ts` (generated from the live schema by `scripts/core-update/generate-tenant-scoped-tables.ts`) — the gate's tenant-table set is schema-derived, so a new `tenant_id` table is auto-required to be scoped after a regenerate; no hand-edited list. Refresh: `SUPABASE_ACCESS_TOKEN=<pat> npx tsx scripts/core-update/generate-tenant-scoped-tables.ts` |
| Tests | `lib/masjidweb/*.test.ts`, `lib/tenant/middleware-utils.test.ts` |
| Schema | `database/migrations/20260325*_tenant_*.ts` |

**Rule:** If you can implement a feature only in Tier 0, do that.

---

## Tier 1 — Edge & config (small files, high priority on merge)

| File | What MasjidWeb adds | On upstream conflict |
|------|---------------------|----------------------|
| `proxy.ts` | Strip client `x-tenant-id`; subdomain → registry; builder auth; JWT vs header alignment; provisioning publish headers | Keep MasjidWeb blocks; take upstream routing/API changes around them |
| `lib/supabase-server.ts` | Service-role admin client (upstream shape) | Preserve any MasjidWeb session/tenant comments; do not reintroduce unscoped helpers |
| `lib/supabase-browser.ts` | Per-host auth cookie options (via cookie-domain helper) | Merge upstream client options; keep cookie helper wiring |
| `lib/supabase-cookie-domain.ts` | **Host-only, per-host** auth cookie name (`tenantScopedAuthCookieName`) so each tenant subdomain keeps an independent session — a shared `.suffix` domain made all tenants share one cookie and log each other out. Every @supabase/ssr client must pass `projectUrl`. | Keep file (fork-only); do **not** reintroduce a shared cookie `domain` |
| `lib/auth-invite-redirect.ts` | Invite/magic-link URLs for tenant hosts | Keep file (fork-only) |
| `next.config.ts` | `Cache-Control: private` on `/`; font preconnect | Merge both header blocks |
| `netlify.toml` | Netlify Next plugin / build | Keep MasjidWeb deploy settings |

---

## Tier 2 — Repository pattern (mechanical, ~16 files)

**Standard pattern** for tables with `tenant_id`:

```ts
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';

// Inside function:
const tenantId = await resolveEffectiveTenantId();
let query = client.from('TABLE').select('*') /* upstream conditions */;
query = applyTenantEq(query, tenantId);
const { data, error } = await query;

// On insert/upsert payload:
...(tenantId ? { tenant_id: tenantId } : {}),
```

**Files using this pattern today:**

- `lib/repositories/pageRepository.ts`
- `lib/repositories/pageLayersRepository.ts`
- `lib/repositories/pageFolderRepository.ts`
- `lib/repositories/settingsRepository.ts`
- `lib/repositories/collectionRepository.ts`
- `lib/repositories/collectionFieldRepository.ts`
- `lib/repositories/collectionItemRepository.ts`
- `lib/repositories/collectionItemValueRepository.ts`
- `lib/repositories/collectionImportRepository.ts`
- `lib/repositories/componentRepository.ts`
- `lib/repositories/layerStyleRepository.ts`
- `lib/repositories/localeRepository.ts`
- `lib/repositories/fontRepository.ts`
- `lib/repositories/assetRepository.ts`
- `lib/repositories/assetFolderRepository.ts`
- `lib/repositories/colorVariableRepository.ts`

**On conflict:** Take **upstream** function structure/business logic; re-apply the three pieces (imports, `applyTenantEq` on selects/updates/deletes, `tenant_id` on writes). Run tenant tests.

**Translations:** no `tenant_id` on table — scope via `locale_id` / tenant-owned locales (`localeRepository`).

---

## Tier 3 — Services (composite merges)

Upstream changes often; MasjidWeb blocks must be re-applied carefully.

| File | MasjidWeb responsibility |
|------|---------------------------|
| `lib/services/cacheService.ts` | Tenant-scoped `invalidatePage` / `clearAllCache`; **Netlify** `purgeNetlifyEdgeCache`; upstream selective invalidation/warming — use tenant tags from `tenant-cache-tags.ts`, not global `route-/` only |
| `lib/services/pageService.ts` | Publish pages with tenant context; return shape for publish route (`changedPageIds`, etc.) |
| `lib/services/collectionService.ts` | Tenant filters on publish/cleanup; `applyTenantEq` |
| `lib/services/localisationService.ts` | Locale/translation scoping via tenant locales |
| `lib/services/folderService.ts` | Tenant-scoped folder operations |
| `lib/page-fetcher.ts` | Public SSR: effective tenant from host, not a single global `TENANT_ID` default for all sites |

**On conflict:** Prefer **upstream** file, then re-insert `MASJIDWEB_SEAM` blocks from `main` or this doc. Verify with `npm run type-check` and tenant cache tests.

---

## Tier 4 — HTTP routes (touch only when upstream changes the route)

| Route / area | MasjidWeb note |
|--------------|----------------|
| `app/(builder)/ycode/api/publish/route.ts` | `runWithEffectiveTenantId`; tenant `clearAllCache`; upstream publish pipeline |
| `app/(builder)/ycode/api/cache/clear-tag/route.ts`, `revalidate/route.ts` | Vercel `invalidateByTag` vs `revalidateTag`; tenant-aware tags |
| `app/(builder)/ycode/api/settings/[key]/route.ts`, `settings/batch/route.ts` | Draft-only keys + `clearAllCache(await resolveEffectiveTenantId())` |
| `app/(builder)/ycode/api/project/import/route.ts` | Tenant-scoped cache clear after import |
| `app/(builder)/ycode/api/v1/...` | API keys, forms, collection items — tenant scope |
| `app/(builder)/ycode/api/auth/*`, `accept-invite` | Magic-link / cookie domain (fragile — see workspace rules) |
| `app/(builder)/ycode/mcp/[token]/route.ts` | MCP tenant context |
| `app/(site)/page.tsx`, `app/(site)/[...slug]/page.tsx` | `unstable_cache` tags: `tenantAllPagesTag`, `tenantRouteTag` |

**On conflict:** Merge upstream handler; restore tenant wrapper and cache clears from pre-merge `main`.

---

## Tier 5 — Auth / fragile flows (do not “simplify”)

Documented in workspace rules — preserve behavior, add regression tests:

- `app/(builder)/ycode/accept-invite/page.tsx`
- `app/(builder)/ycode/api/auth/session/route.ts`
- `lib/supabase-cookie-domain.ts`, `lib/supabase-browser.ts`
- `app/(builder)/ycode/YCodeLayoutClient.tsx` — standalone route exclusion for accept-invite

---

## Tier 6 — Realtime collaboration channels

Supabase Realtime keys subscriptions off the channel **name**, which is global across all
tenants. The builder's live-update hooks and the MCP broadcaster used generically-named
channels (`pages:updates`, `components:updates`, `collections:updates`, `layer-styles:updates`,
`page:<id>:updates`), so one tenant's editor received another tenant's live edits. There is
**no non-core way** to isolate a globally-named channel, so these are core edits.

**Fix:** prefix every channel with the tenant id via `lib/masjidweb/realtime-tenant-channel.ts`
(Tier 0). Sender and receiver must use the **same** prefixed name. Hooks fail **closed** (skip
realtime entirely) when no tenant id is present rather than fall back to a shared channel.

| File | What MasjidWeb adds | On upstream conflict |
|------|---------------------|----------------------|
| `lib/masjidweb/realtime-tenant-channel.ts` | `clientTenantId` + `tenantChannelName` helpers | Keep file (Tier 0) |
| `hooks/use-live-page-updates.ts` | tenant guard + `tenantChannelName(...)` wrap | Re-apply `MASJIDWEB_SEAM: realtime-tenant-isolation` blocks |
| `hooks/use-live-component-updates.ts` | same | same |
| `hooks/use-live-collection-updates.ts` | same | same |
| `hooks/use-live-layer-style-updates.ts` | same | same |
| `hooks/use-live-layer-updates.ts` | same (channel already `page:<id>` scoped; prefixed for defense-in-depth) | same |
| `lib/mcp/broadcast.ts` | `resolveEffectiveTenantId()` → `tenantChannelName(...)`, skip if no tenant | same |

**Not yet scoped (id-keyed, safe only while ids are globally-unique UUIDs):** cursor presence
rooms (`YCodeBuilderMain.tsx` `cursorRoomName`) and resource locks (`use-layer-locks.ts`,
`CollectionItemSheet.tsx`/`CMS.tsx` `collection:<id>:item_locks`). These embed a page/collection/
component UUID, so they cannot collide across tenants today. Prefix them too if ids ever stop
being globally unique.

---

## Core update playbook (after upstream merge)

1. **Resolve conflicts** only in files listed in Tiers 1–4 (plus any new upstream files that call `getSupabaseAdmin()` without scoping — add to Tier 2).
2. **Never** delete `applyTenantEq` / `tenant_id` upserts to fix compile errors.
3. Re-apply **Tier 1** seams first (`proxy.ts`, `next.config.ts`).
4. Re-apply **Tier 2** with the standard repository pattern (batch by directory).
5. Re-apply **Tier 3** `MASJIDWEB_SEAM` blocks (`cacheService`, `publish/route.ts`).
6. Run:
   - `npx vitest run lib/masjidweb lib/supabase-cookie-domain.test.ts lib/auth-invite-redirect.test.ts lib/tenant/middleware-utils.test.ts`
   - `npm run type-check`
   - `npm run build`
7. Manual smoke (two tenants): public homepages, builder login, pages list isolation, one publish.

Automated risk report: `scripts/check-update-safety.ts` (used in safe-update workflow).

---

## What “minimal” means going forward

| Status | Count | Direction |
|--------|-------|-----------|
| Today | ~16 repositories + ~6 services/routes composites + Tier 1 | Acceptable if patterns stay mechanical |
| Target | Same files, **smaller diffs** per file | Mark seams; avoid new tenant logic outside this list |
| Long-term | Fewer composite files | Optional: central DB wrapper (project — not required for next merge) |

**Forbidden:** Copy-pasting tenant filters into new random files “just once” — add to Tier 2 list and use the standard pattern, or implement in `lib/masjidweb/`.

---

## For platform admins (non-technical)

- **Safe update** = merge new Ycode into a **review branch**, fix conflicts using **this seam list**, run tests, then you approve.
- **Production unchanged** until merge + deploy.
- **You are not approving code line-by-line** — you are approving “seams were re-applied and tests passed.”
- If the PR touches many files in Tiers 3–4, that is **expected** for large Ycode releases, not a sign the strategy failed.
