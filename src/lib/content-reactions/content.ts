import 'server-only';
import { prisma } from '@/lib/prisma';
import { assetGenerationOrigin, generationOrigins } from '@/lib/assets/generation-origin';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';
import { videoDeliveryStageForTask, videoPlayableAvailableForTask } from '@/lib/video/delivery-status';
import { getReferenceImageByIdForAccess, getAlbumAccess } from '@/lib/reference-albums/permissions';
import { canUseCompanyTemplates, canViewStudioPreset, canViewStudioModule, isExplicitPresetAsset } from '@/lib/image-studio/access';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { visibleRunPrompt } from '@/lib/template-studio/projection';
import { getStudioTemplate } from '@/lib/template-studio/templates';
import { StudioError } from '@/lib/template-studio/errors';
import type { StudioRunSnapshot } from '@/lib/template-studio/types';
import { type ContentKey, type ContentSummary, type ContentCategory } from './types';
import { resolveCutoutResult, type CutoutContentContext } from './cutout-content';
import { tryContentKeyParts } from './key';
import { studioPresetArchived } from '@/lib/image-studio/preset-lifecycle';
import { studioFixedCoverDTO } from '@/lib/image-studio/module-cover';
import { assertStudioActor, studioSharedBinding } from '@/lib/image-studio/shared-contract';
import { resolveStudioPinnedAsset } from '@/lib/image-studio/result-pins';
import { multiviewOutputFileAccess } from '@/lib/video/multiview-output-access.server';
import { archivedPresetKey } from '@/lib/image-studio/preset-lifecycle';
import type { ReactionProjection } from './projection-context';

export class ReactionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function parseContentKey(input: unknown): ContentKey {
  if (!tryContentKeyParts(input)) throw new ReactionError('内容编号无效');
  return input as ContentKey;
}

export type ResolvedContent = {
  summary: ContentSummary;
  source?: { url: string; thumbnail: string | null; referenceId?: string; canPreviewOriginal?: boolean; mimeType?: string; fileName?: string;
    hdOwner?: { kind: 'asset' | 'reference'; id: string; ownerId: string } };
  prompt?: string;
};
const mediaUrl = (key: ContentKey, variant: string) => `/api/content-reactions/media?key=${encodeURIComponent(key)}&variant=${variant}`;
const owner = (id: string | null | undefined) => id ? prisma.user.findUnique({ where: { id }, select: { name: true, avatar_url: true } }) : null;
const summary = (key: ContentKey, category: ContentCategory, title: string, href: string): ContentSummary => ({
  key, category, title, href, thumbnailUrl: null, previewUrl: null, downloadUrl: null, actionLabel: '打开', versionLabel: null, owner: null,
});
function withMedia(item: ContentSummary, downloadable: boolean): ContentSummary {
  return { ...item, thumbnailUrl: item.category === 'audio' ? null : mediaUrl(item.key, 'thumbnail'), previewUrl: mediaUrl(item.key, 'preview'), downloadUrl: downloadable ? mediaUrl(item.key, 'download') : null };
}
async function referenceAccess(user: SessionUser, id: string, projection?: ReactionProjection) {
  const ref = projection ? projection.references.get(id) : await getReferenceImageByIdForAccess(id);
  if (!ref || (ref.asset && ref.asset.status !== 'active')) return null;
  let accessPromise = projection?.albumAccess.get(ref.album_id);
  if (!accessPromise) { accessPromise = getAlbumAccess(user, ref.album); projection?.albumAccess.set(ref.album_id, accessPromise); }
  const access = await accessPromise;
  return access.permissions.view ? { ref, permissions: access.permissions } : null;
}

