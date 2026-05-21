/**
 * Generate Page Metadata
 *
 * SERVER-ONLY: This module uses server-only utilities and should never be imported in client code.
 */

import 'server-only';

import { cache } from 'react';
import type { Metadata } from 'next';
import type { Asset, Page } from '@/types';
import type { CollectionItemWithValues } from '@/types';
import { resolveInlineVariables, resolveImageUrl } from '@/lib/resolve-cms-variables';
import { getSettingsByKeys } from '@/lib/repositories/settingsRepository';
import { getAssetById } from '@/lib/repositories/assetRepository';
import { buildSvgDataUrl, getAssetProxyUrl } from '@/lib/asset-utils';
import { generateColorVariablesCss } from '@/lib/repositories/colorVariableRepository';
import { getSiteBaseUrl } from '@/lib/url-utils';

/**
 * Global page render settings fetched once per page render
 */
export interface GlobalPageSettings {
  googleSiteVerification?: string | null;
  globalCanonicalUrl?: string | null;
  gaMeasurementId?: string | null;
  publishedCss?: string | null;
  colorVariablesCss?: string | null;
  globalCustomCodeHead?: string | null;
  globalCustomCodeBody?: string | null;
  ycodeBadge?: boolean;
  faviconUrl?: string | null;
  faviconMimeType?: string | null;
  webClipUrl?: string | null;
  webClipMimeType?: string | null;
}

/** @deprecated Use GlobalPageSettings instead */
export type GlobalSeoSettings = GlobalPageSettings;

/**
 * Generate metadata options
 */
export interface GenerateMetadataOptions {
  /** Include [Preview] prefix in title */
  isPreview?: boolean;
  /** Fallback title if page has no name */
  fallbackTitle?: string;
  /** Fallback description if page has no SEO description */
  fallbackDescription?: string;
  /** Collection item for resolving field variables (for dynamic pages) */
  collectionItem?: CollectionItemWithValues;
  /** Current page path for canonical URL */
  pagePath?: string;
  /** Pre-fetched global SEO settings (avoids duplicate fetches) */
  globalSeoSettings?: GlobalSeoSettings;
  /** Tenant ID for multi-tenant deployments */
  tenantId?: string;
  /** Primary domain URL (e.g. https://example.com) for metadataBase */
  primaryDomainUrl?: string;
}

/**
 * Resolve a usable URL for favicon/web-clip assets, falling back to an
 * inline data URL for SVGs stored without a public_url/storage_path.
 */
function resolveIconAssetUrl(asset: Asset): string | null {
  const proxyOrPublic = getAssetProxyUrl(asset) || asset.public_url || null;
  if (proxyOrPublic) return proxyOrPublic;

  if (asset.mime_type === 'image/svg+xml' && asset.content) {
    return buildSvgDataUrl(asset.content, asset.width, asset.height);
  }

  return null;
}

async function fetchGlobalPageSettingsImpl(isPreview = false): Promise<GlobalPageSettings> {
  const settings = await getSettingsByKeys([
    'google_site_verification',
    'global_canonical_url',
    'ga_measurement_id',
    'published_css',
    'custom_code_head',
    'custom_code_body',
    'ycode_badge',
    'favicon_asset_id',
    'web_clip_asset_id',
  ]);

  // Fetch favicon and web clip asset URLs if IDs are set
  // In preview mode, read draft assets so the favicon shows before publishing.
  let faviconUrl: string | null = null;
  let faviconMimeType: string | null = null;
  let webClipUrl: string | null = null;
  let webClipMimeType: string | null = null;
  const isAssetPublished = !isPreview;

  if (settings.favicon_asset_id) {
    try {
      const asset = await getAssetById(settings.favicon_asset_id, isAssetPublished);
      if (asset) {
        faviconUrl = resolveIconAssetUrl(asset);
        faviconMimeType = asset.mime_type || null;
      }
    } catch {
      // Ignore errors fetching favicon
    }
  }

  if (settings.web_clip_asset_id) {
    try {
      const asset = await getAssetById(settings.web_clip_asset_id, isAssetPublished);
      if (asset) {
        webClipUrl = resolveIconAssetUrl(asset);
        webClipMimeType = asset.mime_type || null;
      }
    } catch {
      // Ignore errors fetching web clip
    }
  }

  const colorVariablesCss = await generateColorVariablesCss();

  return {
    googleSiteVerification: settings.google_site_verification || null,
    globalCanonicalUrl: settings.global_canonical_url || null,
    gaMeasurementId: settings.ga_measurement_id || null,
    publishedCss: settings.published_css || null,
    colorVariablesCss,
    globalCustomCodeHead: settings.custom_code_head || null,
    globalCustomCodeBody: settings.custom_code_body || null,
    ycodeBadge: settings.ycode_badge ?? true,
    faviconUrl,
    faviconMimeType,
    webClipUrl,
    webClipMimeType,
  };
}

/**
 * Fetch all global page settings in a single database query
 * Includes SEO settings, published CSS, and global custom code
 * Wrapped with React cache to deduplicate within the same request (non-preview only)
 */
