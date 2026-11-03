import 'server-only';
import type { Prisma, Work } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { canViewStudioPreset, canViewStudioModule } from '@/lib/image-studio/access';
import { archivedPresetKey } from '@/lib/image-studio/preset-lifecycle';
import { canReadTemplate } from '@/lib/template-studio/templates';
import { isPrivateMultiviewTask, isPrivateMultiviewActionTask } from '@/lib/video/multiview-task-privacy';
import { worksContextSchemaReady } from './context-index';
import type { WorkProvenance } from './types';

/** Already-authorized output IDs only. Batch metadata, never recipes or per-card context requests. */
export async function projectWorkProvenance(user: SessionUser, works: Work[], db: Prisma.TransactionClient) {
  const result = new Map<string, WorkProvenance>();
  for (const work of works) result.set(work.id, { template: null, tool: work.source_kind === 'multiview_work'
    ? { label: '3D多视图', href: '/multiview' } : work.source_kind === 'upload_asset'
      ? { label: '素材上传', href: '/assets' } : work.source_kind === 'video_task'
        ? { label: '视频生成', href: '/generate' } : { label: '图片生成', href: '/template-studio?type=image' } });
  const videoIds = works.filter(work => work.source_kind === 'video_task').map(work => work.source_id);
  if (videoIds.length) {
    const tasks = await db.videoTask.findMany({ where: { id: { in: videoIds } }, select: { id: true, source_metadata_json: true } });
    const tools = new Map(tasks.flatMap(task => isPrivateMultiviewTask(task) ? [[task.id, {
      label: isPrivateMultiviewActionTask(task) ? '同步动作视频' : '3D多视图', href: '/multiview',
    }] as const] : []));
    for (const work of works) {
      const tool = work.source_kind === 'video_task' ? tools.get(work.source_id) : null;
      if (tool) result.get(work.id)!.tool = tool;
    }
  }
  if (!await worksContextSchemaReady(db)) return result;
  const rows = await db.workContext.findMany({ where: { work_id: { in: works.map(work => work.id) }, schema_version: 1 },
    select: { work_id: true, media_version_id: true, template_module: true, template_id: true, template_version: true, template_token: true } });
  const current = new Map(works.map(work => [work.id, work.current_version_id]));
  const metadata = rows.filter(row => row.media_version_id === current.get(row.work_id));
  if (!metadata.some(row => row.template_id)) return result;
  const ids = (kind: string) => metadata.filter(row => row.template_module === kind && row.template_id).map(row => row.template_id!);
  const [modules, videos, legacy] = await Promise.all([
    db.imageStudioModule.findMany({ where: { id: { in: ids('image-module') }, owner_id: user.id }, select: { id: true, name: true, owner_id: true, source_preset_id: true } }),
    db.videoStudioTemplate.findMany({ where: { id: { in: ids('video-studio') }, status: { not: 'archived' } },
      select: { id: true, name: true, owner_user_id: true, status: true, visibility: true, revision: true, published_version: { select: { id: true, name: true } } } }),
    db.generationTemplate.findMany({ where: { id: { in: ids('video-legacy') }, status: 'active' }, select: { id: true, name: true } }),
  ]);
  const presetIds = Array.from(new Set([...ids('image-preset'), ...modules.flatMap(row => row.source_preset_id ? [row.source_preset_id] : [])]));
  const [presets, archived] = await Promise.all([
    db.imageStudioPreset.findMany({ where: { id: { in: presetIds } }, select: { id: true, name: true, owner_id: true, scope: true, is_shared: true, updated_at: true } }),
    db.platformSetting.findMany({ where: { key: { in: presetIds.map(archivedPresetKey) } }, select: { key: true } }),
  ]);
  const revoked = new Set(archived.map(row => row.key));
  const allowedPresets = new Map(presets.filter(row => canViewStudioPreset(user, row) && !revoked.has(archivedPresetKey(row.id))).map(row => [row.id, row]));
  const allowedModules = new Map(modules.filter(row => canViewStudioModule(user, row, row.source_preset_id ? allowedPresets.get(row.source_preset_id) || null : null)).map(row => [row.id, row]));
  const allowedVideos = new Map(videos.filter(row => canReadTemplate(row, user)).map(row => [row.id, row]));
  const legacyById = new Map(legacy.map(row => [row.id, row]));
  for (const row of metadata) {
    if (!row.template_id) continue;
    const source = result.get(row.work_id)!;
    const query = new URLSearchParams();
    if (row.template_module === 'image-preset' || row.template_module === 'image-module') {
      const preset = row.template_module === 'image-preset' ? allowedPresets.get(row.template_id) : null;
      const template = preset || (row.template_module === 'image-module' ? allowedModules.get(row.template_id) : null);
      if (!template) continue;
      query.set('type', 'image'); query.set(row.template_module === 'image-preset' ? 'presetId' : 'moduleId', template.id);
      source.tool = { label: '图片模板', href: '/template-studio?type=image' };
      source.template = { label: template.name, href: '/template-studio?' + query, version: row.template_version,
        reuseVersion: preset && row.template_token && preset.updated_at.toISOString() === row.template_version ? row.template_version : null };
    } else {
      const video = row.template_module === 'video-studio' ? allowedVideos.get(row.template_id) : undefined, template = row.template_module === 'video-studio' ? video : row.template_module === 'video-legacy' ? legacyById.get(row.template_id) : null;
      if (!template) continue;
      query.set('type', 'video'); query.set('view', 'templates'); query.set('templateId', template.id); query.set('templateSource', row.template_module === 'video-studio' ? 'studio' : 'legacy');
      source.tool = { label: '视频模板', href: '/template-studio?type=video' };
      const published = video?.visibility === 'shared' && video.status === 'published' ? video.published_version : null;
      source.template = { label: published?.name || template.name, href: '/template-studio?' + query, version: row.template_version,
        reuseVersion: video && row.template_version === (published?.id || `studio:${video.revision}`) ? row.template_version : null };
    }
  }
  return result;
}
