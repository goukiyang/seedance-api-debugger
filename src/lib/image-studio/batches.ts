import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { allocateTaskCredits } from '@/lib/credits/policy';
import { canUseCompanyTemplates, canViewStudioPreset } from './access';
import { getImageStudioSettings, IMAGE_STUDIO_SETTING_KEY, DEFAULT_STUDIO_PRICES } from './settings';
import { resolveStudioModuleGenerationConfig } from './modules';
import { submitStudioBatch, parseStudioRequest, StudioError } from './tasks';
import { STUDIO_BATCH_LIMITS, type StudioBatchView } from './batch-contract';
import { studioAssetUrl } from './media';
import { studioVisibleAssetWhere } from './protected-assets';
import { resolveStudioStyleReferences } from './style-groups';
import { historicalSkills } from './skills';
import type { StudioReferencePolicy } from './reference-policy';
import { imageBillingView } from './billing-contract';
import type { ImageBillingContract } from './billing-contract';
import { consumeBatchQuote } from './batch-billing-quote';
import { imageBillingReady } from './billing-readiness';
import { imageBillingScope } from './billing-scope';
import { getImageGenerationSettingsForModel } from '@/lib/integrations/image-generation';

const PREFIX = 'studio_batch_v1:';
const ITEM_PREFIX = 'studio_batch_item_v1:';
type BatchItem = { ordinal: number; sourceName: string; assetId?: string; taskId: string | null; attempt: number; prepared: boolean; cancelled: boolean };
type BatchRecord = { version: 1; id: string; ownerId: string; requestId: string; fingerprint: string; moduleId: string; moduleName: string; state: string; note: string; createdAt: string; total: number; budget: number; committedCredits: number; unitCredits: number; prepared: number; input: Record<string, unknown>; items: BatchItem[]; billingMode?: 'actual'; billingContracts?: ImageBillingContract[] };
const key = (owner: string, id: string) => `${PREFIX}${owner}:${id}`;
const itemKey = (id: string, ordinal: number) => `${ITEM_PREFIX}${id}:${ordinal}`;
const idFor = (owner: string, requestId: string) => createHash('sha256').update(`${owner}:${requestId}`).digest('hex');
const parse = (json: string) => JSON.parse(json) as BatchRecord;
const boundedBudget = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 10_000_000;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

async function readOwned(owner: string, id: unknown, tx: Pick<Prisma.TransactionClient, 'platformSetting'> = prisma) {
  if (!validId(id)) throw new StudioError('批次编号无效');
  const row = await tx.platformSetting.findUnique({ where: { key: key(owner, id) } });
  if (!row) throw new StudioError('批次不存在或无权访问', 404);
  const batch = parse(row.value_json);
  if (batch.ownerId !== owner || batch.id !== id) throw new StudioError('批次不存在或无权访问', 404);
  return { row, batch };
}
async function writeBatch(tx: Pick<Prisma.TransactionClient, 'platformSetting'>, row: { id: string; value_json: string }, batch: BatchRecord) {
  const changed = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: JSON.stringify(batch) } });
  if (!changed.count) throw new StudioError('批次已在其他页面更新，请重新读取', 409);
}

