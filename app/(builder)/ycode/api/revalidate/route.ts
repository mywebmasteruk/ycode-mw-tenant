import { revalidateTag } from 'next/cache';
import { invalidateByTag } from '@vercel/functions';
import { NextRequest, NextResponse } from 'next/server';
import { noCache } from '@/lib/api-response';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tag, secret } = body;

    // Verify secret token
    if (secret !== process.env.REVALIDATE_SECRET) {
      return noCache(
        { error: 'Invalid secret' },
        401
      );
    }

    if (!tag) {
      return noCache(
        { error: 'Tag is required' },
        400
      );
    }

<<<<<<< HEAD
    // Revalidate the cache for this tag
    revalidateTag(tag, 'max');
=======
    // On Vercel: direct CDN purge, avoids revalidateTag cascade bug (#63509).
    // Off Vercel: revalidateTag for Next.js's in-process data cache.
    if (process.env.VERCEL === '1') {
      await invalidateByTag(tag);
    } else {
      revalidateTag(tag, { expire: 0 });
    }
>>>>>>> upstream/main

    return noCache({
      revalidated: true,
      tag,
      now: Date.now()
    });
  } catch (error) {
    return noCache(
      { error: 'Error revalidating' },
      500
    );
  }
}