// Resolve identity and current authorization together; never persist content snapshots in reactions.
export async function resolveContent(user: SessionUser, input: ContentKey, context?: CutoutContentContext, projection?: ReactionProjection): Promise<ResolvedContent | null> {
  const parsed = tryContentKeyParts(input);
  if (!parsed) throw new ReactionError('内容编号无效');
  const { type, id } = parsed;
  const projectedOwner = (id: string | null | undefined) => {
    if (!projection) return owner(id);
    const row = id ? projection.owners.get(id) : null;
    return row ? { name: row.name, avatar_url: row.avatar_url } : null;
  };
  const archived = (id: string) => projection ? projection.archived.has(archivedPresetKey(id)) : studioPresetArchived(id);
  const templateAccess = (templateId: string, source: 'legacy' | 'studio') => {
    const key = `${source}:${templateId}`;
    let value = projection?.templateAccess.get(key);
    if (!value) { value = getStudioTemplate(user, templateId, source); projection?.templateAccess.set(key, value); }
    return value;
  };
  try {
    if (type === 'cutout_result') {
      const result = await resolveCutoutResult(user, input, context);
      if (!result) return null;
      const item = summary(result.key, 'image', result.title, `/cutout?jobId=${encodeURIComponent(result.jobId)}`);
      item.owner = await projectedOwner(user.id);
      item.thumbnailUrl = result.url; item.previewUrl = result.url; item.downloadUrl = result.url;
      return { summary: item };
    }
    if (type === 'reference_image') {
      const access = await referenceAccess(user, id, projection);
      if (!access) return null;
      if (access.ref.asset_id) return resolveContent(user, `asset:${access.ref.asset_id}`, context, projection);
      const item = summary(input, 'image', '参考图片', `/collections/${access.ref.album_id}`);
      item.owner = await projectedOwner(access.ref.owner_user_id);
      if (access.permissions.use && user.account_type === 'internal') item.reuse = { referenceImageId: id };
      return { summary: withMedia(item, access.permissions.download), source: { url: access.ref.url, thumbnail: access.ref.thumbnail_url,
        referenceId: id, hdOwner: { kind: 'reference', id, ownerId: access.ref.owner_user_id } } };
    }
    if (type === 'asset') {
      const asset = projection ? projection.assets.get(id) : await prisma.asset.findUnique({ where: { id } });
      if (!asset || asset.status !== 'active' || !['image', 'video', 'audio'].includes(asset.type)) return null;
      if (projection) {
        if (projection.hiddenUrls.has(asset.original_url)) return null;
        let output = projection.outputAccess.get(asset.original_url);
        if (!output) { output = multiviewOutputFileAccess(user, asset.original_url, false); projection.outputAccess.set(asset.original_url, output); }
        const access = await output;
        if (access.protected && !access.allowed) return null;
      } else if (!await canReadStudioAsset(user, asset)) return null;
      let allowed = asset.owner_id === user.id || user.role === 'admin';
      let download = allowed;
      let referenceId: string | undefined;
      let reusableReferenceId: string | undefined;
      if (!allowed) {
        const refs = projection ? Array.from(projection.references.values()).filter(ref => ref.asset_id === id)
          : await prisma.referenceImage.findMany({ where: { asset_id: id, status: 'active' }, select: { id: true } });
        for (const ref of refs) {
          const access = await referenceAccess(user, ref.id, projection);
          if (!access) continue;
          allowed = true;
          if (!referenceId || access.permissions.download) referenceId = ref.id;
          download ||= access.permissions.download;
          if (access.permissions.use) reusableReferenceId = ref.id;
        }
      }
      if (!allowed && canUseCompanyTemplates(user)) {
        const presets = projection ? projection.assetPresets
          : await prisma.imageStudioPreset.findMany({ where: { OR: [{ owner_id: user.id }, { is_shared: true }] } });
        allowed = presets.some(preset => canViewStudioPreset(user, preset) && isExplicitPresetAsset(preset, id));
      }
      if (!allowed) {
        const pin = asset.type === 'image' ? await resolveStudioPinnedAsset(user, id) : null;
        if (!pin) return null;
        const item = summary(input, 'image', '模板置顶图片', `/template-studio?type=image&presetId=${encodeURIComponent(pin.presetId)}`);
        item.owner = await projectedOwner(asset.owner_id);
        // Only the output image is shared. Never expose its filename, generation origin,
        // private task route, inputs, prompt, reuse or download permissions.
        return { summary: withMedia(item, false), source: { url: asset.original_url, thumbnail: asset.thumbnail_url,
          canPreviewOriginal: false, mimeType: asset.mime_type || undefined, fileName: 'template-pinned-image',
          hdOwner: { kind: 'asset', id: asset.id, ownerId: asset.owner_id } } };
      }
      const item = summary(input, asset.type as ContentCategory, asset.file_name || '素材', `/assets?content=${encodeURIComponent(input)}`);
      if (asset.type === 'image' && projection?.details !== false) item.generationOrigin = assetGenerationOrigin(asset, await generationOrigins(user, [asset]));
      item.owner = await projectedOwner(asset.owner_id);
      if (user.account_type === 'internal') {
        if (asset.owner_id === user.id || user.role === 'admin') item.reuse = { assetId: id };
        else if (reusableReferenceId) item.reuse = { referenceImageId: reusableReferenceId };
      }
      const media = withMedia(item, download);
      const canPreviewOriginal = download || Boolean(reusableReferenceId);
      if (asset.type !== 'image' && !canPreviewOriginal) media.previewUrl = null;
      if (asset.type === 'video' && !asset.thumbnail_url) media.thumbnailUrl = null;
      return { summary: media, source: { url: asset.original_url, thumbnail: asset.thumbnail_url,
        referenceId: download ? referenceId : reusableReferenceId || referenceId, canPreviewOriginal,
        mimeType: asset.mime_type || undefined, fileName: asset.file_name,
        hdOwner: { kind: 'asset', id: asset.id, ownerId: asset.owner_id } } };
    }
    if (type === 'video_task') {
      const task = projection ? projection.tasks.get(id) : await prisma.videoTask.findUnique({ where: { id } });
      if (!task || task.local_status !== 'succeeded' || isTaskHiddenFromRegularUsers(task)) return null;
      if (projection && task.project_id) {
        let access = projection.taskAccess.get(task.project_id);
        if (!access) { access = assertCanViewTask(user, task); projection.taskAccess.set(task.project_id, access); }
        await access;
      } else await assertCanViewTask(user, task);
      const item = summary(input, 'video', '生成视频', `/tasks/${id}`);
      const deliveryStage = videoDeliveryStageForTask(task);
      item.owner = await projectedOwner(task.owner_user_id || task.user_id);
      item.thumbnailUrl = `/api/video/thumbnail/${id}`;
      item.previewUrl = videoPlayableAvailableForTask(task) ? `/api/video/play/${id}` : null;
      item.downloadUrl = deliveryStage.stableDownloadReady ? `/api/video/download/${id}` : null;
      return { summary: item };
    }
    if (user.account_type !== 'internal' && type !== 'image_template' && type !== 'image_module') return null;
    if (type === 'image_template') {
      const studioActor = projection?.studioActor || (user.account_type === 'external' ? await assertStudioActor(user.id) : user);
      let row = projection ? projection.presets.get(id) : await prisma.imageStudioPreset.findUnique({ where: { id } });
      if (!row && id.startsWith('module-source:')) {
        const workspace = projection ? projection.modules.get(id.slice('module-source:'.length))
          : await prisma.imageStudioModule.findUnique({ where: { id: id.slice('module-source:'.length) }, select: { source_preset_id: true } });
        if (workspace?.source_preset_id) row = projection ? projection.presets.get(workspace.source_preset_id)
          : await prisma.imageStudioPreset.findUnique({ where: { id: workspace.source_preset_id } });
      }
      if (!row || await archived(row.id) || !canViewStudioPreset(studioActor, row)) return null;
      const item = summary(input, 'template', row.name, `/template-studio?type=image&presetId=${encodeURIComponent(row.id)}`);
      item.templateKind = 'definition'; item.templateMedium = 'image';
      item.actionLabel = '使用模板'; item.versionLabel = row.updated_at.toISOString(); item.owner = await projectedOwner(row.owner_id);
      if (projection?.details === false) return { summary: item };
      const fixedCover = await studioFixedCoverDTO(studioActor, { kind: 'preset', id: row.id });
      if (fixedCover) { item.thumbnailUrl = fixedCover.thumbnailUrl; item.previewUrl = fixedCover.imageUrl; }
      return { summary: item };
    }
    if (type === 'image_module') {
      const studioActor = projection?.studioActor || (user.account_type === 'external' ? await assertStudioActor(user.id) : user);
      const row = projection ? projection.modules.get(id) : await prisma.imageStudioModule.findUnique({ where: { id } });
      if (!row) return null;
      const source = row.source_preset_id ? projection ? projection.presets.get(row.source_preset_id) || null
        : await prisma.imageStudioPreset.findUnique({ where: { id: row.source_preset_id } }) : null;
      if (source && await archived(source.id)) return null;
      if (!canViewStudioModule(studioActor, row, source)) return null;
      const item = summary(input, 'template', user.account_type === 'external' ? source!.name : row.name, `/template-studio?type=image&moduleId=${id}`);
      item.templateKind = 'workpage'; item.templateMedium = 'image';
      item.actionLabel = '继续编辑'; item.versionLabel = String(row.revision); item.owner = await projectedOwner(row.owner_id);
      if (projection?.details === false) return { summary: item };
      const binding = await studioSharedBinding(user.id, row.id);
      const fixedCover = await studioFixedCoverDTO(studioActor, source ? { kind: 'preset', id: source.id }
        : binding ? { kind: 'preset', id: binding.presetId } : { kind: 'module', id: row.id });
      if (fixedCover) { item.thumbnailUrl = fixedCover.thumbnailUrl; item.previewUrl = fixedCover.imageUrl; }
      return { summary: item };
    }
    if (type === 'video_template') {
      const row = projection ? projection.videoTemplates.get(id)
        : await prisma.videoStudioTemplate.findUnique({ where: { id }, include: { published_version: { select: { name: true, version_number: true } } } });
      if (!row || row.status === 'archived' || !(row.owner_user_id === user.id || user.role === 'admin' || (row.status === 'published' && row.visibility === 'shared' && row.published_version))) return null;
      const manages = row.owner_user_id === user.id || user.role === 'admin';
      const item = summary(input, 'template', manages ? row.name : row.published_version!.name, `/template-studio?type=video&templateId=${id}&templateSource=studio`);
      item.templateKind = 'definition'; item.templateMedium = 'video';
      item.actionLabel = '使用模板'; item.versionLabel = manages ? `修订 ${row.revision}` : `V${row.published_version!.version_number}`; item.owner = await projectedOwner(row.owner_user_id);
      return { summary: item };
    }
    if (type === 'video_draft') {
      const row = projection ? projection.drafts.get(id) : await prisma.videoStudioDraft.findFirst({ where: { id, owner_user_id: user.id, purpose: 'studio' } });
      if (!row) return null;
      if (row.source_template_id && (row.template_source === 'studio' || row.template_source === 'legacy')) {
        const source = await templateAccess(row.source_template_id, row.template_source);
        if (source.template.status === 'archived') return null;
      }
      const item = summary(input, 'template', row.name, `/template-studio?type=video&draftId=${id}`);
      item.templateKind = 'workpage'; item.templateMedium = 'video';
      item.actionLabel = '继续编辑'; item.versionLabel = String(row.revision); item.owner = await projectedOwner(user.id);
      return { summary: item };
    }
    if (type === 'legacy_template') {
      const row = projection ? projection.legacy.get(id) : await prisma.generationTemplate.findFirst({ where: { id, status: 'active' } });
      if (!row) return null;
      const item = summary(input, 'template', row.name, `/template-studio?type=video&templateId=${id}&templateSource=legacy`);
      item.templateKind = 'definition'; item.templateMedium = 'video';
      item.actionLabel = '使用模板'; item.versionLabel = String(row.version);
      return { summary: item };
    }
    if (type === 'prompt') {
      const row = projection ? projection.runs.get(id) : await prisma.videoStudioRun.findFirst({ where: { id, owner_user_id: user.id, purpose: 'studio', status: 'succeeded' } });
      if (!row) return null;
      const snapshot = JSON.parse(row.snapshot_json) as StudioRunSnapshot;
      if (snapshot.templateVersion) {
        const current = await templateAccess(snapshot.templateVersion.templateId, snapshot.templateVersion.templateSource);
        if (current.template.status === 'archived') return null;
      }
      const prompt = visibleRunPrompt(row);
      if (!prompt) return null;
      const item = summary(input, 'prompt', prompt.slice(0, 120), `/template-studio?type=video&view=prompts&runId=${id}`);
      item.actionLabel = '编辑 / 带到生成'; item.versionLabel = row.created_at.toISOString(); item.owner = await projectedOwner(row.owner_user_id);
      return { summary: item, prompt };
    }
    if (type === 'seedance_asset') {
      const row = projection ? projection.seedance.get(id) : await prisma.seedanceAsset.findFirst({ where: { id, local_status: 'Active' } });
      if (!row) return null;
      const category = row.asset_type.toLowerCase();
      if (!['image', 'video', 'audio'].includes(category)) return null;
      const item = summary(input, category as ContentCategory, row.name, '/assets');
      return { summary: withMedia(item, true), source: { url: row.original_url, thumbnail: null } };
    }
    return null;
  } catch (error) {
    if ((error instanceof AuthError || error instanceof StudioError) && [403, 404, 409].includes(error.status)) return null;
    throw error;
  }
}