export async function createStudioBatch(ownerId: string, body: Record<string, unknown>) {
  const input = parseStudioRequest({ ...body, count: 1 });
  if (typeof body.moduleId !== 'string' || !boundedBudget(body.budget)) throw new StudioError('请选择模板并填写最高预算');
  const sources = body.sources;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > STUDIO_BATCH_LIMITS.images) throw new StudioError(`本批最多 ${STUDIO_BATCH_LIMITS.images} 张图片`);
  const items: BatchItem[] = sources.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new StudioError('素材清单无效');
    const value = source as Record<string, unknown>;
    if (typeof value.name !== 'string' || value.name.length > 160 || (value.assetId !== undefined && (typeof value.assetId !== 'string' || value.assetId.length > 100))) throw new StudioError('素材清单无效');
    return { ordinal: index + 1, sourceName: value.name.replace(/[\\/\x00-\x1f]/g, '_'), ...(value.assetId ? { assetId: value.assetId as string } : {}), taskId: null, attempt: 0, prepared: false, cancelled: false };
  });
  const id = idFor(ownerId, input.requestId);
  const shared = { ...input, moduleId: body.moduleId };
  const fingerprint = createHash('sha256').update(JSON.stringify({ shared, items, budget: body.budget })).digest('hex');
  let created = false;
  await prisma.$transaction(async tx => {
    const existing = await tx.platformSetting.findUnique({ where: { key: key(ownerId, id) } });
    if (existing) { if (parse(existing.value_json).fingerprint !== fingerprint) throw new StudioError('提交编号已用于其他批次', 409); return; }
    const active = await tx.platformSetting.count({ where: { key: { startsWith: `${PREFIX}${ownerId}:` }, OR: ['preparing', 'ready', 'paused', 'blocked'].map(state => ({ value_json: { contains: `"state":"${state}"` } })) } });
    if (active >= STUDIO_BATCH_LIMITS.activeBatches) throw new StudioError('最多保留 5 个未结束批次，请先处理原批次', 429);
    const workspace = await tx.imageStudioModule.findFirst({ where: { id: body.moduleId as string, owner_id: ownerId }, select: { name: true, model: true } });
    if (!workspace) throw new StudioError('模板不存在或无权使用', 404);
    const settings = await getImageStudioSettings();
    const billingQuote = body.batchQuoteId ? await consumeBatchQuote(tx, ownerId, body) : null;
    if (!billingQuote) {
      const model = input.model || resolveStudioModuleGenerationConfig(workspace, settings).model;
      const api = await getImageGenerationSettingsForModel(model, tx);
      if ((await imageBillingReady(imageBillingScope(api), model, tx)).ready) throw new StudioError('当前模型需要确认有效整批报价，尚未创建或派发生成', 409);
    }
    const unitCredits = billingQuote?.unitCredits ?? settings.prices[input.model || resolveStudioModuleGenerationConfig(workspace, settings).model];
    if (unitCredits == null || (billingQuote?.total ?? unitCredits * items.length) > Number(body.budget)) throw new StudioError('最高预算不足以覆盖本批预计点数');
    const assetIds = Array.from(new Set(items.flatMap(item => item.assetId ? [item.assetId] : [])));
    const assets = await tx.asset.findMany({ where: { id: { in: assetIds }, owner_id: ownerId, status: 'active', type: 'image' }, select: { id: true, file_size: true } });
    if (assets.length !== assetIds.length || assets.some(asset => !asset.file_size || asset.file_size > STUDIO_BATCH_LIMITS.fileBytes) || assets.reduce((sum, asset) => sum + (asset.file_size || 0), 0) > STUDIO_BATCH_LIMITS.totalBytes) throw new StudioError('素材不可用或超过本批大小上限');
    const batch: BatchRecord = { version: 1, id, ownerId, requestId: input.requestId, fingerprint, moduleId: body.moduleId as string, moduleName: workspace.name, state: 'preparing', note: '', createdAt: new Date().toISOString(), total: items.length, budget: Number(body.budget), committedCredits: 0, unitCredits, prepared: 0, input: shared, items,
      ...(billingQuote ? { billingMode: 'actual' as const, billingContracts: billingQuote.contracts } : {}) };
    await tx.platformSetting.create({ data: { key: key(ownerId, id), value_json: JSON.stringify(batch), updated_by: ownerId } });
    created = true;
  }, { timeout: 15000 });
  if (created) await prepareBatch(ownerId, id);
  return id;
}

