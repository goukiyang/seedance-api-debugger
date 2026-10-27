import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { assertCanViewAlbum } from './permissions';
import { studioVisibleReferenceWhere } from '@/lib/image-studio/protected-assets';
import { referenceContentRights } from '@/lib/access/media-policy';
import { mediaProjection } from '@/lib/media/outlet';
import { requireSecret } from '@/lib/security/secrets';
import { authorizedPage, seekWhere } from '@/lib/pagination/cursor';

export async function readAlbumCover(user: SessionUser, album: Awaited<ReturnType<typeof assertCanViewAlbum>>, fallbackId: string | null) {
  if (!album.cover_image_id) return fallbackId;
  const image = await prisma.referenceImage.findFirst({ where: { id: album.cover_image_id, album_id: album.id, status: 'active' }, include: { asset: true } });
  return image && (await referenceContentRights(user, { ...image, album })).view ? image.id : fallbackId;
}

export async function readAlbumImagePage(user: SessionUser, album: Awaited<ReturnType<typeof assertCanViewAlbum>>, params: URLSearchParams) {
  const visible = await studioVisibleReferenceWhere(user);
  const columns = [{ name: 'sort_order', direction: 'asc' as const }, { name: 'created_at', direction: 'asc' as const, date: true }, { name: 'id', direction: 'asc' as const }];
  const page = await authorizedPage({ params, context: JSON.stringify(['album-images', user.id, album.id]), secret: requireSecret('media'),
    fetch: (after, take) => prisma.referenceImage.findMany({
      where: { album_id: album.id, status: 'active', AND: [visible, seekWhere(columns, after)] },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }, { id: 'asc' }], take, include: { asset: true },
    }), key: image => [image.sort_order, image.created_at.toISOString(), image.id],
    visible: async image => (await referenceContentRights(user, { ...image, album })).view,
  });
  const images = await Promise.all(page.items.map(async image => {
    const rights = await referenceContentRights(user, { ...image, album });
    const media = await mediaProjection(user, { type: 'reference', id: image.id });
    return {
      id: image.id, album_id: image.album_id, asset_id: image.asset_id,
      source_type: image.source_type, source_content_id: image.source_content_id, source_image_id: image.source_image_id,
      sort_order: image.sort_order, metadata_json: rights.viewSource ? image.metadata_json : null,
      status: image.status, created_at: image.created_at, updated_at: image.updated_at,
      image_url: media?.previewUrl || null, thumbnail_url: media?.thumbnailUrl || null, media,
      asset: image.asset ? { id: image.asset.id, type: image.asset.type, file_name: image.asset.file_name,
        width: image.asset.width, height: image.asset.height, file_size: image.asset.file_size, mime_type: image.asset.mime_type } : null,
    };
  }));
  return { images, pagination: page.pagination };
}
