import { describe, expect, it, vi } from 'vitest';
import { buildAssetProxyResponse } from './asset-proxy-response';

describe('buildAssetProxyResponse', () => {
  it('serves the original asset when there are no transform params', async () => {
    const storageResponse = new Response('original', {
      status: 200,
      headers: { 'content-type': 'image/webp' },
    });
    const loadSharp = vi.fn();

    const response = await buildAssetProxyResponse({
      storageResponse,
      mimeType: 'image/webp',
      searchParams: new URLSearchParams(),
      canTransformMimeType: true,
      loadSharp,
    });

    expect(loadSharp).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(await response.text()).toBe('original');
  });

  it('does not load the transformer for non-image assets even with transform params', async () => {
    const storageResponse = new Response('document', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    });
    const loadSharp = vi.fn();

    const response = await buildAssetProxyResponse({
      storageResponse,
      mimeType: 'application/pdf',
      searchParams: new URLSearchParams('width=1920&quality=85'),
      canTransformMimeType: false,
      loadSharp,
    });

    expect(loadSharp).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(await response.text()).toBe('document');
  });

  it('uses the storage content type when asset metadata has no mime type', async () => {
    const storageResponse = new Response('original', {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });

    const response = await buildAssetProxyResponse({
      storageResponse,
      mimeType: null,
      searchParams: new URLSearchParams(),
      canTransformMimeType: true,
      loadSharp: vi.fn(),
    });

    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(await response.text()).toBe('original');
  });

  it('transforms image assets when the transformer is available', async () => {
    const resized = Buffer.from('resized-webp');
    const resize = vi.fn().mockReturnThis();
    const webp = vi.fn().mockReturnThis();
    const toBuffer = vi.fn().mockResolvedValue(resized);
    const sharp = vi.fn(() => ({ resize, webp, toBuffer }));

    const response = await buildAssetProxyResponse({
      storageResponse: new Response('original-image', {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
      mimeType: 'image/jpeg',
      searchParams: new URLSearchParams('width=640&height=320&quality=85'),
      canTransformMimeType: true,
      loadSharp: async () => sharp,
    });

    expect(sharp).toHaveBeenCalledWith(Buffer.from('original-image'));
    expect(resize).toHaveBeenCalledWith(640, 320, {
      fit: 'cover',
      withoutEnlargement: true,
    });
    expect(webp).toHaveBeenCalledWith({ quality: 85 });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('Content-Length')).toBe(resized.length.toString());
    expect(Buffer.from(await response.arrayBuffer())).toEqual(resized);
  });

  it('defaults transform quality to 80 when only dimensions are provided', async () => {
    const webp = vi.fn().mockReturnThis();
    const sharp = vi.fn(() => ({
      resize: vi.fn().mockReturnThis(),
      webp,
      toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized')),
    }));

    await buildAssetProxyResponse({
      storageResponse: new Response('original-image'),
      mimeType: 'image/png',
      searchParams: new URLSearchParams('width=320'),
      canTransformMimeType: true,
      loadSharp: async () => sharp,
    });

    expect(webp).toHaveBeenCalledWith({ quality: 80 });
  });

  it('clamps transform quality to 100', async () => {
    const webp = vi.fn().mockReturnThis();
    const sharp = vi.fn(() => ({
      resize: vi.fn().mockReturnThis(),
      webp,
      toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized')),
    }));

    await buildAssetProxyResponse({
      storageResponse: new Response('original-image'),
      mimeType: 'image/png',
      searchParams: new URLSearchParams('quality=999'),
      canTransformMimeType: true,
      loadSharp: async () => sharp,
    });

    expect(webp).toHaveBeenCalledWith({ quality: 100 });
  });

  it('falls back to the original asset when the image transformer is unavailable', async () => {
    const storageResponse = new Response('original', {
      status: 200,
      headers: { 'content-type': 'image/webp' },
    });

    const response = await buildAssetProxyResponse({
      storageResponse,
      mimeType: 'image/webp',
      searchParams: new URLSearchParams('width=1920&quality=85'),
      canTransformMimeType: true,
      loadSharp: async () => {
        throw new Error('sharp unavailable');
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(await response.text()).toBe('original');
  });

  it('falls back to the original asset when transformation throws after reading the body', async () => {
    const storageResponse = new Response('original', {
      status: 200,
      headers: { 'content-type': 'image/webp' },
    });
    const sharp = vi.fn(() => ({
      resize: vi.fn().mockReturnThis(),
      webp: vi.fn().mockReturnThis(),
      toBuffer: vi.fn().mockRejectedValue(new Error('transform failed')),
    }));

    const response = await buildAssetProxyResponse({
      storageResponse,
      mimeType: 'image/webp',
      searchParams: new URLSearchParams('width=1920&quality=85'),
      canTransformMimeType: true,
      loadSharp: async () => sharp,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(await response.text()).toBe('original');
  });
});