async function prepareBatch(owner: string, id: string) {
  const initial = (await readOwned(owner, id)).batch;
  try {
    for (const item of initial.items) {
      if (item.prepared) continue;
      const policy = (initial.input.draft as { referencePolicy?: StudioReferencePolicy } | undefined)?.referencePolicy;
      const references = item.assetId ? [item.assetId, ...(initial.input.referenceIds as string[]).filter(ref => !policy?.primaryIds.includes(ref))] : initial.input.referenceIds;
      const draft = initial.input.draft as Record<string, unknown> | undefined;
      const itemInput = { ...initial.input, requestId: `${id.slice(0, 48)}-${item.ordinal}`, referenceIds: references,
        ...(item.assetId && draft && policy ? { draft: { ...draft, referencePolicy: { ...policy, primaryIds: [item.assetId] } } } : {}) };
      await submitStudioBatch(owner, itemInput, undefined, { save: async (tx, task) => {
        const { row, batch } = await readOwned(owner, id, tx);
        if (batch.state !== 'preparing') throw new StudioError('批次已停止准备');
        const current = batch.items[item.ordinal - 1];
        if (current.prepared) return;
        const actualContract = batch.billingContracts?.[item.ordinal - 1];
        if (batch.billingMode === 'actual') {
          const fixedContract = JSON.parse(String(task.billing_contract_json)) as ImageBillingContract;
          if (!actualContract || actualContract.specification !== fixedContract.specification || actualContract.scope !== fixedContract.scope)
            throw new StudioError('本批输入或通道与已确认报价不符，未派发生成');
          task.unit_credits = actualContract.authorizedCredits;
          task.billing_mode = 'actual'; task.billing_contract_json = JSON.stringify(actualContract);
          task.billing_deadline = new Date(actualContract.deadline!);
          task.snapshot_json = JSON.stringify({ ...JSON.parse(String(task.snapshot_json)), billingContract: actualContract, unitCredits: actualContract.authorizedCredits });
        } else if (task.unit_credits !== batch.unitCredits || Number(task.unit_credits) * batch.total > batch.budget) throw new StudioError('价格变化或预算不足，请重新核对后开始新批次');
        const first = await tx.platformSetting.findUnique({ where: { key: itemKey(id, 1) } });
        if (first) {
          const before = JSON.parse((JSON.parse(first.value_json) as Prisma.ImageStudioTaskUncheckedCreateInput).snapshot_json as string);
          const now = JSON.parse(task.snapshot_json as string);
          const skillInput = (snapshot: Record<string, unknown>) => Array.isArray(snapshot.skills) ? snapshot.skills.map(skill => ({ id: skill.id, prompt: skill.prompt, promptVersion: skill.promptVersion, ownerId: skill.ownerId })) : [];
          if (['globalContext', 'moduleContext', 'moduleRevision', 'settingsRevision', 'styleGroups', 'fixedReferenceImages'].some(field => JSON.stringify(before[field]) !== JSON.stringify(now[field]))
            || JSON.stringify(skillInput(before)) !== JSON.stringify(skillInput(now))) throw new StudioError('准备期间模板或价格发生变化，未开始生成，请重新核对');
        }
        task.id = `${id}-${item.ordinal}-a0`; task.batch_id = id; task.ordinal = item.ordinal;
        task.context += `\n\n本批条目 ${item.ordinal}/${batch.total}。严格保留原正文中的明确条件；仅对正文未指定且允许随机的细节作不同选择，不照抄本批其他条目、不改变演化档数或组合图排版。`;
        task.snapshot_json = JSON.stringify({ ...JSON.parse(task.snapshot_json as string), effectiveContext: task.context, batchId: id, requestId: batch.requestId, persistentBatchId: id, batchOrdinal: item.ordinal });
        await tx.platformSetting.create({ data: { key: itemKey(id, item.ordinal), value_json: JSON.stringify(task), updated_by: owner } });
        current.prepared = true; batch.prepared += 1;
        await writeBatch(tx, row, batch);
      } });
    }
    await prisma.$transaction(async tx => {
      const { row, batch } = await readOwned(owner, id, tx);
      if (batch.state === 'preparing' && batch.prepared === batch.total) { batch.state = 'ready'; batch.note = ''; await writeBatch(tx, row, batch); }
    });
  } catch (error) {
    await prisma.$transaction(async tx => {
      const { row, batch } = await readOwned(owner, id, tx);
      if (batch.state === 'preparing') { batch.state = 'blocked'; batch.note = error instanceof StudioError ? error.message : '素材准备中断，未派发生成；请取消后重新核对'; await writeBatch(tx, row, batch); }
    });
  }
}

