import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from './media/sharp';
import { prisma } from '@/lib/prisma';
import { readStudioImage } from '@/lib/image-studio/media';

/** Custom avatars: cropped from the user's own original image on the server, stored as two webp sizes. */
export const AVATAR_SIZES = [512, 128] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];
export type AvatarCrop = { x: number; y: number; width: number; height: number };
export class AvatarError extends Error { constructor(message: string, public status = 400) { super(message); } }

const KEY = /^[a-f0-9]{32}$/;
const fileName = (userId: string, key: string, size: AvatarSize) => `${userId}-${key}-${size}.webp`;
// avatar_url carries a version, so every page that already reads it shows the new picture without stale caches.
export const customAvatarUrl = (userId: string, key: string) => `/api/avatars/${encodeURIComponent(userId)}?v=${key.slice(0, 12)}`;

export function parseAvatarCrop(value: unknown): AvatarCrop {
  const crop = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const numbers = ['x', 'y', 'width', 'height'].map(key => crop[key]);
  if (!numbers.every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 100_000)) throw new AvatarError('裁切范围无效');
  const [x, y, width, height] = numbers.map(item => Math.round(item as number));
  if (width < 128 || height < 128) throw new AvatarError('裁切区域太小，至少需要 128×128 像素');
  if (Math.abs(width - height) > Math.max(2, width * 0.02)) throw new AvatarError('头像需要正方形裁切');
  return { x, y, width, height: width };
}

async function avatarDirectory(write: boolean) {
  const root = await fs.realpath(path.join(process.cwd(), 'storage'));
  const folder = path.join(root, 'avatars');
  if (write) await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const real = await fs.realpath(folder);
  if (process.env.NODE_ENV === 'production') {
    // Same rule as module covers: only a directory on the real data disk.
    const data = await fs.realpath('/data');
    const [stat, dataStat, systemStat] = await Promise.all([fs.stat(real), fs.stat(data), fs.stat('/')]);
    if (!real.startsWith(`${data}${path.sep}`) || !stat.isDirectory() || stat.dev !== dataStat.dev || dataStat.dev === systemStat.dev) {
      throw new AvatarError('头像存储未连接数据盘，请联系管理员', 503);
    }
  }
  return real;
}

async function writeAtomic(directory: string, name: string, bytes: Buffer) {
  const file = path.join(directory, name), temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, bytes, { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

/** Renders both sizes from the original pixels of an image this user owns. */
export async function renderAvatar(bytes: Buffer, crop: AvatarCrop) {
  // EXIF orientation is applied first, matching what the browser showed while cropping.
  const rotated = await sharp(bytes, { limitInputPixels: 60_000_000, animated: false }).rotate().toBuffer();
  const { width = 0, height = 0 } = await sharp(rotated).metadata();
  if (crop.x + crop.width > width + 1 || crop.y + crop.height > height + 1) throw new AvatarError('裁切范围超出图片，请重新调整');
  const area = { left: crop.x, top: crop.y, width: Math.min(crop.width, width - crop.x), height: Math.min(crop.height, height - crop.y) };
  const [large, small] = await Promise.all(AVATAR_SIZES.map(size =>
    sharp(rotated).extract(area).resize(size, size, { fit: 'cover' }).webp({ quality: 86 }).toBuffer()));
  return { large, small };
}

export async function setCustomAvatar(userId: string, assetId: unknown, cropValue: unknown) {
  if (typeof assetId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(assetId)) throw new AvatarError('请先选择一张图片');
  const crop = parseAvatarCrop(cropValue);
  const asset = await prisma.asset.findFirst({ where: { id: assetId, owner_id: userId, status: 'active', type: 'image' }, select: { original_url: true } });
  if (!asset?.original_url) throw new AvatarError('图片不存在或不是你本人的图片', 404);
  let bytes: Buffer;
  try { bytes = await readStudioImage(asset.original_url, AbortSignal.timeout(30000)); }
  catch { throw new AvatarError('原图暂时读不到，请重新上传', 503); }
  const { large, small } = await renderAvatar(bytes, crop);
  const key = createHash('sha256').update(large).digest('hex').slice(0, 32);
  const directory = await avatarDirectory(true);
  await writeAtomic(directory, fileName(userId, key, 512), large);
  await writeAtomic(directory, fileName(userId, key, 128), small);
  const previous = await prisma.user.findUnique({ where: { id: userId }, select: { custom_avatar_key: true } });
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { avatar_source: 'custom', custom_avatar_key: key, avatar_url: customAvatarUrl(userId, key) } }),
    prisma.operationLog.create({ data: { operator_id: userId, action: 'avatar_change', target_type: 'User', target_id: userId,
      detail: JSON.stringify({ source: 'custom', key, assetId, crop }) } }),
  ]);
  await pruneAvatarFiles(directory, userId, [key, previous?.custom_avatar_key || '']);
  return { avatarUrl: customAvatarUrl(userId, key) };
}

/** Keeps the current and the previous version of one user's files; older ones are removed. */
async function pruneAvatarFiles(directory: string, userId: string, keep: string[]) {
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  await Promise.all(names.filter(name => name.startsWith(`${userId}-`) && name.endsWith('.webp')
    && !keep.some(key => key && name.startsWith(`${userId}-${key}-`))).map(name => fs.unlink(path.join(directory, name)).catch(() => {})));
}

/** feishu: back to the Feishu photo; initials: no picture. An admin may only reset someone else to Feishu. */
export async function restoreAvatar(actor: { id: string; role: string }, targetUserId: string, mode: 'feishu' | 'initials') {
  const admin = actor.id !== targetUserId;
  if (admin && (actor.role !== 'admin' || mode !== 'feishu')) throw new AvatarError('只能修改自己的头像；管理员只能把他人头像重置为飞书头像', 403);
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, feishu_avatar_url: true } });
  if (!target) throw new AvatarError('用户不存在', 404);
  const avatarUrl = mode === 'feishu' ? target.feishu_avatar_url : null;
  await prisma.$transaction([
    prisma.user.update({ where: { id: targetUserId }, data: { avatar_source: mode, avatar_url: avatarUrl } }),
    prisma.operationLog.create({ data: { operator_id: actor.id, action: admin ? 'avatar_admin_reset' : 'avatar_change', target_type: 'User',
      target_id: targetUserId, detail: JSON.stringify({ source: mode }) } }),
  ]);
  return { avatarUrl };
}

export async function readAvatarFile(userId: string, size: AvatarSize) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { avatar_source: true, custom_avatar_key: true } });
  const key = user?.avatar_source === 'custom' ? user.custom_avatar_key : null;
  if (!key || !KEY.test(key)) return null;
  try { return await fs.readFile(path.join(await avatarDirectory(false), fileName(userId, key, size))); }
  catch { return null; }
}
