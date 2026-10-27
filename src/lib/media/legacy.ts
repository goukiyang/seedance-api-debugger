import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { siteUploadBaseUrls } from '@/lib/assets/site-url';
import { localMediaLocation } from './storage-roots';
import { redirectMedia } from './outlet';
import { mediaDenied } from './signed-media';
import { decideMedia } from '@/lib/access/media-policy';

export function legacyMediaWindow(now = Date.now()) {
  const raw = process.env.MEDIA_LEGACY_TRANSITION_STARTED_AT || '';
  const start = Date.parse(raw);
  return /^\d{4}-\d\d-\d\dT/.test(raw) && Number.isFinite(start) && now >= start && now < start + 30 * 86400000;
}

export async function legacyMediaResponse(request: Request, user: SessionUser | null) {
  if (!user || !legacyMediaWindow()) return mediaDenied(404);
  const raw = new URL(request.url).searchParams.get('path') || '';
  let location;
  try { location = localMediaLocation(raw); } catch { return mediaDenied(404); }
  if (!location || !raw.startsWith(`/${location.root}/`)) return mediaDenied(404);
  if (location.root === 'videos') {
    const cover = /^thumbnails\/([a-zA-Z0-9_-]{1,180})\.jpg$/.exec(location.relative);
    const video = /^([a-zA-Z0-9_-]{1,180})\.mp4$/.exec(location.relative);
    const id = cover?.[1] || video?.[1];
    if (!id) return mediaDenied(404);
    const task = await prisma.videoTask.findUnique({ where: { id }, select: { id: true, local_video_path: true } });
    if (!task || !cover && task.local_video_path !== raw) return mediaDenied(404);
    return redirectMedia(request, user, { type: cover ? 'video-cover' : 'video', id }, cover ? 'thumbnail' : 'original');
  }
  const aliases = [raw, ...siteUploadBaseUrls().map(base => base + raw)];
  const assets = await prisma.asset.findMany({ where: { status: 'active', OR: [{ original_url: { in: aliases } }, { thumbnail_url: { in: aliases } }] },
    select: { id: true, original_url: true, thumbnail_url: true }, take: 101 });
  if (assets.length > 100) return mediaDenied(404);
  for (const asset of assets) {
    const variant = aliases.includes(asset.original_url) ? 'original' : 'thumbnail';
    for (const type of ['asset', 'template-cover'] as const) {
      const decision = await decideMedia(user, { type, id: asset.id }, variant === 'original' ? 'download-original' : 'view-thumbnail');
      if (decision.allowed) return redirectMedia(request, user, { type, id: asset.id }, variant);
    }
  }
  return mediaDenied(404);
}
