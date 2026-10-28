import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { createInAppNotification } from '@/lib/notifications';
import { assertMultiviewShareAccess, stageMultiviewSource, multiviewSourceRoot } from './multiview-source.server';
import { multiviewSourceFile } from './multiview';
import { currentMultiviewActor, multiviewWorkActor, assertMultiviewWorkSource, getMultiviewWork,
  multiviewWorkDirectory, multiviewWorkRecipeHash, MultiviewWorkError } from './multiview-works';
import { MULTIVIEW_SAVE_PROTOCOL, isMultiviewWorkId, isMultiviewWorkFileRole, parseMultiviewWorkManifest,
  parseMultiviewWorkRecipe } from './multiview-work-contract';
import type { MultiviewInfo } from './multiview-contract';

type Db = Prisma.TransactionClient;
type Input = Record<string, unknown>;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const invalid = (message: string) => new MultiviewWorkError(message, 400, 'SHARE_INVALID', { notCommitted: true });
const operationId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
async function shareableWork(user: SessionUser, workId: string, revision: number, db: Db = prisma) {
  await currentMultiviewActor(user, db);
  const work = await db.multiviewWork.findUnique({ where: { id: workId } });
  if (!work || work.owner_id !== user.id || work.removed_at) throw new AuthError('方案不存在或不可分享。', 404);
  if (work.save_state === 'intent' || work.ready_revision !== revision || work.draft_revision !== revision || !work.ready_recipe_json
    || !work.ready_manifest_json || !work.source_version || work.recipe_json !== work.ready_recipe_json) {
    throw new MultiviewWorkError('请先保存当前方案，等成品就绪后再分享。', 409, 'SHARE_NOT_READY', { notCommitted: true });
  }
  if (work.source_id) {
    const source = await db.multiviewSource.findUnique({ where: { id: work.source_id } });
    if (!source || source.owner_id !== user.id || !source.can_reshare) throw new AuthError('此独立副本没有再次转授源视频的权限。', 403);
  } else {
    const task = await assertMultiviewWorkSource(user, work.source_task_id, db);
    if ((task.owner_user_id || task.user_id) !== user.id) throw new AuthError('能查看来源视频不代表可以转授；仅来源所有者可分享。', 403);
    if (task.project_id) {
      const project = await db.project.findUnique({ where: { id: task.project_id } });
      if (!project || project.owner_user_id !== user.id) throw new AuthError('此项目来源没有转授授权。', 403);
    }
  }
  const info = JSON.parse(work.source_info_json || 'null') as MultiviewInfo | null;
  const recipe = info && parseMultiviewWorkRecipe(work.ready_recipe_json, info);
  const manifest = recipe && parseMultiviewWorkManifest(work.ready_manifest_json, recipe, revision, multiviewWorkRecipeHash(recipe));
  if (recipe?.schema === 3) throw new MultiviewWorkError('参考拼图仅本人可用，原选帧方案分享不受影响。', 409, 'REFERENCE_SHARE_UNSUPPORTED', { notCommitted: true });
  if (!info || !recipe || !manifest) throw invalid('成品记录尚未完整，未建立分享。');
  return { work, info, recipe, manifest };
}
async function recipients(user: SessionUser, input: unknown, db: Db = prisma) {
  if (!Array.isArray(input) || !input.length || input.length > 50 || input.some(id => !isMultiviewWorkId(id) || id === user.id)
    || new Set(input).size !== input.length) throw invalid('请选择有效同事后继续。');
  const ids = (input as string[]).slice().sort();
  for (const id of ids) await multiviewWorkActor(id, db);
  return ids;
}

export async function readMultiviewShareOperation(user: SessionUser, mutationId: string) {
  await currentMultiviewActor(user);
  if (!operationId(mutationId)) throw invalid('原操作编号无效。');
  const row = await prisma.multiviewShareMutation.findUnique({ where: { actor_id_mutation_id: { actor_id: user.id, mutation_id: mutationId } } });
  if (!row) return { state: 'not_found', mutationId };
  return ['committed', 'rejected'].includes(row.state) && row.receipt_json ? JSON.parse(row.receipt_json)
    : { state: row.state, mutationId, canResume: !row.lease_until || row.lease_until.getTime() <= Date.now() };
}

