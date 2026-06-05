'use client';

import { Suspense, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import YCodeBuilder from './components/YCodeBuilderMain';
import { useEditorUrl } from '@/hooks/use-editor-url';
import { useAuthStore } from '@/stores/useAuthStore';
import {
  startLockExpirationCheck,
  stopLockExpirationCheck,
  startNotificationCleanup,
  stopNotificationCleanup,
} from '@/stores/useCollaborationPresenceStore';
import { isStandaloneYcodeRoute } from '@/lib/masjidweb/ycode-standalone-routes';

/**
 * YCode Editor Layout (Client Component)
 *
 * This layout wraps all /ycode routes and renders YCodeBuilder once.
 * By keeping YCodeBuilder at the layout level, it persists across route changes,
 * preventing remounts and avoiding duplicate API calls on navigation.
 *
 * Routes:
 * - /ycode - Base editor
 * - /ycode/pages/[id] - Page editing
 * - /ycode/layers/[id] - Layer editing
 * - /ycode/collections/[id] - Collection management
 * - /ycode/components/[id] - Component editing
 * - /ycode/settings - Settings pages
 * - /ycode/localization - Localization pages
 * - /ycode/profile - Profile pages
 *
 * Excluded routes:
 * - /ycode/preview - Preview routes are excluded and render independently
 *
 * YCodeBuilder uses useEditorUrl() to detect route changes and update
 * the UI accordingly without remounting.
 */

interface YCodeLayoutClientProps {
  children: React.ReactNode;
  isTemplateTenant: boolean;
}

// Inner component that uses useSearchParams (via useEditorUrl)
function YCodeEditorLayout({ children, isTemplateTenant }: YCodeLayoutClientProps) {
  const { routeType } = useEditorUrl();
  const { initialize } = useAuthStore();

  // Initialize auth only within editor routes. Auth callback pages need to handle
  // URL tokens before any shared Supabase client touches the location hash.
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Reap expired collaboration locks and stale notifications for the lifetime
  // of the editor session. Both stores are global, so a single mount here
  // covers every builder route.
  useEffect(() => {
    startLockExpirationCheck();
    startNotificationCleanup();
    return () => {
      stopLockExpirationCheck();
      stopNotificationCleanup();
    };
  }, []);

  // For settings, localization, profile, forms, and integrations routes, pass children to YCodeBuilder so it can render them
  if (routeType === 'settings' || routeType === 'localization' || routeType === 'profile' || routeType === 'forms' || routeType === 'integrations') {
    return <YCodeBuilder isTemplateTenant={isTemplateTenant}>{children}</YCodeBuilder>;
  }

  // YCodeBuilder handles all rendering based on URL
  // Children are ignored - routes are just for URL structure
  return <YCodeBuilder isTemplateTenant={isTemplateTenant} />;
}

// Client layout wrapped in Suspense to handle useSearchParams
// Required by Next.js 14+ to prevent static rendering bailout
export default function YCodeLayoutClient({ children, isTemplateTenant }: YCodeLayoutClientProps) {
  const pathname = usePathname();
  const resolvedPathname = pathname || (typeof window !== 'undefined' ? window.location.pathname : '');

  if (!resolvedPathname) {
    return null;
  }

  if (isStandaloneYcodeRoute(resolvedPathname)) {
    return <>{children}</>;
  }

  return (
    <Suspense fallback={null}>
      <YCodeEditorLayout isTemplateTenant={isTemplateTenant}>{children}</YCodeEditorLayout>
    </Suspense>
  );
}
