import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readStudioDetail, readStudioPreview, readStudioThumbnail } from '@/lib/image-studio/media';
import { mediaPreviewResponse } from './preview-response';

export type ImageVariant = 'thumbnail' | 'preview' | 'detail' | 'original' | 'download';
export const privateImageHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };

// The caller must finish its existing owner/source/download permission checks first.
export async function authorizedImageResponse(request: Request, source: string, variant: ImageVariant, mime: string, fileName?: string, started = performance.now()) {
  const prepared = performance.now();
  let response: Response;
  if (variant === 'original' || variant === 'download') {
    response = await mediaPreviewResponse(request, source, mime);
    response.headers.set('Content-Disposition', variant === 'download'
      ? `attachment; filename*=UTF-8''${encodeURIComponent((fileName || 'image').replace(/[\r\n]/g, '')).replace(/'/g, '%27')}` : 'inline');
  } else {
    const bytes = await (variant === 'thumbnail' ? readStudioThumbnail(source) : variant === 'detail' ? readStudioDetail(source) : readStudioPreview(source));
    const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
    const headers = { ...privateImageHeaders, ETag: etag, 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length), 'Content-Disposition': 'inline' };
    const unchanged = request.headers.get('if-none-match') === etag;
    response = new Response(unchanged || request.method === 'HEAD' ? null : new Uint8Array(bytes), { status: unchanged ? 304 : 200, headers });
    if (unchanged) response.headers.delete('Content-Length');
  }
  response.headers.set('Server-Timing', `access;dur=${(prepared - started).toFixed(1)},media;dur=${(performance.now() - prepared).toFixed(1)}`);
  response.headers.set('X-Media-Request-Id', randomUUID());
  return response;
}