export async function resumeMultiviewShareOperation(user: SessionUser, mutationId: string) {
  await currentMultiviewActor(user);
  if (!operationId(mutationId)) throw invalid('原操作编号无效。');
  const row = await prisma.multiviewShareMutation.findUnique({ where: { actor_id_mutation_id: { actor_id: user.id, mutation_id: mutationId } } });
  if (!row) return { state: 'not_found', mutationId };
  return mutateMultiviewShare(user, JSON.parse(row.request_json));
}

export async function mutateMultiviewShare(user: SessionUser, input: Input) {
  await currentMultiviewActor(user);
  if (!operationId(input.mutationId)) throw invalid('原操作编号无效。');
  const mutationId = input.mutationId, requestHash = digest(stable(input));
  const key = { actor_id: user.id, mutation_id: mutationId };
  const prior = await prisma.multiviewShareMutation.findUnique({ where: { actor_id_mutation_id: key } });
  if (prior) {
    if (prior.request_hash !== requestHash) throw new MultiviewWorkError('原操作编号对应另一份内容，请查询原操作。', 409, 'SHARE_OPERATION_CONFLICT');
    if (['committed', 'rejected'].includes(prior.state)) return JSON.parse(prior.receipt_json!);
    if (prior.lease_until && prior.lease_until.getTime() > Date.now()) return { state: 'preparing', mutationId };
    if (prior.attempts >= 3) {
      // An explicit resume can close an exhausted original operation, never
      // copy again. Fence every late attempt before returning notCommitted.
      await prisma.$transaction(async db => {
        const current = await db.multiviewShareMutation.findUnique({ where: { actor_id_mutation_id: key } });
        if (!current || ['committed', 'rejected'].includes(current.state) || current.lease_until && current.lease_until.getTime() > Date.now()) return;
        await db.multiviewShareMutation.updateMany({ where: { id: current.id, attempts: current.attempts, state: current.state },
          data: { state: 'rejected', lease_until: null, receipt_json: JSON.stringify({ state: 'rejected', mutationId, notCommitted: true,
            error: '本次源文件保存未完成，已停止处理；原方案保留。' }) } });
      });
      return readMultiviewShareOperation(user, mutationId);
    }
  }
  const action = String(input.action);
  let preparedWork: Awaited<ReturnType<typeof shareableWork>> | null = null;
  let targets: string[] = [];
  try {
  if (process.env.MULTIVIEW_FLOW_READ_ONLY === '1' && action !== 'revoke') throw new MultiviewWorkError('方案当前仅可读取，暂不建立新的分享或副本。', 409, 'WORK_READ_ONLY');
  if (input.protocol !== MULTIVIEW_SAVE_PROTOCOL || !['copy', 'send', 'branch', 'revoke'].includes(action)) throw invalid('请刷新页面后再操作，原回执仍可查询。');
  if (Object.keys(input).some(key => !['protocol', 'mutationId', 'action', 'workId', 'revision', 'recipients', 'shareId', 'recipientId', 'title', 'recipe'].includes(key))) throw invalid('分享内容无效。');
  if (action === 'copy' || action === 'send') {
    if (!isMultiviewWorkId(input.workId) || !Number.isSafeInteger(input.revision)) throw invalid('方案版本无效。');
    preparedWork = await shareableWork(user, input.workId, Number(input.revision));
    targets = await recipients(user, input.recipients);
  } else if (!isMultiviewWorkId(input.shareId)) throw invalid('分享编号无效。');
  if (action === 'branch') await assertMultiviewShareAccess(user, String(input.shareId));
  } catch (error) {
    if (!(error instanceof AuthError || error instanceof MultiviewWorkError) || error.status >= 500) throw error;
    const receipt = { state: 'rejected', mutationId, notCommitted: true, error: error.message };
    await prisma.$transaction(async db => {
      const old = await db.multiviewShareMutation.findUnique({ where: { actor_id_mutation_id: key } });
      if (old) {
        if (old.request_hash !== requestHash || ['committed', 'rejected'].includes(old.state) || old.lease_until && old.lease_until.getTime() > Date.now()) return;
        await db.multiviewShareMutation.update({ where: { id: old.id }, data: { state: 'rejected', receipt_json: JSON.stringify(receipt), lease_until: null } });
      } else await db.multiviewShareMutation.create({ data: { id: randomUUID(), ...key, request_hash: requestHash, request_json: stable(input), action,
        state: 'rejected', attempts: 0, receipt_json: JSON.stringify(receipt) } });
    });
    return readMultiviewShareOperation(user, mutationId);
  }
  const opId = prior?.id || randomUUID();
  const claimed = await prisma.$transaction(async db => {
    const old = await db.multiviewShareMutation.findUnique({ where: { actor_id_mutation_id: key } });
    if (old && (old.request_hash !== requestHash || old.attempts >= 3 || ['committed', 'rejected'].includes(old.state) || old.lease_until && old.lease_until.getTime() > Date.now())) return 0;
    if (old) {
      const changed = await db.multiviewShareMutation.updateMany({ where: { id: old.id, attempts: old.attempts },
        data: { attempts: { increment: 1 }, state: 'preparing', lease_until: new Date(Date.now() + 180000) } });
      return changed.count === 1 ? old.attempts + 1 : 0;
    }
    await db.multiviewShareMutation.create({ data: { id: opId, ...key, request_hash: requestHash, request_json: stable(input),
      action, state: 'preparing', attempts: 1, lease_until: new Date(Date.now() + 180000) } });
    return 1;
  });
  if (!claimed) return readMultiviewShareOperation(user, mutationId);
  let staged: Awaited<ReturnType<typeof stageMultiviewSource>> | null = null;
  try {
    if (preparedWork) {
      const source = await multiviewSourceFile(user, preparedWork.work.source_task_id, preparedWork.info.sourceVersion,
        preparedWork.work.source_id ? { kind: 'work', id: preparedWork.work.id } : undefined);
      staged = await stageMultiviewSource({ ownerId: user.id, operationId: `${opId}_${claimed}`, taskId: preparedWork.work.source_task_id,
        info: source.info, file: source.file, canReshare: true });
    } else if (action === 'branch') {
      const allowed = await assertMultiviewShareAccess(user, String(input.shareId));
      const source = await multiviewSourceFile(user, allowed.share.source_task_id, allowed.share.source_version, { kind: 'share', id: allowed.share.id });
      staged = await stageMultiviewSource({ ownerId: user.id, operationId: `${opId}_${claimed}`, taskId: allowed.share.source_task_id,
        info: source.info, file: source.file, canReshare: false });
    }
    return await prisma.$transaction(async db => {
      await currentMultiviewActor(user, db);
      const operation = await db.multiviewShareMutation.findUniqueOrThrow({ where: { actor_id_mutation_id: key } });
      if (operation.state === 'committed') return JSON.parse(operation.receipt_json!);
      if (operation.attempts !== claimed || operation.state !== 'preparing' || !operation.lease_until || operation.lease_until.getTime() <= Date.now()) throw new Error('copy_lease_expired');
      let receipt: Record<string, unknown>;
      if (preparedWork && staged) {
        const current = await shareableWork(user, preparedWork.work.id, Number(input.revision), db);
        if (current.work.revision !== preparedWork.work.revision || current.work.ready_manifest_json !== preparedWork.work.ready_manifest_json) throw new MultiviewWorkError('方案已变化，请重新打开分享。', 409, 'SHARE_VERSION_CHANGED');
        await recipients(user, targets, db);
        await db.multiviewSource.create({ data: staged });
        const shareId = randomUUID();
        await db.multiviewShare.create({ data: { id: shareId, owner_id: user.id, work_id: current.work.id,
          revision: Number(input.revision), source_task_id: current.work.source_task_id, source_id: staged.id,
          source_version: current.info.sourceVersion, title: current.work.title, recipe_json: current.work.ready_recipe_json!,
          info_json: JSON.stringify(current.info), manifest_json: current.work.ready_manifest_json! } });
        for (const id of targets) {
          await db.multiviewShareRecipient.create({ data: { id: randomUUID(), share_id: shareId, user_id: id, generation: randomUUID() } });
          if (action === 'send') await createInAppNotification(db, { targetUserId: id, actorUserId: user.id,
            type: 'multiview_share', title: `${user.name || '同事'}分享了3D多视图方案`, body: current.work.title, metadata: { shareId } });
        }
        receipt = { state: 'committed', mutationId, action, shareId, href: `/multiview?shareId=${encodeURIComponent(shareId)}`, recipients: targets.length };
      } else if (action === 'branch' && staged) {
        const { share } = await assertMultiviewShareAccess(user, String(input.shareId), db);
        const info = JSON.parse(share.info_json) as MultiviewInfo;
        const recipe = parseMultiviewWorkRecipe(input.recipe, info);
        if (!recipe || recipe.schema !== 2 || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120) throw invalid('方案名称或选帧设置无效。');
        await db.multiviewSource.create({ data: staged });
        const workId = `mvw_${digest(`${user.id}:${mutationId}`).slice(0, 48)}`;
        await db.multiviewWork.create({ data: { id: workId, owner_id: user.id, source_task_id: share.source_task_id,
          source_id: staged.id, schema_version: 2, save_state: 'saved', branch_key: mutationId,
          title: input.title, source_version: share.source_version, source_info_json: share.info_json,
          recipe_json: JSON.stringify(recipe), recipe_hash: multiviewWorkRecipeHash(recipe), draft_revision: 1, status: 'queued' } });
        const workReceipt = { state: 'committed', mutationId, action: 'create', workId, revision: 1, draftRevision: 1 };
        await db.multiviewWorkMutation.create({ data: { actor_id: user.id, mutation_id: mutationId, work_id: workId,
          request_hash: requestHash, action: 'create', receipt_json: JSON.stringify(workReceipt) } });
        receipt = { state: 'committed', mutationId, action, workId };
      } else {
        const share = await db.multiviewShare.findUnique({ where: { id: String(input.shareId) } });
        if (!share || share.owner_id !== user.id) throw new AuthError('无权管理此分享。', 403);
        if (input.recipientId !== undefined) {
          if (!isMultiviewWorkId(input.recipientId)) throw invalid('同事编号无效。');
          await db.multiviewShareRecipient.updateMany({ where: { share_id: share.id, user_id: input.recipientId, revoked_at: null }, data: { revoked_at: new Date() } });
        } else await db.multiviewShare.update({ where: { id: share.id }, data: { revoked_at: new Date() } });
        receipt = { state: 'committed', mutationId, action, shareId: share.id };
      }
      await db.multiviewShareMutation.update({ where: { id: operation.id }, data: { state: 'committed', receipt_json: JSON.stringify(receipt), lease_until: null, staging_path: null } });
      return receipt;
    }, { timeout: 15000 });
  } catch (error) {
    const receipt = await prisma.$transaction(async db => {
      const actual = await db.multiviewShareMutation.findUnique({ where: { actor_id_mutation_id: key } });
      if (actual && ['committed', 'rejected'].includes(actual.state)) return JSON.parse(actual.receipt_json!);
      const terminal = claimed >= 3 || (error instanceof AuthError || error instanceof MultiviewWorkError) && error.status < 500;
      const rejected = { state: 'rejected', mutationId, notCommitted: true,
        error: error instanceof AuthError || error instanceof MultiviewWorkError ? error.message : '本次保存未完成，已停止处理；原方案保留。' };
      const changed = await db.multiviewShareMutation.updateMany({ where: { id: opId, attempts: claimed, state: 'preparing' },
        data: { state: terminal ? 'rejected' : 'failed', lease_until: null, ...(terminal ? { receipt_json: JSON.stringify(rejected) } : {}) } });
      if (changed.count === 1 && terminal) return rejected;
      return null;
    });
    if (receipt?.state === 'committed') return receipt;
    if (staged && !await prisma.multiviewSource.findUnique({ where: { id: staged.id } })) await rm(path.join(await multiviewSourceRoot(), staged.file_path), { force: true });
    if (receipt) return receipt;
    throw error;
  }
}

