import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { uploadAsset } from '@/lib/assets/storage';
import { readStudioImage } from '@/lib/image-studio/media';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { assertCanUseReferenceImage } from '@/lib/reference-albums/permissions';
import { sourceLibrary, packageFile, privateManifest } from './runtime';
import type { JsonObject } from './types';
export async function ownedUiImage(user: SessionUser, id: string) {
  const asset = await prisma.asset.findFirst({ where: { id, owner_id: user.id, type: 'image', status: 'active' } });
  if (!asset || !await canReadStudioAsset(user, asset)) throw new AuthError('图片不可用或无权读取', 403);
  return asset;
}
export async function uiUseAsset(user: SessionUser, input: { assetId: string; referenceImageId?: string }) {
  if (!input.referenceImageId) return ownedUiImage(user, input.assetId);
  const image = await assertCanUseReferenceImage(user, input.referenceImageId);
  if (!image.asset || image.asset_id !== input.assetId || image.asset.status !== 'active') throw new AuthError('参考图已不可用或使用权限已变化', 403);
  return image.asset;
}
export async function registerUiImage(user: SessionUser, input: JsonObject) {
  const savedReference = typeof input.dataUrl === 'string' && /^\/api\/tools\/ui-design\/media\?id=([a-zA-Z0-9-]{1,100})$/.exec(input.dataUrl);
  if (savedReference) input = { ...input, assetId: savedReference[1] };
  if (input.referenceImageId && !input.assetId) { const image = await assertCanUseReferenceImage(user, input.referenceImageId); input = { ...input, assetId: image.asset_id }; }
  if (input.assetId) {
    const asset = await uiUseAsset(user, input as { assetId: string; referenceImageId?: string });
    return { assetId: asset.id, referenceImageId: input.referenceImageId, hash: asset.hash,
      url: asset.owner_id === user.id ? `/api/tools/ui-design/media?id=${asset.id}` : null, useOnly: asset.owner_id !== user.id };
  }
  let bytes: Buffer, name = '设计参考.png';
  if (input.library) {
    const manifest = await privateManifest();
    if (input.library.sourceVersion !== manifest.sourceSha256) throw new AuthError('来源库版本已变化，请重新读取', 409);
    const plan = (await sourceLibrary()).find(item => item.id === input.library.planId);
    const url = plan?.previews?.[input.library.frameId];
    const match = /^\/api\/figma-assets\/([a-f0-9]{64}\.png)$/.exec(url || '');
    if (!match || !plan?.source.frames.some((frame: JsonObject) => frame.id === input.library.frameId)) throw new AuthError('原结构图不存在', 404);
    bytes = await packageFile(`library/figma-cache/assets/${match[1]}`);
    name = `${plan.name}-${input.library.frameId}.png`;
  } else {
    const match = typeof input.dataUrl === 'string' && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.dataUrl);
    if (!match || match[2].length > 40_000_000) throw new AuthError('图片格式或大小无效', 413);
    bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2]) throw new AuthError('图片编码无效', 400);
    name = typeof input.name === 'string' ? input.name.slice(0, 180) : name;
  }
  const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format || '')) throw new AuthError('无法解码图片', 422);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const mime = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`;
  const asset = await uploadAsset(bytes, name, mime, user.id, { width: metadata.width, height: metadata.height }, `ui-${hash}`);
  return { assetId: asset.assetId, hash, url: `/api/tools/ui-design/media?id=${asset.assetId}`, width: metadata.width, height: metadata.height };
}
export async function uiImageBytes(user: SessionUser, id: string) {
  const asset = await ownedUiImage(user, id);
  return { asset, bytes: await readStudioImage(asset.original_url) };
}
