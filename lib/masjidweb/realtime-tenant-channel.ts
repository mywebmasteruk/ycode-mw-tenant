// MASJIDWEB_SEAM: realtime-tenant-isolation — see docs/masjidweb-core-seams.md#tier-6
/**
 * Tenant-scoped Supabase Realtime channel naming (brand seam).
 *
 * Supabase Realtime keys subscriptions off the channel NAME, which is global.
 * The builder's collaboration channels are named generically — `pages:updates`,
 * `components:updates`, `collections:updates`, `layer-styles:updates`,
 * `page:<id>:updates` — so without a tenant prefix one tenant's editor receives
 * another tenant's live edits (cross-tenant leak). Prefixing every channel with
 * the tenant id isolates them.
 *
 * Used by the live-update hooks (client) and `lib/mcp/broadcast.ts` (server).
 * Sender and receiver MUST produce the same prefixed name or live updates break
 * within a tenant — always go through `tenantChannelName` on both sides.
 */

/**
 * Loosely-typed Supabase user so this seam doesn't couple to @supabase/supabase-js.
 * Metadata is `Record<string, unknown>` to stay assignable from the SDK's
 * `UserAppMetadata` / `UserMetadata` index types.
 */
type TenantBearingUser =
  | {
      app_metadata?: Record<string, unknown> | null;
      user_metadata?: Record<string, unknown> | null;
    }
  | null
  | undefined;

/**
 * Client-side tenant id from the Supabase session. Mirrors the precedence the
 * proxy enforces (`proxy.ts`): `app_metadata.tenant_id` wins, then
 * `user_metadata.tenant_id`. Returns null when absent — callers MUST fail closed
 * (skip realtime) rather than fall back to a shared, unprefixed channel.
 */
export function clientTenantId(user: TenantBearingUser): string | null {
  const fromApp = user?.app_metadata?.tenant_id;
  if (typeof fromApp === 'string' && fromApp) return fromApp;
  const fromUser = user?.user_metadata?.tenant_id;
  if (typeof fromUser === 'string' && fromUser) return fromUser;
  return null;
}

/** Prefix a base channel name with the tenant id so it can't collide across tenants. */
export function tenantChannelName(tenantId: string, base: string): string {
  return `t:${tenantId}:${base}`;
}
