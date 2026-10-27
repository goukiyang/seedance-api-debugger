import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { getAlbumAccess } from '@/lib/reference-albums/permissions';
import { studioVisibleReferenceWhere } from '@/lib/image-studio/protected-assets';
import { seekWhere, type PageKey } from '@/lib/pagination/cursor';

export async function readProjectAlbumDirectory(user: SessionUser, projectId: string, requestedPage = 1) {
  const visible = await studioVisibleReferenceWhere(user);
  const pageSize = 20;
  const readBatch = (after: PageKey | null) => prisma.referenceAlbum.findMany({
    where: { project_id: projectId, status: { not: 'deleted' }, AND: [seekWhere([
      { name: 'updated_at', direction: 'desc', date: true }, { name: 'id', direction: 'desc' },
    ], after)] },
    orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], take: 100,
    include: {
      owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      project: { select: { id: true, name: true, owner_user_id: true, status: true } },
      shares: { where: { status: 'active', OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] } },
      images: { where: { status: 'active', AND: [visible] }, orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }], take: 4, select: { id: true } },
      _count: { select: { images: { where: { status: 'active', AND: [visible] } } } },
    },
  });
  let after: PageKey | null = null, total = 0;
  const requested: Awaited<ReturnType<typeof readBatch>> = [];
  let tail: typeof requested = [];
  for (;;) {
    const batch = await readBatch(after);
    for (const album of batch) {
      if (!(await getAlbumAccess(user, album)).permissions.view) continue;
      if (total % pageSize === 0) tail = [];
      tail.push(album);
      if (Math.floor(total / pageSize) === requestedPage - 1) requested.push(album);
      total++;
    }
    if (batch.length < 100) break;
    const last = batch[batch.length - 1];
    after = [last.updated_at.toISOString(), last.id];
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const albums = requestedPage > totalPages ? tail : requested;
  const covers = await prisma.referenceImage.findMany({
    where: { id: { in: albums.flatMap((album) => album.cover_image_id ? [album.cover_image_id] : []) }, status: 'active', AND: [visible] },
    select: { id: true, album_id: true }, take: 20,
  });
  const projected = await Promise.all(albums.map(async (album) => {
    const cover = covers.find((image) => image.id === album.cover_image_id && image.album_id === album.id);
    const ids = Array.from(new Set([...(cover ? [cover.id] : []), ...album.images.map((image) => image.id)])).slice(0, 4);
    return {
      id: album.id, name: album.name, description: album.description, album_type: album.album_type,
      visibility: album.visibility, status: album.status, updated_at: album.updated_at,
      image_count: album._count.images,
      _count: { images: album._count.images },
      thumbnail_urls: ids.map((id) => `/api/reference-images/${encodeURIComponent(id)}/content?variant=thumbnail`),
    };
  }));
  return { albums: projected, total, page, totalPages };
}

// Keep the existing preview interface and fixed20/4 projection contract.
export async function readProjectAlbumPage(user: SessionUser, projectId: string, skip = 0) {
  const result = await readProjectAlbumDirectory(user, projectId, Math.floor(skip / 20) + 1);
  return skip >= result.total ? [] : result.albums;
}