const fetchGlobalPageSettingsCached = cache(async (): Promise<GlobalPageSettings> => {
  return fetchGlobalPageSettingsImpl();
});

export async function fetchGlobalPageSettings(isPreview = false): Promise<GlobalPageSettings> {
  if (isPreview) {
    // Preview mode: bypass cache and read draft assets
    return fetchGlobalPageSettingsImpl(true);
  }
  return fetchGlobalPageSettingsCached();
}

/** @deprecated Use fetchGlobalPageSettings instead */
export const fetchGlobalSeoSettings = fetchGlobalPageSettingsCached;

/**
 * Generate Next.js metadata from a page object
 * Handles SEO settings, Open Graph, Twitter Card, and noindex rules
 * Resolves field variables for dynamic pages
 *
 * @param page - The page object containing settings and metadata
 * @param options - Optional configuration for metadata generation
 * @returns Next.js Metadata object
 */
export async function generatePageMetadata(
  page: Page,
  options: GenerateMetadataOptions = {}
): Promise<Metadata> {
  const { isPreview = false, fallbackTitle, fallbackDescription, collectionItem, pagePath, primaryDomainUrl } = options;

  const seo = page.settings?.seo;
  const isErrorPage = page.error_page !== null;

  // Build title - resolve field variables if collection item is available
  let title = seo?.title || page.name || fallbackTitle || 'Page';
  if (collectionItem && seo?.title) {
    title = resolveInlineVariables(seo.title, collectionItem) || page.name || fallbackTitle || 'Page';
  }
  if (isPreview) {
    title = `[Preview] ${title}`;
  }

  // Build description - resolve field variables if collection item is available
  let description = seo?.description || fallbackDescription || `${page.name} - Built with Ycode`;
  if (collectionItem && seo?.description) {
    description = resolveInlineVariables(seo.description, collectionItem) || fallbackDescription || `${page.name} - Built with Ycode`;
  }

  // Base metadata
  const metadata: Metadata = {
    title,
    description,
  };

  // Resolve the site base URL for making relative URLs absolute.
  // URL objects don't survive unstable_cache serialization, so we resolve
  // absolute URLs as strings here instead of relying on metadataBase.
  let siteBaseUrl: string | null = null;

  // Always fetch global settings — preview mode reads draft assets so the
  // favicon and web clip render before the user publishes.
  const seoSettings = options.globalSeoSettings || await fetchGlobalPageSettings(isPreview);

  if (!isPreview) {
    siteBaseUrl = getSiteBaseUrl({
      globalCanonicalUrl: seoSettings.globalCanonicalUrl,
      primaryDomainUrl,
    });

    // Add Google Site Verification meta tag
    if (seoSettings.googleSiteVerification) {
      metadata.verification = {
        google: seoSettings.googleSiteVerification,
      };
    }

    // Add canonical URL
    if (seoSettings.globalCanonicalUrl && pagePath !== undefined) {
      const canonicalBase = seoSettings.globalCanonicalUrl.replace(/\/$/, '');
      const canonicalUrl = pagePath === '/' || pagePath === ''
        ? canonicalBase
        : `${canonicalBase}${pagePath.startsWith('/') ? pagePath : '/' + pagePath}`;

      metadata.alternates = {
        canonical: canonicalUrl,
      };
    }
  }

  // Add custom favicon and web clip (apple-touch-icon) — applies to preview too.
  // Default favicon is handled by app/icon.svg
  if (seoSettings.faviconUrl || seoSettings.webClipUrl) {
    metadata.icons = {};
    if (seoSettings.faviconUrl) {
      metadata.icons.icon = seoSettings.faviconMimeType
        ? { url: seoSettings.faviconUrl, type: seoSettings.faviconMimeType }
        : seoSettings.faviconUrl;
    }
    if (seoSettings.webClipUrl) {
      metadata.icons.apple = seoSettings.webClipMimeType
        ? { url: seoSettings.webClipUrl, type: seoSettings.webClipMimeType }
        : seoSettings.webClipUrl;
    }
  }

  // Add Open Graph and Twitter Card metadata (not for error pages)
  if (seo?.image && !isErrorPage) {
    // Resolve image URL (handles both Asset ID string and FieldVariable)
    let imageUrl = await resolveImageUrl(seo.image, collectionItem);

    // Make relative URLs absolute — social crawlers require absolute og:image URLs
    if (imageUrl && imageUrl.startsWith('/') && siteBaseUrl) {
      imageUrl = `${siteBaseUrl}${imageUrl}`;
    }

    if (imageUrl) {
      metadata.openGraph = {
        title,
        description,
        images: [
          {
            url: imageUrl,
            width: 1200,
            height: 630,
          },
        ],
      };
      metadata.twitter = {
        card: 'summary_large_image',
        title,
        description,
        images: [imageUrl],
      };
    }
  }

  // Add noindex if enabled, if error page, or if preview
  if (seo?.noindex || isErrorPage || isPreview) {
    metadata.robots = {
      index: false,
      follow: false,
    };
  }

  return metadata;
}
