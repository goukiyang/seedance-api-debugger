import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { deliveryAttachmentSource } from '@/lib/canvas-roles/media';
import { RoleError } from '@/lib/canvas-roles/types';
import { mediaPreviewResponse } from '@/lib/media/preview-response';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = declaredRoute({ access: 'internal', rateLimit: false }, async function GET(
  request: NextRequest,
  props: { params: Promise<{ deliveryId: string; index: string }> }
) {
  const params = await props.params;
  return roleRoute(request, false, async user => {
    if (!/^\d{1,2}$/.test(params.index)) throw new RoleError('原件位置无效');
    const source = await deliveryAttachmentSource(user, params.deliveryId, Number(params.index));
    if (request.nextUrl.searchParams.get('view') === 'metadata') {
      const ref = source.snapshot;
      return NextResponse.json({ attachment: ref, url: request.nextUrl.pathname, mimeType: source.mimeType,
        libraryIdentity: ref.assetId ? `asset:${ref.assetId}` : ref.taskId ? `video_task:${ref.taskId}`
          : ref.referenceImageId ? `reference_image:${ref.referenceImageId}` : null,
      }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    }
    if ('content' in source.snapshot && typeof source.snapshot.content === 'string') {
      return new NextResponse(request.method === 'HEAD' ? null : source.snapshot.content, { headers: {
        'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
      } });
    }
    if (!source.internalSource) return NextResponse.redirect(new URL(source.url, request.url), { headers: { 'Cache-Control': 'private, no-store' } });
    const file = typeof source.snapshot.type !== 'string' || !['image', 'video', 'audio'].includes(source.snapshot.type);
    if (file && !source.url.startsWith('/') && !siteUploadPathFromUrl(source.url)) {
      const url = new URL(source.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || isPrivateNetworkHost(url.hostname)) throw new RoleError('文件原件地址不可用', 503);
      return NextResponse.redirect(url, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const response = await mediaPreviewResponse(request, source.url, source.mimeType);
    if (file && response.ok) {
      if (['application/pdf', 'text/plain'].includes(source.mimeType)) {
        response.headers.set('Content-Type', source.mimeType);
        response.headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
      } else response.headers.set('Content-Disposition', 'attachment');
    }
    return response;
  });
});
export const HEAD = GET;