export async function studioBatchView(owner: string, id: string, includeItems = true): Promise<StudioBatchView> {
  const { batch } = await readOwned(owner, id);
  if (batch.billingMode === 'actual') batch.committedCredits = await batchBillingCommitted(prisma, batch);
  const identity = await prisma.user.findUniqueOrThrow({ where: { id: owner }, select: { id: true, role: true, account_type: true, feature_profile_id: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true } });
  const taskIds = batch.items.flatMap(item => item.taskId ? [item.taskId] : []);
  const tasks = await prisma.imageStudioTask.findMany({ where: { id: { in: taskIds }, owner_id: owner }, select: { id: true, status: true, error: true, asset_id: true, deleted_at: true,
    owner_id: true, billing_status: true, actual_amount_micros: true, actual_credits: true, billing_contract_json: true, unit_credits: true, billing_settled_at: true } });
  const assets = includeItems ? await prisma.asset.findMany({ where: { id: { in: tasks.flatMap(task => !task.deleted_at && task.asset_id ? [task.asset_id] : []) }, owner_id: owner, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(identity)] }, select: { id: true, file_size: true } }) : [];
  const statuses = batch.items.map(item => item.cancelled ? 'cancelled' : item.taskId ? tasks.find(task => task.id === item.taskId)?.status || 'uncertain' : 'pending');
  const active = statuses.filter(state => ['running', 'queued'].includes(state)).length;
  const pending = statuses.filter(state => state === 'pending').length;
  const uncertain = statuses.filter(state => state === 'uncertain').length;
  return { id: batch.id, requestId: batch.requestId, moduleId: batch.moduleId, moduleName: batch.moduleName, state: !active && !pending && uncertain ? 'uncertain' : batch.state === 'ready' && !active && !pending ? 'complete' : batch.state, note: batch.note, total: batch.total, generated: statuses.filter(state => state === 'succeeded').length, failed: statuses.filter(state => state === 'failed').length, uncertain, active, pending, prepared: batch.prepared, budget: batch.budget, committedCredits: batch.committedCredits, unitCredits: batch.unitCredits, createdAt: batch.createdAt,
    ...(typeof batch.input.model === 'string' ? { model: batch.input.model } : {}),
    ...(includeItems ? { items: batch.items.map((item, index) => {
      const task = tasks.find(task => task.id === item.taskId);
      const asset = assets.find(asset => asset.id === task?.asset_id);
      return { ordinal: item.ordinal, sourceName: item.sourceName, taskId: item.taskId, status: statuses[index], error: task?.error,
        billing: task ? imageBillingView(task, owner, false) : null, image: asset ? { id: asset.id, url: studioAssetUrl(asset.id), thumbnail: studioAssetUrl(asset.id, true), fileSize: asset.file_size || 0 } : null };
    }) } : {}) };
}
export async function listStudioBatches(owner: string, cursor?: string) {
  if (cursor && !validId(cursor)) throw new StudioError('批次分页无效');
  const cursorRow = cursor ? (await readOwned(owner, cursor)).row : undefined;
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: `${PREFIX}${owner}:` } }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 13, ...(cursorRow ? { cursor: { id: cursorRow.id }, skip: 1 } : {}) });
  const selected = rows.slice(0, 12);
  return { batches: await Promise.all(selected.map(row => studioBatchView(owner, parse(row.value_json).id, false))), nextCursor: rows.length > 12 ? parse(selected[selected.length - 1].value_json).id : null };
}

