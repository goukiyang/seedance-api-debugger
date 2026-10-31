import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { readStudioImage } from '@/lib/image-studio/media';
import { StudioError } from '@/lib/image-studio/tasks';
import { studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { readLabPlan } from './store';
import type { CharacterLabFace, CharacterLabPlan } from './types';

export async function ownedLabAsset(user: SessionUser, id: string) {
  const asset = await prisma.asset.findFirst({ where: { id, owner_id: user.id, type: 'image', status: 'active' } });
  if (!asset || !await canReadStudioAsset(user, asset)) throw new StudioError('原素材已不可用或无权读取，已有工作现场保留', 403);
  return asset;
}
export async function labOutput(user: SessionUser, plan: CharacterLabPlan) {
  const task = await prisma.imageStudioTask.findFirst({ where: { owner_id: user.id,
    batch_id: createHash('sha256').update(`${user.id}:${plan.id}`).digest('hex'), deleted_at: null } });
  if (!task || !studioTaskHasViewableOutput(task) || !task.asset_id) throw new StudioError('原生成结果尚未就绪或已不可用', 409);
  return { task, asset: await ownedLabAsset(user, task.asset_id) };
}
// The provider is asked to use these same cell boundaries. Crops retain source pixels.
export function labCellRect(width: number, height: number, plan: Pick<CharacterLabPlan, 'kind' | 'count'>, cell: number) {
  const columns = plan.kind === 'faces' && plan.count === 9 ? 3 : 2;
  const count = plan.kind === 'faces' ? plan.count : 4;
  if (!Number.isInteger(cell) || cell < 0 || cell >= count) throw new StudioError('格子选择无效');
  const column = cell % columns, row = Math.floor(cell / columns);
  const left = Math.floor(width * column / columns), right = Math.floor(width * (column + 1) / columns);
  const top = plan.kind === 'result' ? row === 0 ? 0 : Math.round(height * 0.42) : Math.floor(height * row / columns);
  const bottom = plan.kind === 'result' ? row === 0 ? Math.round(height * 0.42) : height : Math.floor(height * (row + 1) / columns);
  if (right <= left || bottom <= top) throw new StudioError('原图尺寸不足以拆分，原整图保留', 409);
  return { left, top, width: right - left, height: bottom - top };
}
export async function labPng(user: SessionUser, plan: CharacterLabPlan, cell?: number) {
  const { asset } = await labOutput(user, plan);
  const input = await readStudioImage(asset.original_url);
  return labPngFromBytes(input, plan, cell);
}
export async function labPngFromBytes(input: Buffer, plan: CharacterLabPlan, cell?: number) {
  const image = sharp(input, { limitInputPixels: 40_000_000, animated: false }).rotate();
  if (cell === undefined) return image.png().toBuffer();
  const metadata = await sharp(input, { limitInputPixels: 40_000_000, animated: false }).metadata();
  const swapped = metadata.orientation !== undefined && metadata.orientation >= 5;
  const width = swapped ? metadata.height : metadata.width, height = swapped ? metadata.width : metadata.height;
  if (!width || !height) throw new StudioError('原图无法解码，未拆分', 409);
  return image.extract(labCellRect(width, height, plan, cell)).png().toBuffer();
}
export async function persistLabFace(user: SessionUser, choice: CharacterLabFace) {
  const plan = await readLabPlan(user.id, choice.planId);
  if (plan.kind !== 'faces') throw new StudioError('面部参考须来自原人脸候选', 400);
  await labOutput(user, plan);
  const id = `clab-${createHash('sha256').update(`${user.id}:${plan.id}:${choice.cell}`).digest('hex')}`;
  const existing = await prisma.asset.findUnique({ where: { id } });
  if (existing) {
    if (existing.owner_id !== user.id || existing.status !== 'active') throw new StudioError('此独立面部素材已不可用，请选择其他方案', 409);
    return id;
  }
  const png = await labPng(user, plan, choice.cell), metadata = await sharp(png).metadata();
  const directory = path.join(process.cwd(), 'public/uploads/assets');
  await fs.mkdir(directory, { recursive: true });
  const filename = `${id}.png`, file = path.join(directory, filename), temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, png);
  await fs.rename(temporary, file);
  await prisma.asset.upsert({ where: { id }, update: {}, create: { id, owner_id: user.id, type: 'image',
    original_url: `/uploads/assets/${filename}`, thumbnail_url: null, file_name: `角色面部-${choice.cell + 1}.png`,
    mime_type: 'image/png', width: metadata.width, height: metadata.height, file_size: png.length,
    metadata_json: JSON.stringify({ source: 'character_lab_face', planId: plan.id, cell: choice.cell }) } });
  await ownedLabAsset(user, id);
  return id;
}
