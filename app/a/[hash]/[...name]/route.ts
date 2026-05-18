/**
 * Asset Proxy Route
 *
 * Serves assets with SEO-friendly URLs by proxying from Supabase Storage.
 * URL format: /a/{base62-hash}/{seo-friendly-name}.{ext}
 *
 * The hash is a base62-encoded UUID used for lookup.
 * The name segment is cosmetic (for SEO) and derived from the asset's filename.
 * If the name doesn't match the current filename, a 301 redirect is issued.
 *
 * Supports image resizing via query params (width, height, quality) using sharp.
 * Responses are cached with immutable headers so sharp only runs once per unique URL.
 */

import { NextRequest } from 'next/server';
import { base62ToUuid } from '@/lib/convertion-utils';
import { getAssetProxyUrl, isAssetOfType, ASSET_CATEGORIES } from '@/lib/asset-utils';
import { buildAssetProxyResponse } from '@/lib/asset-proxy-response';
import { getAssetForProxy } from '@/lib/repositories/assetRepository';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { STORAGE_BUCKET } from '@/lib/asset-constants';

// Cache headers set at infrastructure level via next.config.ts headers()
// to prevent Next.js proxy from overriding them

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string; name: string[] }> }
) {
  try {
    const { hash, name } = await params;

    let assetId: string;
    try {
      assetId = base62ToUuid(hash);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const asset = await getAssetForProxy(assetId);
    if (!asset?.storage_path) {
      return new Response('Not found', { status: 404 });
    }

    const canonicalPath = getAssetProxyUrl(asset);
    if (canonicalPath) {
      const requestedName = name.join('/');
      const canonicalName = canonicalPath.split('/').slice(3).join('/');
      if (requestedName !== canonicalName) {
        const url = new URL(request.url);
        const redirectUrl = new URL(canonicalPath, url.origin);
        redirectUrl.search = url.search;
        return Response.redirect(redirectUrl.toString(), 301);
      }
    }

    const supabase = await getSupabaseAdmin();
    if (!supabase) {
      return new Response('Service unavailable', { status: 503 });
    }

    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(asset.storage_path);

    const url = new URL(request.url);
    const response = await fetch(urlData.publicUrl);
    if (!response.ok) {
      return new Response('Not found', { status: 404 });
    }

    return buildAssetProxyResponse({
      storageResponse: response,
      mimeType: asset.mime_type,
      searchParams: url.searchParams,
      canTransformMimeType: isAssetOfType(asset.mime_type, ASSET_CATEGORIES.IMAGES),
    });
  } catch {
    return new Response('Internal server error', { status: 500 });
  }
}
