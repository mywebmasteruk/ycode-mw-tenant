import { noCache } from '@/lib/api-response';
import { resolveEffectiveTenantId } from '@/lib/masjidweb/effective-tenant-id';
import { getSupabaseAdmin } from '@/lib/supabase-server';

type TenantKind = 'template' | 'client';

export interface UpdateTenantContext {
  tenantId: string | null;
  slug: string | null;
  tenantKind: TenantKind | null;
  isTemplateTenant: boolean;
}

const CLOSED_UPDATE_TENANT_CONTEXT: UpdateTenantContext = {
  tenantId: null,
  slug: null,
  tenantKind: null,
  isTemplateTenant: false,
};

interface TenantRegistryRow {
  id: string;
  slug: string | null;
  tenant_kind: TenantKind | null;
}

export async function getUpdateTenantContext(): Promise<UpdateTenantContext> {
  const tenantId = await resolveEffectiveTenantId();

  if (!tenantId) {
    return CLOSED_UPDATE_TENANT_CONTEXT;
  }

  try {
    const supabase = await getSupabaseAdmin();

    if (!supabase) {
      return {
        ...CLOSED_UPDATE_TENANT_CONTEXT,
        tenantId,
      };
    }

    const { data, error } = await supabase
      .from('tenant_registry')
      .select('id, slug, tenant_kind')
      .eq('id', tenantId)
      .maybeSingle<TenantRegistryRow>();

    if (error || !data) {
      return {
        ...CLOSED_UPDATE_TENANT_CONTEXT,
        tenantId,
      };
    }

    return {
      tenantId: data.id,
      slug: data.slug,
      tenantKind: data.tenant_kind,
      isTemplateTenant: data.tenant_kind === 'template',
    };
  } catch (error) {
    console.error('[update-tenant-access] Failed to resolve update tenant context:', error);
    return {
      ...CLOSED_UPDATE_TENANT_CONTEXT,
      tenantId,
    };
  }
}

export async function requireTemplateTenantForUpdates() {
  const tenantContext = await getUpdateTenantContext();

  if (tenantContext.isTemplateTenant) {
    return null;
  }

  return noCache({ error: 'Updates are only available for template tenants' }, 403);
}