export async function updateStudioBatch(owner: string, body: Record<string, unknown>) {
  const action = body.action;
  if (!['prepare', 'pause', 'resume', 'cancel', 'retry'].includes(String(action))) throw new StudioError('批次操作无效');
  const retryIds = body.ordinals;
  await prisma.$transaction(async tx => {
    const { row, batch } = await readOwned(owner, body.id, tx);
    if (action === 'prepare') {
      if (!['preparing', 'blocked'].includes(batch.state) || batch.prepared === batch.total) throw new StudioError('本批不需要继续准备');
      batch.state = 'preparing'; batch.note = '';
    }
    if (action === 'pause') { if (batch.state === 'preparing') throw new StudioError('素材尚未准备完成，请取消或等待'); batch.state = 'paused'; batch.note = '未派发项已暂停；已受理任务继续，未向上游申请撤销或退款'; }
    if (action === 'cancel') { batch.state = 'cancelled'; batch.items.forEach(item => { if (!item.taskId) item.cancelled = true; }); batch.note = '只取消未派发项；已受理任务继续，未向上游申请撤销或退款'; }
    if (action === 'resume') {
      if (batch.prepared !== batch.total || batch.state === 'cancelled') throw new StudioError('本批不能继续，请重新核对未准备素材');
      batch.state = 'ready'; batch.note = '';
    }
    if (action === 'retry') {
      if (batch.billingMode === 'actual') throw new StudioError('实扣重试需要重新报价，请复用原素材开始新批次；原失败项不会自动追扣', 409);
      if (!Array.isArray(retryIds) || !retryIds.length || retryIds.length > STUDIO_BATCH_LIMITS.images || retryIds.some(value => !Number.isInteger(value) || value < 1 || value > batch.total) || !boundedBudget(body.budget)) throw new StudioError('请选择失败项并填写新预算上限');
      const selected = batch.items.filter(item => retryIds.includes(item.ordinal));
      if (selected.some(item => item.attempt >= 3)) throw new StudioError('每项最多重试 3 次，请先核对失败原因；本次未重新生成');
      if (selected.length !== new Set(retryIds).size || selected.some(item => !item.taskId)) throw new StudioError('所选条目不能重试');
      const failed = await tx.imageStudioTask.count({ where: { id: { in: selected.map(item => item.taskId!) }, owner_id: owner, status: 'failed' } });
      if (failed !== selected.length) throw new StudioError('仅能重试已确认失败项；结果未知请先核对，保存失败无需重新生成');
      if (Number(body.budget) < batch.committedCredits + selected.length * batch.unitCredits) throw new StudioError('新预算不足以覆盖已派发点数与本次重试');
      batch.budget = Number(body.budget);
      selected.forEach(item => { item.taskId = null; item.attempt += 1; item.cancelled = false; });
      batch.state = 'ready'; batch.note = '';
    }
    await writeBatch(tx, row, batch);
  }, { timeout: 15000 });
  if (action === 'prepare') await prepareBatch(owner, body.id as string);
}

