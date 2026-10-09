import type { SessionUser } from '@/lib/auth/session';
import { validateAssets } from '@/lib/canvas-documents';
import { assertCanUseReferenceImage, canUseDirectAsset } from '@/lib/reference-albums/permissions';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { videoPlayableAvailableForTask } from '@/lib/video/delivery-status';
import { prisma } from '@/lib/prisma';
import { ownedRun, type RoleDb } from './permissions';
import { digest, identifier, integer, record, RoleError, text, type JsonRecord } from './types';

export function authoredCanvasText(data: JsonRecord, max = 100000) {
  const value = data.authoredText ?? data.generatedText ?? data.prompt ?? '';
  if (typeof value !== 'string' || value.length > max) throw new RoleError('画布正文无效或超出当前输入范围');
  return value;
}

// Persist identities and a source fingerprint, never a caller-supplied media URL.
export async function originalIdentity(db: RoleDb, user: SessionUser, ref: JsonRecord) {
  if (ref.sourceKind === 'canvas_text') {
    const content = authoredCanvasText({ authoredText: ref.content });
    return { snapshot: { sourceKind: 'canvas_text', nodeId: identifier(ref.nodeId), type: 'file', title: text(ref.title, 120),
      content, sourceDigest: digest({ nodeId: ref.nodeId, content }) }, url: '', mimeType: 'text/plain', internalSource: false };
  }
  const assetId = ref.assetId || ref.asset_id, referenceId = ref.referenceImageId || ref.reference_image_id;
  const taskId = ref.taskId || ref.task_id;
  if (!assetId && !referenceId && !taskId) throw new RoleError('素材尚无合法持久原件', 409, 'material_not_saved');
  await validateAssets(db, user, { canvas: { nodes: [{ id: 'role-original', type: 'image', x: 0, y: 0,
    data: { ...(assetId ? { assetId: identifier(assetId) } : {}), ...(referenceId ? { referenceImageId: identifier(referenceId) } : {}) } }], connections: [] } });
  if (referenceId) {
    const image = await assertCanUseReferenceImage(user, identifier(referenceId));
    if (image.asset && image.asset.status !== 'active') throw new RoleError('原件已不可用', 403, 'material_unavailable');
    const source = { referenceImageId: image.id, ...(image.asset_id ? { assetId: image.asset_id } : {}),
      type: image.asset?.type || 'image', title: image.asset?.file_name || '参考原件',
      sourceDigest: digest({ id: image.id, assetId: image.asset_id, url: image.url, hash: image.asset?.hash,
        original: image.asset?.original_url, mime: image.asset?.mime_type, size: image.asset?.file_size }) };
    return { snapshot: source, url: `/api/reference-images/${image.id}/content?variant=original`, mimeType: image.asset?.mime_type || 'image/jpeg', internalSource: false };
  }
  if (assetId) {
    const asset = await db.asset.findUniqueOrThrow({ where: { id: identifier(assetId) } });
    if (!await canUseDirectAsset(user, asset.id)) throw new RoleError('原件当前不可使用', 403, 'material_unavailable');
    const source = { assetId: asset.id, type: asset.type, title: asset.file_name,
      sourceDigest: digest({ id: asset.id, original: asset.original_url, hash: asset.hash, mime: asset.mime_type, size: asset.file_size }) };
    return { snapshot: source, url: asset.original_url, mimeType: asset.mime_type || 'application/octet-stream', internalSource: true };
  }
  const task = await db.videoTask.findUnique({ where: { id: identifier(taskId) } });
  if (!task) throw new RoleError('请选择成果对应的已保存原件，不以任务缩略图替代', 409, 'material_not_saved');
  await assertCanViewTask(user, task);
  if (task.local_status !== 'succeeded' || !videoPlayableAvailableForTask(task)) throw new RoleError('视频原件尚不可用', 409, 'material_unavailable');
  return { snapshot: { taskId: task.id, type: 'video', title: '生成视频',
    sourceDigest: digest({ id: task.id, url: task.result_video_url, local: task.local_video_path }) },
    url: `/api/video/play/${task.id}`, mimeType: 'video/mp4', internalSource: false };
}

