import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { getAlbumAccess } from '@/lib/reference-albums/permissions';
import { studioVisibleReferenceWhere } from '@/lib/image-studio/protected-assets';

export async function readProjectAlbumPage(user: SessionUser, projectId: string, skip = 0) {
  const visible = await studioVisibleReferenceWhere(user);
  const albums = await prisma.referenceAlbum.findMany({
    where: { project_id: projectId, status: { not: 'deleted' } },
    orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], skip, take: 20,
    include: {
      owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      project: { select: { id: true, name: true, owner_user_id: true, status: true } },
      shares: { where: { status: 'active', OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] } },
      images: { where: { status: 'active', AND: [visible] }, orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }], take: 4, select: { id: true } },
      _count: { select: { images: { where: { status: 'active', AND: [visible] } } } },
    },
  });
  const covers = await prisma.referenceImage.findMany({
    where: { id: { in: albums.flatMap((album) => album.cover_image_id ? [album.cover_image_id] : []) }, status: 'active', AND: [visible] },
    select: { id: true, album_id: true }, take: 20,
  });
  const projected = await Promise.all(albums.map(async (album) => {
    if (!(await getAlbumAccess(user, album)).permissions.view) return null;
    const cover = covers.find((image) => image.id === album.cover_image_id && image.album_id === album.id);
    const ids = Array.from(new Set([...(cover ? [cover.id] : []), ...album.images.map((image) => image.id)])).slice(0, 4);
    return {
      id: album.id, name: album.name, description: album.description, album_type: album.album_type,
      visibility: album.visibility, status: album.status, updated_at: album.updated_at,
      image_count: album._count.images,
      thumbnail_urls: ids.map((id) => `/api/reference-images/${encodeURIComponent(id)}/content?variant=thumbnail`),
    };
  }));
  return projected.filter((album): album is NonNullable<typeof album> => album !== null);
}