// Only the existing worker dispatches paid tasks; all GET routes are observation-only.
export async function dispatchStudioBatches() {
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: PREFIX }, value_json: { contains: '"state":"ready"' } }, orderBy: { updated_at: 'asc' }, take: 10 });
  for (const candidate of rows) {
    const original = parse(candidate.value_json);
    try {
      await prisma.$transaction(async tx => {
        const { row, batch } = await readOwned(original.ownerId, original.id, tx);
        if (batch.state !== 'ready') return;
        const item = batch.items.find(item => item.prepared && !item.taskId && !item.cancelled);
        if (!item) {
          const active = await tx.imageStudioTask.count({ where: { batch_id: batch.id, owner_id: batch.ownerId, status: { in: ['queued', 'running'] } } });
          if (!active) { batch.state = 'complete'; await writeBatch(tx, row, batch); }
          return;
        }
        if (await tx.imageStudioTask.count({ where: { owner_id: batch.ownerId, status: { in: ['queued', 'running'] } } }) >= 8) return;
        const prepared = await tx.platformSetting.findUnique({ where: { key: itemKey(batch.id, item.ordinal) } });
        if (!prepared) throw new StudioError('素材快照不可用，未派发新任务');
        const data = JSON.parse(prepared.value_json) as Prisma.ImageStudioTaskUncheckedCreateInput;
        const user = await tx.user.findUnique({ where: { id: batch.ownerId }, select: { id: true, role: true, account_type: true, feature_profile_id: true, status: true, user_profile: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true } });
        if (!user || user.status !== 'active' || !canUseCompanyTemplates(user)) throw new StudioError('当前账号不能继续生成');
        if (data.source_preset_id) {
          const source = await tx.imageStudioPreset.findUnique({ where: { id: data.source_preset_id }, select: { owner_id: true, scope: true, is_shared: true } });
          if (!source || !canViewStudioPreset(user, source)) throw new StudioError('模板已停止共享，未派发新任务');
        }
        const snapshot = JSON.parse(String(data.snapshot_json));
        const transientIds = (snapshot.transientReferenceImages || []).map((reference: { id: string }) => reference.id);
        const visibleReferences = await tx.asset.count({ where: { id: { in: transientIds }, owner_id: batch.ownerId, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user, tx)] } });
        if (visibleReferences !== new Set(transientIds).size) throw new StudioError('本批参考图已不可用，未派发新任务');
        const allIds = Array.from(new Set<string>((snapshot.referenceImages || []).map((reference: { id: string }) => reference.id)));
        const assets = await tx.asset.findMany({ where: { id: { in: allIds }, status: 'active', type: 'image' }, select: { id: true, owner_id: true, hash: true } });
        if (assets.length !== allIds.length || assets.some(asset => asset.owner_id !== snapshot.authorizedReferenceOwners?.[asset.id] || snapshot.referenceImages.find((reference: { id: string }) => reference.id === asset.id)?.hash !== asset.hash)) throw new StudioError('本批素材归属或内容已变化，未派发新任务');
        if (snapshot.styleGroupIds?.length) await resolveStudioStyleReferences(user, snapshot.styleGroupIds, tx);
        await historicalSkills(user, snapshot.skills, tx);
        const settingsRow = await tx.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
        const currentPrice = ({ ...DEFAULT_STUDIO_PRICES, ...(settingsRow ? JSON.parse(settingsRow.value_json).prices : {}) } as Record<string, number | null>)[String(data.model)];
        if (batch.billingMode === 'actual') {
          const contract = batch.billingContracts?.[item.ordinal - 1];
          const api = await getImageGenerationSettingsForModel(String(data.model));
          const ready = contract ? await imageBillingReady(contract.scope, contract.model, tx) : null;
          if (!contract || !ready?.ready || imageBillingScope(api) !== contract.scope
            || !settingsRow || JSON.parse(settingsRow.value_json).revision !== snapshot.settingsRevision
            || Date.parse(contract.deadline!) <= Date.now()) throw new StudioError('本批实扣合同或通道已变化，停止新派发；请重新报价');
          batch.committedCredits = await batchBillingCommitted(tx, batch);
        } else if (currentPrice !== data.unit_credits) throw new StudioError('价格变化，已停止新派发；请核对后开始新批次');
        if (batch.committedCredits + Number(data.unit_credits) > batch.budget) throw new StudioError('预算不足，已停止新派发；已扣、预留和待对账均计入预算');
        const taskId = `${batch.id}-${item.ordinal}-a${item.attempt}`;
        const freeze = Number(data.unit_credits) > 0 ? await allocateTaskCredits(tx, user, Number(data.unit_credits), taskId) : null;
        await tx.imageStudioTask.create({ data: { ...data, id: taskId, freeze_snapshot: freeze?.snapshot } });
        if (freeze) await tx.creditLedger.create({ data: { user_id: batch.ownerId, type: 'task_freeze', amount: -Number(data.unit_credits), balance_before: freeze.balance_before, balance_after: freeze.balance_after, frozen_before: freeze.frozen_before, frozen_after: freeze.frozen_after, related_task_id: taskId, idempotency_key: `image-studio:freeze:${taskId}`, reason: '图片生成冻结积分', metadata_json: JSON.stringify({ allocations: freeze.allocations }) } });
        item.taskId = taskId; batch.committedCredits += Number(data.unit_credits);
        await writeBatch(tx, row, batch);
      }, { timeout: 15000 });
    } catch (error) {
      await prisma.$transaction(async tx => {
        const { row, batch } = await readOwned(original.ownerId, original.id, tx);
        if (batch.state !== 'ready') return;
        batch.state = 'blocked'; batch.note = error instanceof StudioError ? error.message : error instanceof Error && error.message.startsWith('点数不足') ? '可用点数不足，已停止新派发；补足点数后可继续' : '批次派发暂时中断，已受理项保留，请重新读取后继续';
        await writeBatch(tx, row, batch);
      });
    }
  }
}

async function batchBillingCommitted(tx: Pick<Prisma.TransactionClient, 'imageStudioTask'>, batch: BatchRecord) {
  const settled = await tx.imageStudioTask.aggregate({ where: { owner_id: batch.ownerId, batch_id: batch.id, billing_settled_at: { not: null } }, _sum: { actual_credits: true } });
  const reserved = await tx.imageStudioTask.aggregate({ where: { owner_id: batch.ownerId, batch_id: batch.id, billing_settled_at: null }, _sum: { unit_credits: true } });
  return Math.round(((settled._sum.actual_credits || 0) + (reserved._sum.unit_credits || 0)) * 100) / 100;
}
