/**
 * Hreflang Utility Functions
 *
 * Builds language alternate links for a page (and optional dynamic collection
 * item). Shared by the sitemap generator and the per-page <head> metadata so
 * both surfaces emit identical hreflang clusters.
 */

import type { Locale, Page, PageFolder, Translation } from '@/types';
import { buildSlugPath, buildLocalizedSlugPath } from './page-utils';
import { getTranslatableKey } from './locale-runtime';

export interface HreflangAlternate {
  hreflang: string;
  href: string;
}

/**
 * Slug context for a dynamic (CMS-driven) page. Required to resolve the
 * translated item slug per locale.
 */
export interface DynamicSlugContext {
  /** Collection item ID (translation source_id). */
  itemId: string;
  /** Slug field ID (translation content_key). */
  fieldId: string;
  /** Default-locale slug value used as the fallback. */
  defaultValue: string;
}

/** Build the default-locale absolute URL for a dynamic item. */
function buildDynamicDefaultUrl(
  page: Page,
  folders: PageFolder[],
  baseUrl: string,
  slugValue: string
): string {
  const folderPath = buildSlugPath(page, folders, 'page', '').replace(/\/$/, '');
  const itemPath = folderPath ? `${folderPath}/${slugValue}` : `/${slugValue}`;
  return `${baseUrl}${itemPath}`;
}

/** Build a localized absolute URL for a dynamic item in a non-default locale. */
function buildDynamicLocalizedUrl(
  page: Page,
  folders: PageFolder[],
  baseUrl: string,
  locale: Locale,
  translations: Record<string, Translation> | undefined,
  dynamicSlug: DynamicSlugContext
): string {
  const localizedFolderPath = buildLocalizedSlugPath(
    page,
    folders,
    'page',
    locale,
    translations,
    ''
  ).replace(/\/$/, '');

  const translatedSlugKey = getTranslatableKey({
    source_type: 'cms',
    source_id: dynamicSlug.itemId,
    content_key: dynamicSlug.fieldId,
  });
  const translatedSlug = translations?.[translatedSlugKey]?.content_value || dynamicSlug.defaultValue;

  const localizedItemPath = localizedFolderPath
    ? `${localizedFolderPath}/${translatedSlug}`
    : `/${locale.code}/${translatedSlug}`;

  return `${baseUrl}${localizedItemPath}`;
}

/**
 * Build the full set of hreflang alternates for a single page (or dynamic
 * collection item). Returns one entry per locale plus an `x-default` pointing
 * at the default-locale URL. Returns an empty array for single-locale sites.
 *
 * @example
 * buildPageHreflangAlternates({ page, folders, baseUrl, locales, translationsByLocale })
 * // [{ hreflang: 'en', href: 'https://x.com/about' },
 * //  { hreflang: 'fr', href: 'https://x.com/fr/a-propos' },
 * //  { hreflang: 'x-default', href: 'https://x.com/about' }]
 */
export function buildPageHreflangAlternates(params: {
  page: Page;
  folders: PageFolder[];
  baseUrl: string;
  locales: Locale[];
  translationsByLocale: Map<string, Record<string, Translation>>;
  dynamicSlug?: DynamicSlugContext | null;
}): HreflangAlternate[] {
  const { page, folders, baseUrl, locales, translationsByLocale, dynamicSlug } = params;

  // hreflang only makes sense when there's more than one language.
  if (locales.length <= 1) {
    return [];
  }

  const defaultLocale = locales.find(l => l.is_default);
  const nonDefaultLocales = locales.filter(l => !l.is_default);

  const defaultUrl = dynamicSlug
    ? buildDynamicDefaultUrl(page, folders, baseUrl, dynamicSlug.defaultValue)
    : `${baseUrl}${buildSlugPath(page, folders, 'page')}`;

  const alternates: HreflangAlternate[] = [];

  if (defaultLocale) {
    alternates.push({ hreflang: defaultLocale.code, href: defaultUrl });
  }

  for (const locale of nonDefaultLocales) {
    const translations = translationsByLocale.get(locale.id);
    const href = dynamicSlug
      ? buildDynamicLocalizedUrl(page, folders, baseUrl, locale, translations, dynamicSlug)
      : `${baseUrl}${buildLocalizedSlugPath(page, folders, 'page', locale, translations)}`;
    alternates.push({ hreflang: locale.code, href });
  }

  // x-default lets search engines pick when no language matches the user.
  alternates.push({ hreflang: 'x-default', href: defaultUrl });

  return alternates;
}
