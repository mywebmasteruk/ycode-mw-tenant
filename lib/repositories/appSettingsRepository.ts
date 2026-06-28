import { getSupabaseAdmin } from '@/lib/supabase-server';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { applyTenantEq } from '@/lib/masjidweb/apply-tenant-eq';

/**
 * App Settings Repository
 *
 * Generic key-value store for app integration settings.
 * Each app stores its configuration (API keys, connections, etc.) here.
 */

// =============================================================================
// Types
// =============================================================================

export interface AppSetting {
  id: string;
  app_id: string;
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// Read Operations
// =============================================================================

/**
 * Get all settings for a specific app
 */
export async function getAppSettings(appId: string): Promise<AppSetting[]> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const { data, error } = await applyTenantEq(client
    .from('app_settings')
    .select('*')
    .eq('app_id', appId)
    .order('key', { ascending: true }), tenantId);

  if (error) {
    throw new Error(`Failed to fetch app settings: ${error.message}`);
  }

  return data || [];
}

/**
 * Get a specific setting for an app
 */
export async function getAppSetting(
  appId: string,
  key: string
): Promise<AppSetting | null> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const { data, error } = await applyTenantEq(client
    .from('app_settings')
    .select('*')
    .eq('app_id', appId)
    .eq('key', key)
    .single(), tenantId);

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to fetch app setting: ${error.message}`);
  }

  return data;
}

/**
 * Get a setting value directly (convenience helper)
 */
export async function getAppSettingValue<T = unknown>(
  appId: string,
  key: string
): Promise<T | null> {
  const setting = await getAppSetting(appId, key);
  return setting ? (setting.value as T) : null;
}

/**
 * Check if an app has a specific setting configured
 */
export async function hasAppSetting(
  appId: string,
  key: string
): Promise<boolean> {
  const setting = await getAppSetting(appId, key);
  return setting !== null;
}

/**
 * Get all app IDs that have settings configured (i.e. connected apps)
 */
export async function getConnectedAppIds(): Promise<string[]> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const { data, error } = await applyTenantEq(client
    .from('app_settings')
    .select('app_id')
    .order('app_id'), tenantId);

  if (error) {
    throw new Error(`Failed to fetch connected apps: ${error.message}`);
  }

  // Deduplicate app IDs
  const appIds = new Set((data || []).map((row: { app_id: string }) => row.app_id));
  return Array.from(appIds);
}

// =============================================================================
// Write Operations
// =============================================================================

/**
 * Set a setting value for an app (upsert)
 */
export async function setAppSetting(
  appId: string,
  key: string,
  value: unknown
): Promise<AppSetting> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const { data, error } = await client
    .from('app_settings')
    .upsert(
      { tenant_id: tenantId,
        app_id: appId,
        key,
        value,
        updated_at: new Date().toISOString(),
      },
      // Tenant-scoped conflict target so one tenant's upsert can never overwrite
      // another tenant's row (matches the app_settings_tenant_app_key_uq index).
      { onConflict: 'tenant_id,app_id,key' }
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to set app setting: ${error.message}`);
  }

  return data;
}

/**
 * Delete a specific setting for an app
 */
export async function deleteAppSetting(
  appId: string,
  key: string
): Promise<void> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const { error } = await applyTenantEq(client
    .from('app_settings')
    .delete()
    .eq('app_id', appId)
    .eq('key', key), tenantId);

  if (error) {
    throw new Error(`Failed to delete app setting: ${error.message}`);
  }
}

/**
 * Delete all settings for an app (disconnect)
 */
export async function deleteAllAppSettings(appId: string): Promise<void> {
  const tenantId = await resolveEffectiveTenantId();
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const { error } = await applyTenantEq(client
    .from('app_settings')
    .delete()
    .eq('app_id', appId), tenantId);

  if (error) {
    throw new Error(`Failed to delete app settings: ${error.message}`);
  }
}