export async function submissionAttachments(db: RoleDb, user: SessionUser, documentJson: string, runId: string, raw: unknown) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new RoleError('交付原件最多20项');
  const nodes = JSON.parse(documentJson).canvas.nodes;
  const result = [];
  for (const selection of raw) {
    if (!record(selection)) throw new RoleError('原件选择无效');
    let ref: JsonRecord, retained: JsonRecord | null = null;
    if (selection.sourceDeliveryId) {
      const delivery = await db.canvasRoleDelivery.findUnique({ where: { id: identifier(selection.sourceDeliveryId) } });
      const sourceWork = delivery && await db.canvasRoleWork.findFirst({ where: { id: delivery.work_id, role_task_run_id: runId } });
      if (!sourceWork) throw new RoleError('原成果不属于本任务', 403, 'delivery_unavailable');
      const attachments = JSON.parse(delivery!.content_json).attachments || [];
      retained = attachments[integer(selection.index, 0, 19)];
      if (!record(retained)) throw new RoleError('原成果没有此原件', 404, 'material_unavailable');
      ref = retained;
    } else {
      const node = nodes.find((n: JsonRecord) => n.id === identifier(selection.nodeId));
      if (!node || !record(node.data) || node.type === 'role') throw new RoleError('原件节点已移除', 409, 'material_unavailable');
      ref = ['text', 'script'].includes(node.type)
        ? { sourceKind: 'canvas_text', nodeId: node.id, title: text(node.data.title, 120) || '文字成果.txt', content: authoredCanvasText(node.data) }
        : node.data;
    }
    const resolved = await originalIdentity(db, user, ref);
    const expected = retained?.sourceDigest || selection.sourceDigest;
    if (expected && expected !== resolved.snapshot.sourceDigest) throw new RoleError('固定原件已变化，未采用新文件替代', 409, 'original_changed');
    result.push({ ...resolved.snapshot, ...(selection.nodeId ? { nodeId: identifier(selection.nodeId) } : {}),
      selection: selection.sourceDeliveryId ? { sourceDeliveryId: identifier(selection.sourceDeliveryId), index: integer(selection.index, 0, 19) }
        : { nodeId: identifier(selection.nodeId), sourceDigest: resolved.snapshot.sourceDigest } });
  }
  return result;
}

export async function deliveryAttachmentSource(user: SessionUser, deliveryId: string, index: number) {
  const delivery = await prisma.canvasRoleDelivery.findUnique({ where: { id: identifier(deliveryId) } });
  if (!delivery) throw new RoleError('成果不存在', 404, 'delivery_unavailable');
  const work = await prisma.canvasRoleWork.findUniqueOrThrow({ where: { id: delivery.work_id } });
  await ownedRun(prisma, user, work.role_task_run_id);
  const ref = JSON.parse(delivery.content_json).attachments?.[integer(index, 0, 19)];
  if (!record(ref)) throw new RoleError('成果原件不存在', 404, 'material_unavailable');
  const source = await originalIdentity(prisma, user, ref);
  if (source.snapshot.sourceDigest !== ref.sourceDigest) throw new RoleError('原件已变化，历史成果保留但不替换内容', 409, 'original_changed');
  return source;
}
export async function assertDeliveryOriginals(db: RoleDb, user: SessionUser, content: JsonRecord) {
  if (!Array.isArray(content.attachments)) return;
  for (const ref of content.attachments) {
    if (!record(ref)) throw new RoleError('成果原件引用无效', 409, 'material_unavailable');
    const source = await originalIdentity(db, user, ref);
    if (source.snapshot.sourceDigest !== ref.sourceDigest) throw new RoleError('固定成果原件已变，未采用新文件', 409, 'original_changed');
  }
}
