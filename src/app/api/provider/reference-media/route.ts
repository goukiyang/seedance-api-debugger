import { randomUUID } from 'node:crypto';
import { providerReferenceVideoResponse } from '@/lib/provider/reference-video-delivery.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const readId = randomUUID(), started = performance.now();
  let response: Response;
  try { response = await providerReferenceVideoResponse(request); }
  catch { response = Response.json({ error: '参考素材当前不可读取' }, { status: 503 }); }
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Media-Request-Id', readId);
  if (!response.ok) console.warn('[provider-reference-media]', { readId, method: request.method,
    status: response.status, stage: 'authorized_read', elapsed_ms: Math.round(performance.now() - started) });
  return response;
}

export const HEAD = GET;
