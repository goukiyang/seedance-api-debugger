import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanUseReferenceImage } from '@/lib/reference-albums/permissions';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { ordinaryVideoTaskWhere } from '@/lib/video/multiview-task-privacy';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { seedanceReferenceMediaCapabilities } from '@/lib/provider/reference-media-policy';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { resolveCanvasWorkspaceScope, type CanvasWorkspaceScope } from './canvas-workspace';
import { CanvasReferenceError, canvasReferencesRequired, normalizeCanvasReferences, requireCanvasReferencesCapability, type CanvasReferences } from './canvas-references';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const location = (url: string) => siteUploadPathFromUrl(url) || url;
export function canvasAssetSourceVersion(asset: { id: string; type: string; original_url: string; hash: string | null;
  file_size: number; mime_type: string; created_at: Date }) {
  return digest([asset.id, asset.type, location(asset.original_url), asset.hash, asset.file_size, asset.mime_type, asset.created_at.toISOString()]);
}
function fail(message: string, status = 409): never { throw new AuthError(message, status); }
export async function resolveCanvasReferenceInputs(user: SessionUser, body: Record<string, unknown>, db: Prisma.TransactionClient = prisma,
  options: { target?: 'image' | 'video'; imageLimit?: number; scope?: CanvasWorkspaceScope; validateLimits?: boolean } = {}) {
  try {
    const submitted = normalizeCanvasReferences(body.canvas_references);
    const context = body.context && typeof body.context === 'object' ? body.context as Record<string, unknown> : body;
    if (!submitted && !body.canvas_document_id && !context.documentId) return null;
    const actor = await db.user.findUnique({ where: { id: user.id }, select: { status: true, role: true, account_type: true, expires_at: true } });
    if (!actor || actor.status !== 'active' || actor.expires_at && actor.expires_at.getTime() <= Date.now()
      || actor.account_type !== user.account_type || actor.role !== user.role) fail('账号权限已变化或已过期，请刷新后核对原输入', 403);
    const scope = options.scope || await resolveCanvasWorkspaceScope(user, { projectId: String(body.project_id || context.projectId || ''),
      documentId: String(body.canvas_document_id || context.documentId || ''), cardId: (body.video_card_id || context.cardId || null) as string | null,
      nodeId: String(body.canvas_node_id || context.nodeId || ''), purpose: 'generate' }, db);
    if (submitted) requireCanvasReferencesCapability({ canvasReferenceVersion: 1 }, body.required_capabilities);
    requireCanvasReferencesCapability(scope.snapshot, body.required_capabilities);
    if (!submitted && !canvasReferencesRequired(scope.snapshot)) return null;
    const nodeId = String(body.canvas_node_id || context.nodeId || '');
    const target = scope.snapshot.canvas.nodes.find((node: { id: string }) => node.id === nodeId);
    if (!target || !['image', 'video'].includes(target.type) || options.target && target.type !== options.target) fail('参考目标类型已变化');
    if (!submitted) {
      if (target.data?.canvas_references !== undefined) fail('此节点使用新版参考素材，请刷新后提交；原输入保留', 426);
      return null;
    }
    const imageIds: string[] = [], imageUrls: string[] = [], orderedImageUrls: string[] = [], videoUrls: string[] = [], audioUrls: string[] = [];
    let firstFrameUrl: string | undefined, lastFrameUrl: string | undefined;
    const items: CanvasReferences['items'] = [];
    const sourceLocations = new Set<string>();
    for (const item of submitted.items) {
      let asset = item.assetId ? await db.asset.findUnique({ where: { id: item.assetId } }) : null;
      if (item.assetId && !asset) fail('指定的原素材不存在，未替换为任务成品', 403);
      if (item.referenceImageId) {
        const reference = await assertCanUseReferenceImage(user, item.referenceImageId, db);
        if (!reference.asset || !reference.asset_id || item.assetId && reference.asset_id !== item.assetId) fail('参考编号与原素材不一致', 403);
        asset = reference.asset;
      }
      if (asset && (asset.status !== 'active' || asset.type !== item.kind || !await canReadStudioAsset(user, asset, db)
        || !item.referenceImageId && asset.owner_id !== user.id && !(user.role === 'admin' && asset.type === 'image'))) fail('素材已失效或无权用于生成', 403);
      let url = asset?.original_url, version = asset ? canvasAssetSourceVersion(asset) : '';
      if (item.taskId) {
        const task = await db.videoTask.findFirst({ where: { id: item.taskId, local_status: 'succeeded',
          retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] },
          OR: [{ owner_user_id: user.id }, { owner_user_id: null, user_id: user.id }], AND: [ordinaryVideoTaskWhere()] } });
        if (!task || item.kind !== 'video') fail('原任务不是可用的本人视频成品', 403);
        await assertCanViewTask(user, task, db);
        if (asset && location(asset.original_url) !== location(task.public_video_url || '')) fail('素材与任务成品身份不一致', 403);
        if (!asset) {
          if (!task.public_video_url) fail('原视频尚未准备为可用素材，请通过现有素材选择添加，未重新生成');
          url = task.public_video_url;
          version = digest([task.id, task.public_video_storage_key, task.public_video_file_size, task.public_video_cached_at, task.public_video_url]);
        }
      }
      if (!url || !version) fail('原素材不存在，未使用预览地址生成', 403);
      const sourceLocation = JSON.stringify([item.kind, item.role, location(url)]);
      if (sourceLocations.has(sourceLocation)) fail('多个素材编号指向同一原件位置，请核对原参考，未删减或替换');
      sourceLocations.add(sourceLocation);
      if (item.sourceVersion && item.sourceVersion !== version) fail('参考素材版本已变化，请保留输入重新核对');
      if (item.sourceNodeId) {
        const source = scope.snapshot.canvas.nodes.find((node: { id: string }) => node.id === item.sourceNodeId);
        const data = source?.data || {}, selected = data.selectedVideoResult || data.generationResult || {};
        if (!source || source.type !== item.kind || !scope.snapshot.canvas.connections.some((edge: { from: string; to: string }) => edge.from === item.sourceNodeId && edge.to === nodeId) || ![
          item.assetId && [data.assetId, data.asset_id, selected.assetId].includes(item.assetId),
          item.referenceImageId && [data.referenceImageId, data.reference_image_id, selected.referenceImageId].includes(item.referenceImageId),
          item.taskId && [data.taskId, selected.taskId].includes(item.taskId),
        ].some(Boolean)) fail('参考节点与已保存原素材不一致');
      }
      if (items.some(previous => previous.kind === item.kind && previous.role === item.role
        && (asset && previous.assetId === asset.id || item.taskId && previous.taskId === item.taskId))) fail('同一原素材重复，请核对参考清单', 400);
      items.push({ ...item, ...(asset ? { assetId: asset.id } : {}), sourceVersion: version });
      if (item.kind === 'image') { orderedImageUrls.push(url); if (item.referenceImageId) imageIds.push(item.referenceImageId); else imageUrls.push(url); }
      if (item.role === 'first') { if (firstFrameUrl) fail('首帧只能指定一张图片', 400); firstFrameUrl = url; }
      else if (item.role === 'last') { if (lastFrameUrl) fail('尾帧只能指定一张图片', 400); lastFrameUrl = url; }
      else if (item.kind === 'video') videoUrls.push(url);
      else if (item.kind === 'audio') audioUrls.push(url);
    }
    const imageCount = items.filter(item => item.kind === 'image').length;
    const capability = target.type === 'image' ? { imageLimit: options.imageLimit ?? 10, videoLimit: 0, audioLimit: 0, audioOnly: false }
      : body.provider === 'h3' ? { imageLimit: 2, videoLimit: 0, audioLimit: 0, audioOnly: false }
      : seedanceReferenceMediaCapabilities(body.provider === 'volcengine_ip' ? String(body.model || '') : null);
    if (options.validateLimits !== false && (imageCount > capability.imageLimit || videoUrls.length > capability.videoLimit || audioUrls.length > capability.audioLimit)) fail('参考素材数量超过当前模型上限，原输入未删减', 400);
    if (target.type === 'image' && items.some(item => item.kind !== 'image')) fail('图片节点只接受图片参考', 400);
    if (options.validateLimits !== false && target.type === 'image' && items.some(item => item.role !== 'reference')) fail('图片生成参考不能指定视频首尾帧', 400);
    if (options.validateLimits !== false && target.type === 'video' && (body.generation_mode === 'first_last_frame'
      ? items.length > 2 || !items.some(item => item.role === 'first') || items.some(item => item.role === 'reference')
      : items.some(item => item.role !== 'reference'))) fail('参考首尾角色与当前视频模式不一致，未生成', 400);
    if (options.validateLimits !== false && target.type === 'video' && body.generation_mode !== undefined && body.generation_mode !== 'all_in_one_reference'
      && (videoUrls.length || audioUrls.length)) fail('当前视频模式不支持音视频参考，未删减素材', 400);
    if (options.validateLimits !== false && audioUrls.length && !capability.audioOnly && !imageCount && !videoUrls.length) fail('音频参考还需要图片或视频参考', 400);
    if (options.validateLimits !== false && body.promptMentions != null && imageUrls.length) fail('带正文绑定的图片请先通过现有素材选择关联为参考图，未忽略任何输入', 400);
    const sameList = (key: string, actual: string[]) => {
      if (body[key] === undefined) return;
      const expected = body[key];
      if (!Array.isArray(expected) || expected.some(value => typeof value !== 'string')
        || JSON.stringify(expected.map(value => location(value as string))) !== JSON.stringify(actual.map(location))) fail('新旧参考清单不一致，原输入保留');
    };
    sameList('reference_image_ids', imageIds); sameList('referenceImageIds', imageIds);
    sameList('reference_image_urls', imageUrls); sameList('referenceImageUrls', imageUrls);
    sameList('reference_video_urls', videoUrls); sameList('referenceVideoUrls', videoUrls);
    sameList('reference_audio_urls', audioUrls); sameList('referenceAudioUrls', audioUrls);
    for (const [key, actual] of [['first_frame_url', firstFrameUrl], ['last_frame_url', lastFrameUrl]] as const) {
      if (body[key] !== undefined && location(String(body[key] || '')) !== location(actual || '')) fail('新旧首尾帧不一致，未生成');
    }
    return { references: { version: 1 as const, items }, referenceImageIds: imageIds, referenceImageUrls: imageUrls, orderedImageUrls,
      referenceVideoUrls: videoUrls, referenceAudioUrls: audioUrls, firstFrameUrl, lastFrameUrl, scope };
  } catch (error) {
    if (error instanceof CanvasReferenceError) throw new AuthError(error.message, error.status);
    throw error;
  }
}
export function applyCanvasReferenceInputs(body: Record<string, unknown>, resolved: Awaited<ReturnType<typeof resolveCanvasReferenceInputs>>) {
  if (!resolved) return body;
  return { ...body, canvas_references: resolved.references, reference_image_ids: resolved.referenceImageIds,
    reference_image_urls: resolved.referenceImageUrls, reference_video_urls: resolved.referenceVideoUrls,
    reference_audio_urls: resolved.referenceAudioUrls, first_frame_url: resolved.firstFrameUrl, last_frame_url: resolved.lastFrameUrl };
}
