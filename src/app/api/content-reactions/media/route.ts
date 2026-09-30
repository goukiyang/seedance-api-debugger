import { NextResponse } from 'next/server';
import { reactionError, reactionUser } from '@/lib/content-reactions/http';
import { parseContentKey, ReactionError, resolveContent } from '@/lib/content-reactions/content';
import { readStudioImage, readStudioThumbnail, readStudioPreview } from '@/lib/image-studio/media';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveContent(await reactionUser(), parseContentKey(params.get('key')));
    if (!resolved?.source) throw new ReactionError('内容已不可用或无权访问', 404);
    const variant = params.get('variant') || 'preview';
    if (!['preview', 'thumbnail', 'download'].includes(variant)) throw new ReactionError('资源类型无效');
    if (variant === 'download' && !resolved.summary.downloadUrl) throw new ReactionError('无权下载原件', 403);
    const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
    if (variant === 'preview' && !resolved.summary.previewUrl) throw new ReactionError('无权预览原件', 403);
    if (resolved.source.referenceId) return NextResponse.redirect(new URL(`/api/reference-images/${resolved.source.referenceId}/content?variant=${variant === 'download' ? 'original' : variant}`, request.url), { status: 302, headers });
    if (resolved.summary.category === 'image') {
      const bytes = variant === 'thumbnail' ? await readStudioThumbnail(resolved.source.thumbnail || resolved.source.url) : variant === 'preview' ? await readStudioPreview(resolved.source.url) : await readStudioImage(resolved.source.url, request.signal);
      return new NextResponse(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': variant === 'download' ? 'application/octet-stream' : 'image/webp', ...(variant === 'download' ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(resolved.summary.title).replace(/'/g, '%27')}` } : {}) } });
    }
    if (variant === 'thumbnail' && resolved.source.thumbnail) {
      const bytes = await readStudioThumbnail(resolved.source.thumbnail);
      return new NextResponse(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'image/webp' } });
    }
    if (variant === 'thumbnail') throw new ReactionError('暂无封面', 404);
    // Existing public media may remain externally reachable; reactions do not grant or revoke old URLs.
    const target = new URL(resolved.source.url, request.url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || isPrivateNetworkHost(target.hostname)) throw new ReactionError('媒体地址暂不可用', 503);
    return NextResponse.redirect(target, { status: 302, headers });
  } catch (error) { return reactionError(error); }
}
