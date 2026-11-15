import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { assertStudioActor, StudioSharingError } from './shared-contract';
import { canManageStudioPreset, isExternalImageStudioActor, type ImageStudioIdentity } from './access';
import { studioPresetArchived } from './preset-lifecycle';
import { readStudioWorkspaceDeletion } from './workspace-deletion';
import { bumpCatalogRevision } from './catalog-revision';
import { parseTemplateTags, TEMPLATE_TAG_PREFIX, type TemplateTagMetadata } from './template-tags';

export async function readTemplateTagCatalog(tx: Prisma.TransactionClient) {
  const rows = await tx.platformSetting.findMany({ where: { key: { startsWith: TEMPLATE_TAG_PREFIX } }, select: { key: true, value_json: true } });
  return new Map(rows.map(row => {
    const value = JSON.parse(row.value_json) as TemplateTagMetadata;
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new StudioSharingError('模板标签暂不可读，请重新读取', 503);
    return [row.key.slice(TEMPLATE_TAG_PREFIX.length), { ...value, tags: parseTemplateTags(value.tags) }];
  }));
}

export async function saveTemplateTags(user: ImageStudioIdentity, raw: unknown) {
  const body = raw as { contentKey?: unknown; requestId?: unknown; expectedRevision?: unknown; tags?: unknown };
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.contentKey !== 'string' || !/^image_(template|module):[a-zA-Z0-9][a-zA-Z0-9:_-]{0,180}$/.test(body.contentKey)
    || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{16,160}$/.test(body.requestId)
    || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) throw new StudioSharingError('模板标签保存内容无效', 400);
  let tags: string[];
  try { tags = parseTemplateTags(body.tags); }
  catch (error) { throw new StudioSharingError((error as Error).message, 400); }
  const contentKey = body.contentKey, requestId = body.requestId;
  const fingerprint = createHash('sha256').update(JSON.stringify([contentKey, body.expectedRevision, tags])).digest('hex');
  return prisma.$transaction(async tx => {
    const actor = await assertStudioActor(user.id, tx);
    if (isExternalImageStudioActor(actor)) throw new StudioSharingError('外部账号不能修改模板标签', 403);
    if (contentKey.startsWith('image_template:')) {
      const id = contentKey.slice('image_template:'.length);
      const source = await tx.imageStudioPreset.findUnique({ where: { id }, select: { id: true, owner_id: true, scope: true, is_shared: true } });
      if (!source || !canManageStudioPreset(actor, source)) throw new StudioSharingError('只能修改自己原模板的标签', 403);
      if (await studioPresetArchived(id, tx)) throw new StudioSharingError('模板已删除，请重新读取', 409);
    } else {
      const id = contentKey.slice('image_module:'.length);
      const workspace = await tx.imageStudioModule.findUnique({ where: { id }, select: { owner_id: true } });
      if (workspace ? workspace.owner_id !== actor.id : id !== `default-${actor.id}`) throw new StudioSharingError('只能修改自己的模板标签', 403);
      if (await readStudioWorkspaceDeletion(actor.id, id, tx)) throw new StudioSharingError('模板已删除，请重新读取', 409);
    }
    const receiptKey = `studio_template_tag_request_v1:${actor.id}:${requestId}`;
    const previous = await tx.platformSetting.findUnique({ where: { key: receiptKey }, select: { value_json: true } });
    if (previous) {
      const receipt = JSON.parse(previous.value_json);
      if (receipt.fingerprint !== fingerprint) throw new StudioSharingError('同一保存编号不能提交不同标签', 409);
      return receipt.result as { contentKey: string; requestId: string; revision: number; tags: string[] };
    }
    const key = TEMPLATE_TAG_PREFIX + contentKey;
    const stored = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    const current: TemplateTagMetadata = stored ? JSON.parse(stored.value_json) : { version: 1, revision: 0, tags: [] };
    if (current.revision !== body.expectedRevision) throw new StudioSharingError('标签已在其他页面修改，请重新读取；当前输入仍保留', 409);
    const next: TemplateTagMetadata = { version: 1, revision: current.revision + 1, tags };
    const data = { value_json: JSON.stringify(next), updated_by: actor.id };
    await tx.platformSetting.upsert({ where: { key }, create: { key, ...data }, update: data });
    const result = { contentKey, requestId, revision: next.revision, tags };
    await tx.platformSetting.create({ data: { key: receiptKey, updated_by: actor.id,
      value_json: JSON.stringify({ version: 1, action: 'set-template-tags', actorId: actor.id, fingerprint, before: current, result }) } });
    await bumpCatalogRevision(tx, ['templates']);
    return result;
  });
}
