import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { assetGenerationOrigin, type GenerationOrigin } from './generation-origin';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';
import { canViewStudioPreset } from '@/lib/image-studio/access';
import { archivedPresetKey } from '@/lib/image-studio/preset-lifecycle';
import { pickerRows, pickerSeek } from './picker-stream';

export async function pickerOrigin(user: SessionUser, asset: { id: string; owner_id: string; metadata_json: string | null }) {
  let metadata: Record<string, unknown> = {};
  try { const value = JSON.parse(asset.metadata_json || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) metadata = value; } catch { /* Unknown historical provenance stays unknown. */ }
  const base = assetGenerationOrigin(asset, new Map());
  if (base?.kind === 'multiview-output') return { generated: true, origin: base };
  let generated = Boolean(typeof metadata.studioTaskId === 'string' || ['image_generation_api', 'workspace_generation'].includes(String(metadata.source)));
  const matches = [];
  for await (const task of pickerRows((after, take) => prisma.imageStudioTask.findMany({
    where: { AND: [studioOutputTaskWhere, pickerSeek(after)], OR: [{ asset_id: asset.id }, ...(typeof metadata.studioTaskId === 'string' ? [{ id: metadata.studioTaskId }] : [])] },
    orderBy: { id: 'asc' }, take,
    select: { id: true, owner_id: true, asset_id: true, source_preset_id: true, module_id: true, snapshot_json: true, deleted_at: true, status: true, usage_json: true },
  }))) {
    if (!studioTaskHasViewableOutput(task)) continue;
    if (task.owner_id === user.id && task.asset_id === asset.id) generated = true;
    if (task.owner_id === asset.owner_id && !task.deleted_at) {
      if (matches.length < 2) matches.push(task);
    }
    // Two matches establish ambiguity, but scan remaining rows only if the
    // independent own-generated flag has not yet been determined.
    if (matches.length === 2 && generated) break;
  }
  if (matches.length !== 1) return { generated, origin: undefined };
  const task = matches[0];
  let snapshot: Record<string, unknown>;
  try { snapshot = JSON.parse(task.snapshot_json || '{}'); if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return { generated }; }
  catch { return { generated }; }
  let origin: GenerationOrigin | undefined;
  if ('avatar' in snapshot) {
    if (snapshot.avatar && typeof snapshot.avatar === 'object' && !Array.isArray(snapshot.avatar)) origin = { kind: 'random-person', label: `随机人物${snapshot.avatarLayout === 'contact-sheet-9' ? ' · 九宫格' : snapshot.avatarLayout === 'contact-sheet' ? ' · 四宫格' : ''}` };
  } else {
    const workspace = task.module_id ? await prisma.imageStudioModule.findFirst({ where: { id: task.module_id, owner_id: user.id }, select: { id: true, owner_id: true, name: true, source_preset_id: true } }) : null;
    const presetId = task.source_preset_id || (typeof snapshot.sourcePresetId === 'string' ? snapshot.sourcePresetId : null) || workspace?.source_preset_id;
    if (presetId) {
      const preset = await prisma.imageStudioPreset.findUnique({ where: { id: presetId }, select: { id: true, name: true, owner_id: true, scope: true, is_shared: true } });
      const archived = await prisma.platformSetting.findUnique({ where: { key: archivedPresetKey(presetId) }, select: { key: true } });
      origin = { kind: 'template-image', label: '模板生图', ...(preset && !archived && canViewStudioPreset(user, preset)
        ? { templateId: preset.id, templateName: preset.name, ...(workspace?.source_preset_id === preset.id ? { templateAliases: [workspace.id] } : {}) }
        : workspace ? { templateId: workspace.id, templateName: workspace.name } : {}) };
    } else if (task.module_id) origin = { kind: 'template-image', label: '模板生图', ...(workspace ? { templateId: workspace.id, templateName: workspace.name } : {}) };
    else origin = { kind: 'other-generated', label: '其他生成' };
  }
  return { generated: generated || Boolean(origin), origin };
}
