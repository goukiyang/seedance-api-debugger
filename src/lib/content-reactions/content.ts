import 'server-only';
import { prisma } from '@/lib/prisma';
import { assetGenerationOrigin, generationOrigins } from '@/lib/assets/generation-origin';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';
import { getReferenceImageByIdForAccess, getAlbumAccess } from '@/lib/reference-albums/permissions';
import { canUseCompanyTemplates, canViewStudioPreset, isExplicitPresetAsset } from '@/lib/image-studio/access';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { visibleRunPrompt } from '@/lib/template-studio/projection';
import { getStudioTemplate } from '@/lib/template-studio/templates';
import { StudioError } from '@/lib/template-studio/errors';
import type { StudioRunSnapshot } from '@/lib/template-studio/types';
import { CONTENT_TYPES, type ContentKey, type ContentSummary, type ContentCategory } from './types';

export class ReactionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function parseContentKey(input: unknown): ContentKey {
  if (typeof input !== 'string' || input.length > 180) throw new ReactionError('内容编号无效');
  const [type, id, extra] = input.split(':');
  if (!CONTENT_TYPES.includes(type as typeof CONTENT_TYPES[number]) || !id || extra !== undefined || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new ReactionError('内容编号无效');
  return input as ContentKey;
}

export type ResolvedContent = {
  summary: ContentSummary;
  source?: { url: string; thumbnail: string | null; referenceId?: string; canPreviewOriginal?: boolean; mimeType?: string; fileName?: string };
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
async function referenceAccess(user: SessionUser, id: string) {
  const ref = await getReferenceImageByIdForAccess(id);
  if (!ref || (ref.asset && ref.asset.status !== 'active')) return null;
  const access = await getAlbumAccess(user, ref.album);
  return access.permissions.view ? { ref, permissions: access.permissions } : null;
}

// Resolve identity and current authorization together; never persist content snapshots in reactions.
export async function resolveContent(user: SessionUser, input: ContentKey): Promise<ResolvedContent | null> {
  const [type, id] = input.split(':');
  try {
    if (type === 'reference_image') {
      const access = await referenceAccess(user, id);
      if (!access) return null;
      if (access.ref.asset_id) return resolveContent(user, `asset:${access.ref.asset_id}`);
      const item = summary(input, 'image', '参考图片', `/collections/${access.ref.album_id}`);
      item.owner = await owner(access.ref.owner_user_id);
      if (access.permissions.use && user.account_type === 'internal') item.reuse = { referenceImageId: id };
      return { summary: withMedia(item, access.permissions.download), source: { url: access.ref.url, thumbnail: access.ref.thumbnail_url, referenceId: id } };
    }
    if (type === 'asset') {
      const asset = await prisma.asset.findUnique({ where: { id } });
      if (!asset || asset.status !== 'active' || !['image', 'video', 'audio'].includes(asset.type)) return null;
      if (!await canReadStudioAsset(user, asset)) return null;
      let allowed = asset.owner_id === user.id || user.role === 'admin';
      let download = allowed;
      let referenceId: string | undefined;
      let reusableReferenceId: string | undefined;
      if (!allowed) {
        const refs = await prisma.referenceImage.findMany({ where: { asset_id: id, status: 'active' }, select: { id: true } });
        for (const ref of refs) {
          const access = await referenceAccess(user, ref.id);
          if (!access) continue;
          allowed = true;
          if (!referenceId || access.permissions.download) referenceId = ref.id;
          download ||= access.permissions.download;
          if (access.permissions.use) reusableReferenceId = ref.id;
        }
      }
      if (!allowed && canUseCompanyTemplates(user)) {
        const presets = await prisma.imageStudioPreset.findMany({ where: { OR: [{ owner_id: user.id }, { is_shared: true }] } });
        allowed = presets.some(preset => canViewStudioPreset(user, preset) && isExplicitPresetAsset(preset, id));
      }
      if (!allowed) return null;
      const item = summary(input, asset.type as ContentCategory, asset.file_name || '素材', `/assets?content=${encodeURIComponent(input)}`);
      if (asset.type === 'image') item.generationOrigin = assetGenerationOrigin(asset, await generationOrigins(user, [asset]));
      item.owner = await owner(asset.owner_id);
      if (user.account_type === 'internal') {
        if (asset.owner_id === user.id || user.role === 'admin') item.reuse = { assetId: id };
        else if (reusableReferenceId) item.reuse = { referenceImageId: reusableReferenceId };
      }
      const media = withMedia(item, download);
      const canPreviewOriginal = download || Boolean(reusableReferenceId);
      if (asset.type !== 'image' && !canPreviewOriginal) media.previewUrl = null;
      if (asset.type === 'video' && !asset.thumbnail_url) media.thumbnailUrl = null;
      return { summary: media, source: { url: asset.original_url, thumbnail: asset.thumbnail_url, referenceId: download ? referenceId : reusableReferenceId || referenceId, canPreviewOriginal, mimeType: asset.mime_type || undefined, fileName: asset.file_name } };
    }
    if (type === 'video_task') {
      const task = await prisma.videoTask.findUnique({ where: { id } });
      if (!task || task.local_status !== 'succeeded' || isTaskHiddenFromRegularUsers(task)) return null;
      await assertCanViewTask(user, task);
      const item = summary(input, 'video', '生成视频', `/tasks/${id}`);
      item.owner = await owner(task.owner_user_id || task.user_id);
      item.thumbnailUrl = `/api/video/thumbnail/${id}`;
      item.previewUrl = `/api/video/play/${id}`;
      item.downloadUrl = `/api/video/download/${id}`;
      return { summary: item };
    }
    if (user.account_type !== 'internal') return null;
    if (type === 'image_template') {
      const row = await prisma.imageStudioPreset.findUnique({ where: { id } });
      if (!row || !canViewStudioPreset(user, row)) return null;
      const item = summary(input, 'template', row.name, `/template-studio?type=image&presetId=${id}`);
      item.templateKind = 'definition'; item.templateMedium = 'image';
      item.actionLabel = '使用模板'; item.versionLabel = row.updated_at.toISOString(); item.owner = await owner(row.owner_id);
      return { summary: item };
    }
    if (type === 'image_module') {
      const row = await prisma.imageStudioModule.findUnique({ where: { id } });
      if (!row || row.owner_id !== user.id || !canUseCompanyTemplates(user)) return null;
      if (row.source_preset_id) {
        const source = await prisma.imageStudioPreset.findUnique({ where: { id: row.source_preset_id } });
        if (!source || !canViewStudioPreset(user, source)) return null;
      }
      const item = summary(input, 'template', row.name, `/template-studio?type=image&moduleId=${id}`);
      item.templateKind = 'workpage'; item.templateMedium = 'image';
      item.actionLabel = '继续编辑'; item.versionLabel = String(row.revision); item.owner = await owner(row.owner_id);
      return { summary: item };
    }
    if (type === 'video_template') {
      const row = await prisma.videoStudioTemplate.findUnique({ where: { id }, include: { published_version: { select: { name: true, version_number: true } } } });
      if (!row || row.status === 'archived' || !(row.owner_user_id === user.id || user.role === 'admin' || (row.status === 'published' && row.visibility === 'shared' && row.published_version))) return null;
      const manages = row.owner_user_id === user.id || user.role === 'admin';
      const item = summary(input, 'template', manages ? row.name : row.published_version!.name, `/template-studio?type=video&templateId=${id}&templateSource=studio`);
      item.templateKind = 'definition'; item.templateMedium = 'video';
      item.actionLabel = '使用模板'; item.versionLabel = manages ? `修订 ${row.revision}` : `V${row.published_version!.version_number}`; item.owner = await owner(row.owner_user_id);
      return { summary: item };
    }
    if (type === 'video_draft') {
      const row = await prisma.videoStudioDraft.findFirst({ where: { id, owner_user_id: user.id } });
      if (!row) return null;
      if (row.source_template_id && (row.template_source === 'studio' || row.template_source === 'legacy')) {
        const source = await getStudioTemplate(user, row.source_template_id, row.template_source);
        if (source.template.status === 'archived') return null;
      }
      const item = summary(input, 'template', row.name, `/template-studio?type=video&draftId=${id}`);
      item.templateKind = 'workpage'; item.templateMedium = 'video';
      item.actionLabel = '继续编辑'; item.versionLabel = String(row.revision); item.owner = await owner(user.id);
      return { summary: item };
    }
    if (type === 'legacy_template') {
      const row = await prisma.generationTemplate.findFirst({ where: { id, status: 'active' } });
      if (!row) return null;
      const item = summary(input, 'template', row.name, `/template-studio?type=video&templateId=${id}&templateSource=legacy`);
      item.templateKind = 'definition'; item.templateMedium = 'video';
      item.actionLabel = '使用模板'; item.versionLabel = String(row.version);
      return { summary: item };
    }
    if (type === 'prompt') {
      const row = await prisma.videoStudioRun.findFirst({ where: { id, owner_user_id: user.id, status: 'succeeded' } });
      if (!row) return null;
      const snapshot = JSON.parse(row.snapshot_json) as StudioRunSnapshot;
      if (snapshot.templateVersion) {
        const current = await getStudioTemplate(user, snapshot.templateVersion.templateId, snapshot.templateVersion.templateSource);
        if (current.template.status === 'archived') return null;
      }
      const prompt = visibleRunPrompt(row);
      if (!prompt) return null;
      const item = summary(input, 'prompt', prompt.slice(0, 120), `/template-studio?type=video&view=prompts&runId=${id}`);
      item.actionLabel = '编辑 / 带到生成'; item.versionLabel = row.created_at.toISOString(); item.owner = await owner(row.owner_user_id);
      return { summary: item, prompt };
    }
    if (type === 'seedance_asset') {
      const row = await prisma.seedanceAsset.findFirst({ where: { id, local_status: 'Active' } });
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
