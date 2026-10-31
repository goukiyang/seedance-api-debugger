import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { VIDEO_FEISHU_SITE, videoFeishuId } from '@/lib/video/feishu-contract';
import type { ImageFeishuPresentation } from './feishu-contract';

export type ImageFeishuNavigation = { kind: 'module' | 'character-lab' | 'result'; label: string; path: string; moduleId: string | null };
const modulePath = (id: string) => `/template-studio?type=image&moduleId=${encodeURIComponent(id)}`;
const resultPath = (id: string) => `/image-studio/original/${encodeURIComponent(id)}`;
const label = (value: string) => Array.from(value.replace(/https?:\/\/\S+/gi, '').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
export const feishuPayloadHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function validImageFeishuNavigation(value: unknown, assetId: string): value is ImageFeishuNavigation {
  const nav = value as ImageFeishuNavigation | null;
  if (!nav || Object.keys(nav).sort().join(',') !== 'kind,label,moduleId,path' || typeof nav.label !== 'string' || !nav.label || label(nav.label) !== nav.label) return false;
  return nav.kind === 'character-lab' ? nav.label === '角色参考图工作台' && nav.path === '/tools/character-lab' && nav.moduleId === null
    : nav.kind === 'result' ? nav.label === '生成结果' && nav.path === resultPath(assetId) && nav.moduleId === null
      : nav.kind === 'module' && videoFeishuId(nav.moduleId) && nav.path === modulePath(nav.moduleId);
}
/** Resolve only this accepted task's owner and batch, never the browser's currently selected module. */
export async function resolveImageFeishuNavigation(db: Prisma.TransactionClient, task: { owner_id: string; module_id: string | null; batch_id: string }, assetId: string): Promise<ImageFeishuNavigation> {
  const { characterLabTaskBatchIds } = await import('@/lib/character-lab/task-source');
  if ((await characterLabTaskBatchIds(task.owner_id, db)).includes(task.batch_id)) return { kind: 'character-lab', label: '角色参考图工作台', path: '/tools/character-lab', moduleId: null };
  if (task.module_id) {
    const { defaultStudioModuleId, validStudioModuleId } = await import('./modules');
    if (!validStudioModuleId(task.module_id, task.owner_id)) return { kind: 'result', label: '生成结果', path: resultPath(assetId), moduleId: null };
    const row = await db.imageStudioModule.findFirst({ where: { id: task.module_id, owner_id: task.owner_id }, select: { id: true, name: true } });
    if (row && label(row.name)) return { kind: 'module', label: label(row.name), path: modulePath(row.id), moduleId: row.id };
    if (!row && task.module_id === defaultStudioModuleId(task.owner_id)) {
      const { readStudioWorkspaceDeletion } = await import('./workspace-deletion');
      if (!await readStudioWorkspaceDeletion(task.owner_id, task.module_id, db)) return { kind: 'module', label: '模块 1', path: modulePath(task.module_id), moduleId: task.module_id };
    }
  }
  return { kind: 'result', label: '生成结果', path: resultPath(assetId), moduleId: null };
}
export function imageFeishuNavigationCard(presentation: ImageFeishuPresentation, nav: ImageFeishuNavigation) {
  const plain = (content: string) => ({ tag: 'plain_text', content });
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'blue', title: plain('图片已生成') },
    elements: [{ tag: 'img', img_key: 'image_key_pending', mode: 'fit_horizontal', alt: plain('生成图片') },
      { tag: 'note', elements: [plain(`${presentation.kind === 'preview' ? '飞书预览图 · ' : ''}原图 ${presentation.originalWidth}×${presentation.originalHeight}`)] },
      { tag: 'action', actions: [{ tag: 'button', text: plain(nav.label), url: `${VIDEO_FEISHU_SITE}${nav.path}` }] }] });
}
export function imageFeishuNavigationPost(nav: ImageFeishuNavigation) {
  return JSON.stringify({ zh_cn: { content: [[{ tag: 'a', text: nav.label, href: `${VIDEO_FEISHU_SITE}${nav.path}` }]] } });
}
