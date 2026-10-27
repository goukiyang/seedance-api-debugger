import { route as declaredRoute } from '@/lib/http/route';
import { NextResponse } from 'next/server';
import { reactionError, reactionUser } from '@/lib/content-reactions/http';
import { parseContentKey, ReactionError, resolveContent } from '@/lib/content-reactions/content';
import { readStudioThumbnail } from '@/lib/image-studio/media';
import { authorizedImageResponse, discardHdViewingInterest, type ImageVariant } from '@/lib/media/authorized-image-response';
import { performance } from 'node:perf_hooks';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
import { redirectMedia } from '@/lib/media/outlet';
import { tryContentKeyParts } from '@/lib/content-reactions/key';
export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: Request) {
  let requesterId: string | undefined;
  try {
    const started = performance.now();
    const params = new URL(request.url).searchParams;
    const user = await reactionUser();
    requesterId = user.id;
    const key = tryContentKeyParts(params.get('key'));
    const direct = key && ({ asset: 'asset', reference_image: 'reference', video_task: 'video', image_studio_task: 'image-task' } as const)[key.type as 'asset' | 'reference_image' | 'video_task' | 'image_studio_task'];
    if (key && direct) return redirectMedia(request, user, { type: direct, id: key.id }, params.get('variant') || 'preview');
    const resolved = await resolveContent(user, parseContentKey(params.get('key')));
    if (!resolved?.source) throw new ReactionError('内容已不可用或无权访问', 404);
    const variant = params.get('variant') || 'preview';
    if (!['preview', 'detail', 'thumbnail', 'original', 'download', 'hd', 'hd-description', 'hd-download'].includes(variant)) throw new ReactionError('资源类型无效');
    if (['original', 'download', 'hd', 'hd-description', 'hd-download'].includes(variant) && !resolved.summary.downloadUrl) throw new ReactionError('无权下载原件', 403);
    const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
    if (['preview', 'detail'].includes(variant) && !resolved.summary.previewUrl) throw new ReactionError('无权预览原件', 403);
    if (resolved.source.referenceId) {
      const target = new URL(`/api/reference-images/${resolved.source.referenceId}/content?variant=${variant}`, request.url);
      for (const key of ['hd-version', 'hd-representation', 'comparison-version']) if (params.has(key)) target.searchParams.set(key, params.get(key)!);
      return NextResponse.redirect(target, { status: 302, headers });
    }
    if (resolved.summary.category === 'image') {
      return await authorizedImageResponse(request, variant === 'thumbnail' ? resolved.source.thumbnail || resolved.source.url : resolved.source.url, variant as ImageVariant, resolved.source.mimeType || 'application/octet-stream', resolved.source.fileName || resolved.summary.title, started,
        { requesterId: user.id, owner: resolved.source.hdOwner });
    }
    if (variant === 'thumbnail' && resolved.source.thumbnail) {
      const bytes = await readStudioThumbnail(resolved.source.thumbnail);
      return new NextResponse(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length) } });
    }
    if (variant === 'thumbnail') throw new ReactionError('暂无封面', 404);
    // Existing public media may remain externally reachable; reactions do not grant or revoke old URLs.
    const target = new URL(resolved.source.url, request.url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || isPrivateNetworkHost(target.hostname)) throw new ReactionError('媒体地址暂不可用', 503);
    return NextResponse.redirect(target, { status: 302, headers });
  } catch (error) {
    const response = reactionError(error);
    if (requesterId && [401, 403, 404].includes(response.status)) await discardHdViewingInterest(request, requesterId);
    return response;
  }
});
export const HEAD = GET;
