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
});
