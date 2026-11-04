import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { StudioError } from '@/lib/image-studio/tasks';
import { labCellRect, labPng, readLabReference } from './media';
import { labId, labText, readLabWorkspace, workspaceKey } from './store';
import { sameLabReference, type CharacterLabWorkspace } from './types';

const layout = 'sheet-2x2-v1';
const folder = () => path.join(process.cwd(), 'storage', 'character-lab-compositions');
const imagePath = (id: string) => path.join(folder(), id + '.png');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function selectedSheet(workspace: CharacterLabWorkspace) {
  const { sourceAssetId, mainFace } = workspace.draft;
  const side = workspace.views?.side, front = workspace.views?.['body-front'], back = workspace.views?.['body-back'];
  if (!sourceAssetId || !mainFace || !side || !front || !back) throw new StudioError('请先选定正脸、侧脸、正面全身和背面全身');
  return { sourceAssetId, mainFace, side, front, back };
}

export async function composeLabSheet(user: SessionUser, workspace: CharacterLabWorkspace) {
  const { sourceAssetId, mainFace, side, front, back } = selectedSheet(workspace);
  const references = [
    ['faces', mainFace], ['side', side], ['body-front', front], ['body-back', back],
  ] as const;
  const width = 1600, height = 2400, background = { r: 232, g: 232, b: 232, alpha: 1 };
  const panels: sharp.OverlayOptions[] = [];
  for (const [index, [slot, choice]] of references.entries()) {
    const plan = await readLabReference(user, workspace.id, sourceAssetId, choice, slot);
    if (slot === 'side' && !sameLabReference(plan.mainFace, mainFace)) throw new StudioError('当前侧脸对应旧正脸，请选用与当前正脸匹配的侧脸', 409);
    const rect = labCellRect(width, height, { kind: 'result', count: 4 }, index);
    const input = await sharp(await labPng(user, plan, choice.cell))
      .resize(rect.width, rect.height, { fit: 'contain', background }).flatten({ background }).png().toBuffer();
    panels.push({ input, left: rect.left, top: rect.top });
  }
  return sharp({ create: { width, height, channels: 3, background } }).composite(panels).png().toBuffer();
}

export async function saveLabComposition(user: SessionUser, body: Record<string, unknown>) {
  const id = labId(body.workspaceId, '角色项目');
  const key = workspaceKey(user.id, id);
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  if (!row) throw new StudioError('角色项目不存在或无权访问', 404);
  const workspace = JSON.parse(row.value_json) as CharacterLabWorkspace;
  if (workspace.revision !== body.revision) throw new StudioError('工作现场已更新，请核对选用图片后再保存', 409);
  const name = labText(body.name, 80, '作品名称') || workspace.name;
  const compositionId = digest([user.id, id, layout, selectedSheet(workspace), name]);
  if (workspace.compositions?.some(item => item.id === compositionId)) return workspace;

  const png = await composeLabSheet(user, workspace);
  await fs.mkdir(folder(), { recursive: true, mode: 0o700 });
  const temporary = imagePath(compositionId) + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, png, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, imagePath(compositionId));
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  const savedAt = new Date().toISOString();
  const next = {
    ...workspace, revision: workspace.revision + 1, updatedAt: savedAt,
    compositions: [{ id: compositionId, name, savedAt }, ...(workspace.compositions || [])],
  };
  const updated = await prisma.platformSetting.updateMany({
    where: { key, value_json: row.value_json }, data: { value_json: JSON.stringify(next), updated_by: user.id },
  });
  if (updated.count) return next;
  const latest = await readLabWorkspace(user.id, id);
  if (latest.compositions?.some(item => item.id === compositionId)) return latest;
  throw new StudioError('工作现场已更新，请核对选用图片后再保存', 409);
}

export async function readLabComposition(user: SessionUser, workspaceId: string, compositionId: string) {
  const workspace = await readLabWorkspace(user.id, workspaceId);
  const item = workspace.compositions?.find(result => result.id === compositionId);
  if (!item) throw new StudioError('合成图不存在或无权访问', 404);
  return { item, png: await fs.readFile(imagePath(item.id)) };
}
