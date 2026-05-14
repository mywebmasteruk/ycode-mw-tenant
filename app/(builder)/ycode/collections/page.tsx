import { getUpdateTenantContext } from '@/lib/masjidweb/update-tenant-access';
import YCodeBuilder from '../components/YCodeBuilderMain';

/**
 * Base route for collections view
 * URL: /ycode/collections
 *
 * This route renders the same YCodeBuilder component.
 * Shows all collections or empty state when no collections exist.
 */
export default async function CollectionsRoute() {
  const { isTemplateTenant } = await getUpdateTenantContext();

  return <YCodeBuilder isTemplateTenant={isTemplateTenant} />;
}
