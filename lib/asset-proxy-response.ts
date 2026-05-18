type TransformParams = {
  width?: number;
  height?: number;
  quality: number;
};

type SharpPipeline = {
  resize: (
    width?: number,
    height?: number,
    options?: { fit?: 'cover'; withoutEnlargement?: boolean },
  ) => SharpPipeline;
  webp: (options?: { quality?: number }) => SharpPipeline;
  toBuffer: () => Promise<Buffer>;
};

type SharpFactory = (input: Buffer) => SharpPipeline;

type BuildAssetProxyResponseInput = {
  storageResponse: Response;
  mimeType: string | null | undefined;
  searchParams: URLSearchParams;
  canTransformMimeType: boolean;
  loadSharp?: () => Promise<SharpFactory>;
};

function parseTransformParams(searchParams: URLSearchParams): TransformParams | null {
  const width = parseInt(searchParams.get('width') || '');
  const height = parseInt(searchParams.get('height') || '');
  const quality = parseInt(searchParams.get('quality') || '');

  const hasParams = width > 0 || height > 0 || quality > 0;
  if (!hasParams) return null;

  return {
    width: width > 0 ? width : undefined,
    height: height > 0 ? height : undefined,
    quality: quality > 0 ? Math.min(quality, 100) : 80,
  };
}

async function loadSharpModule(): Promise<SharpFactory> {
  // Lazy-load sharp so a platform/package loading failure does not break plain asset proxying.
  const module = await import('sharp');
  return module.default;
}

function originalAssetResponse(storageResponse: Response, mimeType: string | null | undefined): Response {
  return new Response(storageResponse.body, {
    status: 200,
    headers: {
      'Content-Type': mimeType || storageResponse.headers.get('content-type') || 'application/octet-stream',
    },
  });
}

export async function buildAssetProxyResponse({
  storageResponse,
  mimeType,
  searchParams,
  canTransformMimeType,
  loadSharp = loadSharpModule,
}: BuildAssetProxyResponseInput): Promise<Response> {
  const transform = parseTransformParams(searchParams);
  if (!transform || !canTransformMimeType) {
    return originalAssetResponse(storageResponse, mimeType);
  }

  const fallbackResponse = storageResponse.clone();

  try {
    const sharp = await loadSharp();
    const buffer = Buffer.from(await storageResponse.arrayBuffer());
    let pipeline = sharp(buffer);

    if (transform.width || transform.height) {
      pipeline = pipeline.resize(transform.width, transform.height, {
        fit: 'cover',
        withoutEnlargement: true,
      });
    }

    pipeline = pipeline.webp({ quality: transform.quality });

    const resized = await pipeline.toBuffer();

    return new Response(new Uint8Array(resized), {
      status: 200,
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': resized.length.toString(),
      },
    });
  } catch {
    return originalAssetResponse(fallbackResponse, mimeType);
  }
}
