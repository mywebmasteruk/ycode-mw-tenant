import { redirect } from 'next/navigation';
import { getUpdateTenantContext } from '@/lib/masjidweb/update-tenant-access';
import UpdatesSettingsClient from './UpdatesSettingsClient';

export default async function UpdatesSettingsPage() {
  const { isTemplateTenant } = await getUpdateTenantContext();

  if (!isTemplateTenant) {
    redirect('/ycode/settings/general');
  }

  return <UpdatesSettingsClient />;
}
