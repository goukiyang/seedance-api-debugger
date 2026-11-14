import { NextResponse } from 'next/server';
import { reactionError, reactionUser } from '@/lib/content-reactions/http';
import { parseContentKey, ReactionError, resolveContent } from '@/lib/content-reactions/content';
import { readStudioThumbnail, statStudioDisplayImage } from '@/lib/image-studio/media';
import { authorizedImageResponse, discardHdViewingInterest, recordImageReadDiagnostic, type ImageVariant } from '@/lib/media/authorized-image-response';
import { performance } from 'node:perf_hooks';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { isImagePrefetch } from '@/lib/media/image-validators';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const started = performance.now();
  const readId = randomUUID();
  const params = new URL(request.url).searchParams;
  const requestedVariant = params.get('variant') || 'preview';
  let readStage: 'authorization' | 'read' = 'authorization';
  const completed = (response: Response) => {
    response.headers.set('X-Media-Request-Id', readId);
    recordImageReadDiagnostic({ readId, variant: requestedVariant, started, stage: 'completed' });
    return response;
  };
  let requesterId: string | undefined;
  try {
    const user = await reactionUser();
    requesterId = user.id;
    const resolved = await resolveContent(user, parseContentKey(params.get('key')));
    if (!resolved?.source) throw new ReactionError('内容已不可用或无权访问', 404);
    const variant = requestedVariant;
    if (!['preview', 'detail', 'thumbnail', 'original', 'download', 'hd', 'hd-description', 'hd-download'].includes(variant)) throw new ReactionError('资源类型无效');
    if (['original', 'download', 'hd', 'hd-description', 'hd-download'].includes(variant) && !resolved.summary.downloadUrl) throw new ReactionError('无权下载原件', 403);
    const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
    if (['preview', 'detail'].includes(variant) && !resolved.summary.previewUrl) throw new ReactionError('无权预览原件', 403);
    if (resolved.source.referenceId) {
      const target = new URL(`/api/reference-images/${resolved.source.referenceId}/content?variant=${variant}`, request.url);
      for (const key of ['hd-version', 'hd-representation', 'comparison-version']) if (params.has(key)) target.searchParams.set(key, params.get(key)!);
      readStage = 'read';
      return completed(NextResponse.redirect(target, { status: 302, headers }));
    }
    if (resolved.summary.category === 'image') {
      readStage = 'read';
      return completed(await authorizedImageResponse(request, resolved.source.url, variant as ImageVariant, resolved.source.mimeType || 'application/octet-stream', resolved.source.fileName || resolved.summary.title, started,
        { requesterId: user.id, owner: resolved.source.hdOwner }, resolved.source.trustedVersion?.source === resolved.source.url ? resolved.source.trustedVersion : undefined, readId));
    }
    if (variant === 'thumbnail' && resolved.source.thumbnail) {
      readStage = 'read';
      const readOnly = request.method === 'HEAD' || isImagePrefetch(request) || request.headers.get('x-image-read-intent') === 'status';
      if (readOnly) {
        const meta = await statStudioDisplayImage(resolved.source.thumbnail, 'thumbnail');
        if (!meta) return completed(Response.json({ error: '图片尚未准备好，请直接打开查看' }, { status: 409, headers }));
        const bytes = request.method === 'HEAD' ? null : await fs.readFile(meta.file);
        return completed(new NextResponse(bytes, { headers: { ...headers, 'Content-Type': 'image/webp', 'Content-Length': String(meta.size) } }));
      }
      const bytes = await readStudioThumbnail(resolved.source.thumbnail);
      return completed(new NextResponse(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length) } }));
    }
    if (variant === 'thumbnail') throw new ReactionError('暂无封面', 404);
    // Existing public media may remain externally reachable; reactions do not grant or revoke old URLs.
    const target = new URL(resolved.source.url, request.url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || isPrivateNetworkHost(target.hostname)) throw new ReactionError('媒体地址暂不可用', 503);
    readStage = 'read';
    return completed(NextResponse.redirect(target, { status: 302, headers }));
  } catch (error) {
    recordImageReadDiagnostic({ readId, variant: requestedVariant, started, stage: readStage, error, cancelled: request.signal.aborted });
    const response = reactionError(error);
    if (requesterId && [401, 403, 404].includes(response.status)) await discardHdViewingInterest(request, requesterId);
    response.headers.set('X-Media-Request-Id', readId);
    return response;
  }
}
export const HEAD = GET;
