import { prisma } from '@/lib/prisma';
import { canViewStudioPreset } from '@/lib/image-studio/access';
import { archivedPresetKey } from '@/lib/image-studio/preset-lifecycle';
import type { SessionUser } from '@/lib/auth/session';
export type GenerationOrigin = { kind: 'template-image' | 'random-person' | 'other-generated' | 'video-generated' | 'unknown';
  label: string; templateId?: string; templateName?: string };
export function assetGenerationOrigin(asset: { id: string; metadata_json: string | null }, origins: Map<string, GenerationOrigin>) {
  if (origins.has(asset.id)) return origins.get(asset.id);
  try { const meta = JSON.parse(asset.metadata_json || '{}');
    if (typeof meta.studioTaskId === 'string' || ['image_generation_api', 'workspace_generation'].includes(meta.source)) return { kind: 'unknown' as const, label: '来源待识别' };
  } catch { /* No filename-based provenance. */ }
  return undefined;
}
export async function generationOrigins(user: SessionUser, assets: Array<{ id: string; owner_id: string; metadata_json: string | null }>) {
  const metadataTasks = new Map<string, string>();
  for (const asset of assets) {
    try { const meta = JSON.parse(asset.metadata_json || '{}'); if (typeof meta.studioTaskId === 'string') metadataTasks.set(asset.id, meta.studioTaskId); } catch { /* Invalid metadata stays unknown. */ }
  }
  const tasks = await prisma.imageStudioTask.findMany({ where: { status: 'succeeded', deleted_at: null, OR: [
    { asset_id: { in: assets.map(a => a.id) } }, { id: { in: Array.from(metadataTasks.values()) } },
  ] }, select: { id: true, asset_id: true, owner_id: true, source_preset_id: true, module_id: true, snapshot_json: true } });
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const tasksByAsset = new Map<string, typeof tasks>();
  const snapshots = new Map<string, Record<string, unknown>>();
  const presetIds = new Set<string>();
  for (const task of tasks) {
    if (task.asset_id) tasksByAsset.set(task.asset_id, [...(tasksByAsset.get(task.asset_id) || []), task]);
    try {
      const snapshot = JSON.parse(task.snapshot_json || '{}');
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
      snapshots.set(task.id, snapshot);
      const id = task.source_preset_id || (typeof snapshot.sourcePresetId === 'string' ? snapshot.sourcePresetId : null);
      if (id) presetIds.add(id);
    } catch { /* Keep malformed historical snapshots unknown. */ }
  }
  const presets = await prisma.imageStudioPreset.findMany({ where: { id: { in: Array.from(presetIds) } }, select: { id: true, name: true, owner_id: true, scope: true, is_shared: true } });
  const archived = new Set((await prisma.platformSetting.findMany({ where: { key: { in: Array.from(presetIds, archivedPresetKey) } }, select: { key: true } })).map(row => row.key));
  const presetById = new Map(presets.filter(preset => !archived.has(archivedPresetKey(preset.id))).map(preset => [preset.id, preset]));
  const modules = await prisma.imageStudioModule.findMany({ where: { id: { in: tasks.flatMap(task => task.module_id ? [task.module_id] : []) }, owner_id: user.id }, select: { id: true, name: true } });
  const moduleById = new Map(modules.map(module => [module.id, module]));
  const result = new Map<string, GenerationOrigin>();
  for (const asset of assets) {
    const linked = taskById.get(metadataTasks.get(asset.id) || '');
    const candidates = [...(tasksByAsset.get(asset.id) || []), ...(linked ? [linked] : [])];
    const matches = Array.from(new Map(candidates.filter(task => task.owner_id === asset.owner_id).map(task => [task.id, task])).values());
    if (matches.length !== 1) continue;
    const task = matches[0];
    const snapshot = snapshots.get(task.id);
    if (!snapshot) continue;
    if ('avatar' in snapshot) {
      if (!snapshot.avatar || typeof snapshot.avatar !== 'object' || Array.isArray(snapshot.avatar)) continue;
      const layout = snapshot.avatarLayout;
      result.set(asset.id, { kind: 'random-person', label: `随机人物${layout === 'contact-sheet-9' ? ' · 九宫格' : layout === 'contact-sheet' ? ' · 四宫格' : ''}` }); continue;
    }
    const presetId = task.source_preset_id || (typeof snapshot.sourcePresetId === 'string' ? snapshot.sourcePresetId : null);
    if (presetId) {
      const preset = presetById.get(presetId);
      result.set(asset.id, { kind: 'template-image', label: '模板生图',
        ...(preset && canViewStudioPreset(user, preset) ? { templateId: preset.id, templateName: preset.name } : {}) });
    } else if (task.module_id) {
      const workspace = moduleById.get(task.module_id);
      result.set(asset.id, { kind: 'template-image', label: '模板生图', ...(workspace ? { templateId: workspace.id, templateName: workspace.name } : {}) });
    } else result.set(asset.id, { kind: 'other-generated', label: '其他生成' });
  }
  return result;
}