export async function readMultiviewShare(user: SessionUser, shareId: string) {
  const { share, generation } = await assertMultiviewShareAccess(user, shareId);
  const info = JSON.parse(share.info_json) as MultiviewInfo;
  const recipe = parseMultiviewWorkRecipe(share.recipe_json, info);
  const manifest = recipe && parseMultiviewWorkManifest(share.manifest_json, recipe, share.revision, multiviewWorkRecipeHash(recipe));
  if (!recipe || !manifest) throw invalid('分享成品记录不完整。');
  return { id: share.id, title: share.title, revision: share.revision, sourceTaskId: share.source_task_id,
    sourceVersion: share.source_version, recipe, info, generation,
    files: manifest.files.map(file => ({ role: file.role, bytes: file.bytes, mime: file.mime,
      url: `/api/video/multiview/shares/${encodeURIComponent(share.id)}/files/${encodeURIComponent(file.role)}` })) };
}

export async function readMultiviewShareFile(user: SessionUser, shareId: string, role: string) {
  if (!isMultiviewWorkFileRole(role)) throw invalid('成品文件无效。');
  const { share } = await assertMultiviewShareAccess(user, shareId);
  const info = JSON.parse(share.info_json) as MultiviewInfo;
  const recipe = parseMultiviewWorkRecipe(share.recipe_json, info);
  const manifest = recipe && parseMultiviewWorkManifest(share.manifest_json, recipe, share.revision, multiviewWorkRecipeHash(recipe));
  const entry = manifest?.files.find(file => file.role === role);
  if (!entry) throw invalid('成品文件不存在。');
  const file = path.join(await multiviewWorkDirectory(share.owner_id, share.work_id, share.revision), entry.file);
  if (await realpath(file) !== file) throw invalid('成品路径不可读取。');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== entry.bytes || metadata.size > 512 * 1024 * 1024) throw invalid('成品文件不完整。');
    const bytes = await handle.readFile();
    if (digest(bytes) !== entry.sha256) throw invalid('成品文件不完整。');
    await assertMultiviewShareAccess(user, shareId);
    return { bytes, mime: entry.mime };
  } finally { await handle.close(); }
}

export async function multiviewShareManagement(user: SessionUser, workId: string, after = '') {
  await getMultiviewWork(user, workId);
  if (after && !isMultiviewWorkId(after)) throw invalid('分享分页无效。');
  const rows = await prisma.multiviewShare.findMany({ where: { work_id: workId, owner_id: user.id, ...(after ? { id: { lt: after } } : {}) }, orderBy: { id: 'desc' }, take: 25,
    select: { id: true, revision: true, revoked_at: true, recipients: { select: { user_id: true, revoked_at: true } } } });
  const users = await prisma.user.findMany({ where: { id: { in: rows.flatMap(row => row.recipients.map(person => person.user_id)) } }, select: { id: true, name: true } });
  return { shares: rows.slice(0, 24).map(row => ({ ...row, recipients: row.recipients.map(person => ({ ...person, name: users.find(user => user.id === person.user_id)?.name || '同事' })) })),
    next: rows.length > 24 ? rows[23].id : null };
}
