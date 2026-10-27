import { AuthError, type SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { assertCanUseReferenceImage, canDownloadOriginal, getReferenceImageByIdForAccess } from '@/lib/reference-albums/permissions';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { sameOriginPublicUrlForSiteUpload, siteUploadBaseUrls } from './site-url';
import { assertMedia, MEDIA_TYPES, type MediaType } from '@/lib/access/media-policy';

function siteImageIdentity(raw: string) {
  let url: URL;
  try { url = new URL(raw, 'https://sd2.youdooart.com'); } catch { return null; }
  if (!siteUploadBaseUrls().includes(url.origin)) return null;
  if (url.username || url.password) throw new AuthError('图片地址无效，请重新选择原件', 400);
  const reference = /^\/api\/reference-images\/([a-zA-Z0-9_-]+)\/content$/.exec(url.pathname);
  if (reference) return { kind: 'reference_image', id: reference[1] };
  const asset = /^\/api\/image-studio\/(?:(?:assets|template-assets)|style-groups\/[^/]+\/assets)\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
  if (asset) return { kind: 'asset', id: asset[1] };
  if (url.pathname === '/api/content-reactions/media') {
    const key = /^(asset|reference_image):([a-zA-Z0-9_-]+)$/.exec(url.searchParams.get('key') || '');
    if (key) return { kind: key[1], id: key[2] };
    throw new AuthError('此展示地址没有可用原件编号，请从素材库重新选择', 400);
  }
  if (url.pathname.startsWith('/uploads/thumbs/') || url.pathname === '/_next/image'
    || url.pathname.startsWith('/api/video/thumbnail/')) {
    throw new AuthError('缩略图不能作为原件导入，请从素材库选择原图', 400);
  }
  return null;
}

// Only identities carried by known media routes are resolved; filenames/thumbnail paths are never guessed.
export async function originalImageInputUrl(user: SessionUser, raw: string): Promise<string> {
  const parsed = new URL(raw, 'https://sd2.youdooart.com');
  if (siteUploadBaseUrls().includes(parsed.origin)) {
    const outlet = /^\/m\/([a-z-]+)\/([a-zA-Z0-9_-]+)\/([a-z-]+)$/.exec(parsed.pathname);
    if (outlet) {
      if (!(MEDIA_TYPES as readonly string[]).includes(outlet[1])) throw new AuthError('此地址没有可用的原件编号', 400);
      const decision = await assertMedia(user, { type: outlet[1] as MediaType, id: outlet[2] }, 'download-original');
      if (decision.source?.kind !== 'image' || !decision.source.url) throw new AuthError('不是可用的原图', 400);
      return sameOriginPublicUrlForSiteUpload(decision.source.url) || decision.source.url;
    }
    if (parsed.pathname.startsWith('/uploads/')) {
      const aliases = [parsed.pathname, ...siteUploadBaseUrls().map(base => base + parsed.pathname)];
      const assets = await prisma.asset.findMany({ where: { original_url: { in: aliases }, type: 'image', status: 'active' }, select: { id: true }, take: 101 });
      if (assets.length <= 100) for (const asset of assets) {
        try { const decision = await assertMedia(user, { type: 'asset', id: asset.id }, 'download-original');
          return sameOriginPublicUrlForSiteUpload(decision.source!.url) || decision.source!.url;
        } catch (error) { if (!(error instanceof AuthError)) throw error; }
      }
      throw new AuthError('原图不存在或无权读取，请使用参考图编号', 403);
    }
  }
  const identity = siteImageIdentity(raw);
  if (!identity) return raw;
  let source: string;
  if (identity.kind === 'reference_image') {
    const image = await assertCanUseReferenceImage(user, identity.id);
    if (image.asset && (image.asset.status !== 'active' || image.asset.type !== 'image')) throw new AuthError('原图已不可用，已有输入保留', 404);
    // URL copying needs original access. Existing use-only ID references never pass through this path.
    if (!await canDownloadOriginal(user, image)) throw new AuthError('此图仅可通过参考图编号使用，不能导入原件；请在参考区直接选择', 403);
    source = image.asset?.original_url || image.url;
  } else {
    const asset = await prisma.asset.findUnique({ where: { id: identity.id } });
    if (!asset || asset.status !== 'active' || asset.type !== 'image' || !await canReadStudioAsset(user, asset)) throw new AuthError('原图已不可用，已有输入保留', 404);
    let downloadable = asset.owner_id === user.id || user.role === 'admin';
    if (!downloadable) {
      const refs = await prisma.referenceImage.findMany({ where: { asset_id: asset.id, status: 'active' }, select: { id: true } });
      for (const ref of refs) {
        const image = await getReferenceImageByIdForAccess(ref.id);
        if (image && await canDownloadOriginal(user, image)) { downloadable = true; break; }
      }
    }
    if (!downloadable) throw new AuthError('此图仅可通过参考图编号使用，不能导入原件；请在参考区直接选择', 403);
    source = asset.original_url;
  }
  if (!source || siteImageIdentity(source)) throw new AuthError('原件记录不可用，未使用压缩展示图代替；请重新上传原图', 400);
  return sameOriginPublicUrlForSiteUpload(source) || source;
}

export async function resolveImageInputUrls(user: SessionUser, body: Record<string, unknown>) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError('图片输入格式无效', 400);
  const resolved = new Map<string, string>();
  const resolve = async (raw: string) => {
    if (!resolved.has(raw)) resolved.set(raw, await originalImageInputUrl(user, raw));
    return resolved.get(raw)!;
  };
  for (const key of ['reference_image_urls', 'referenceImageUrls', 'frame_image_urls']) {
    const values = body[key];
    if (!Array.isArray(values)) continue;
    if (values.length > 80) throw new AuthError('图片数量过多，请减少选择', 400);
    const next = [];
    for (const value of values) next.push(typeof value === 'string' ? await resolve(value) : value);
    body[key] = next;
  }
  for (const key of ['first_frame_url', 'last_frame_url']) {
    if (typeof body[key] === 'string' && body[key]) body[key] = await resolve(body[key] as string);
  }
  for (const [key, kind] of [['reference_video_urls', 'video'], ['referenceVideoUrls', 'video'],
    ['reference_audio_urls', 'audio'], ['referenceAudioUrls', 'audio']] as const) {
    const values = body[key];
    if (!Array.isArray(values)) continue;
    if (values.length > 80) throw new AuthError('参考素材数量过多，请减少选择', 400);
    const next = [];
    for (const value of values) {
      if (typeof value !== 'string') { next.push(value); continue; }
      const url = new URL(value, 'https://sd2.youdooart.com');
      const outlet = siteUploadBaseUrls().includes(url.origin) && /^\/m\/([a-z-]+)\/([a-zA-Z0-9_-]+)\/([a-z-]+)$/.exec(url.pathname);
      if (!outlet) { next.push(value); continue; }
      if (url.username || url.password || !(MEDIA_TYPES as readonly string[]).includes(outlet[1])) throw new AuthError('参考素材地址无效', 400);
      const decision = await assertMedia(user, { type: outlet[1] as MediaType, id: outlet[2] }, 'use');
      if (decision.source?.kind !== kind || !decision.source.url) throw new AuthError('参考素材类型不匹配', 400);
      next.push(sameOriginPublicUrlForSiteUpload(decision.source.url) || decision.source.url);
    }
    body[key] = next;
  }
}
