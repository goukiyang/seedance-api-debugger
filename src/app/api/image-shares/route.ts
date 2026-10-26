import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { reactionJson, reactionUser } from '@/lib/content-reactions/http';
import { parseContentKey, ReactionError } from '@/lib/content-reactions/content';
import { studioHiddenAssetUrls } from '@/lib/image-studio/protected-assets';

export const dynamic = 'force-dynamic';

async function ownedImage(user: SessionUser, key: string) {
  const [type, id] = parseContentKey(key).split(':');
  let assetId = type === 'asset' ? id : null;
  if (type === 'reference_image') {
    const reference = await prisma.referenceImage.findFirst({ where: { id, owner_user_id: user.id, status: 'active', album: { status: 'active' } } });
    assetId = reference?.asset_id || null;
  }
  if (!assetId) return null;
  const asset = await prisma.asset.findFirst({ where: { id: assetId, owner_id: user.id, type: 'image', status: 'active' } });
  if (!asset) return null;
  // Publishing a result must never publish a protected template/style reference,
  // even for administrators who are allowed to inspect that reference privately.
  const hidden = await studioHiddenAssetUrls(null);
  if (hidden.includes(asset.original_url) || (asset.thumbnail_url && hidden.includes(asset.thumbnail_url))) return null;
  return asset;
}

function shareId(userId: string, assetId: string) {
  return `image-share-${createHash('sha256').update(`${userId}:${assetId}`).digest('hex').slice(0, 40)}`;
}

function failure(error: unknown) {
  if (error instanceof ReactionError || error instanceof AuthError) return reactionJson({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return reactionJson({ error: '请求格式无效' }, 400);
  return reactionJson({ error: '图片分享暂时失败，请重试' }, 503);
}

export async function GET(request: NextRequest) {
  try {
    const user = await reactionUser();
    const asset = await ownedImage(user, request.nextUrl.searchParams.get('key') || '');
    if (!asset) return reactionJson({ canShare: false, shared: false });
    const id = shareId(user.id, asset.id);
    const album = await prisma.referenceAlbum.findUnique({ where: { id } });
    return reactionJson({ canShare: true, shared: album?.status === 'active' && album.visibility === 'public', href: `/collections/${id}` });
  } catch (error) { return failure(error); }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await reactionUser(request);
    const body = await request.json();
    if (typeof body.active !== 'boolean') throw new ReactionError('请选择分享或取消分享');
    const asset = await ownedImage(user, body.key);
    if (!asset) throw new ReactionError('只能分享自己拥有且允许公开的图片', 403);
    const id = shareId(user.id, asset.id);
    const imageId = `${id}-image`;
    await prisma.$transaction(async tx => {
      if (body.active) {
        await tx.referenceAlbum.upsert({ where: { id },
          create: { id, owner_user_id: user.id, name: '分享的图片', album_type: 'personal', visibility: 'public', cover_image_id: imageId },
          update: { status: 'active', visibility: 'public', album_type: 'personal', cover_image_id: imageId },
        });
        await tx.referenceImage.upsert({ where: { id: imageId },
          create: { id: imageId, album_id: id, owner_user_id: user.id, url: asset.original_url,
            thumbnail_url: asset.thumbnail_url, source_type: 'shared' },
          update: { status: 'active', url: asset.original_url, thumbnail_url: asset.thumbnail_url },
        });
      } else {
        await tx.referenceAlbum.updateMany({ where: { id, owner_user_id: user.id }, data: { visibility: 'private', album_type: 'personal' } });
      }
      await tx.operationLog.create({ data: { operator_id: user.id, action: body.active ? 'image_share_publish' : 'image_share_revoke',
        target_type: 'ReferenceAlbum', target_id: id, detail: JSON.stringify({ assetId: asset.id }) } });
    });
    return reactionJson({ canShare: true, shared: body.active, href: `/collections/${id}` });
  } catch (error) { return failure(error); }
}
