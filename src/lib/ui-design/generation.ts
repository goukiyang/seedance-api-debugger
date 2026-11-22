import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';
import { captureImageGenerationRequestChannel } from '@/lib/integrations/image-generation';
import { randomUUID, createHash } from 'node:crypto';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { assertCanGenerateInProject } from '@/lib/projects/permissions';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { prepareImageBillingQuote } from '@/lib/image-studio/billing-quote-service';
import { submitStudioBatch, studioBusinessErrorStatus, StudioError } from '@/lib/image-studio/tasks';
import { readStudioSubmitReceipt, closeStudioSubmission, rejectStudioSubmission, studioSubmitFailureDetail } from '@/lib/image-studio/submit-receipts.server';
import { sumCredits } from '@/lib/credits/precision';
import { defaultStudioReferencePolicy } from '@/lib/image-studio/reference-policy';
import { studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';
import { privateModule } from './runtime';
import { readUiDocument, saveUiDocument, uiId, uiKey } from './store';
import { uiUseAsset, registerUiImage } from './media';
import { uiHash } from './analysis';
import type { JsonObject, UiJob, UiBatch, UiDocument } from './types';
const source = (user: SessionUser, job: UiJob) => ({ user, requestId: job.id });
export async function quoteUiBatch(user: SessionUser, data: JsonObject) {
  const workspace = await readUiDocument(user.id, 'workspace', uiId(data.workspaceId));
  if (workspace.archived) throw new AuthError('此设计已归档', 409);
  if (!workspace.data.projectId) throw new AuthError('请先选择有权生成的本站项目', 400);
  await assertCanGenerateInProject(user, workspace.data.projectId);
  const runId = uiId(data.runId), previous = await prisma.platformSetting.findUnique({ where: { key: uiKey(user.id, 'batch', runId) } });
  if (previous) {
    const saved = JSON.parse(previous.value_json) as UiDocument;
    if (saved.data.sourceHash !== uiHash(data)) throw new AuthError('此批次原号已绑定其他输入，请查询原记录', 409);
    return saved;
  }
  const analysis = await readUiDocument(user.id, 'analysis', uiId(data.analysisId));
  if (analysis.data.workspaceId !== workspace.id || analysis.data.state !== 'ready' || uiHash(analysis.data.direction) !== uiHash(data.task?.designDirection || data.task?.manifest?.designDirection)) throw new AuthError('分析与本次设计不一致，请保留输入重新分析', 409);
  const workflow = await privateModule('lovart-workflow.js'), standards = await privateModule('design-standards.js');
  if (data.task?.provider !== 'sd2') throw new AuthError('旧外部任务仅可按原来源查看，不能转交本站重新生成', 409);
  workflow.assertPromptBudget(data.task); standards.assertTask(data.task);
  const settings = await getImageStudioSettings(), jobs: UiJob[] = [];
  const frameIds = analysis.data.input.frames.map((frame: JsonObject) => frame.id);
  if (!Array.isArray(data.task.jobs) || data.task.jobs.length !== frameIds.length || data.task.jobs.some((job: JsonObject) => !frameIds.includes(job.frameId))) throw new AuthError('分析未完整覆盖本次选屏', 409);
  for (const item of data.task.jobs) {
    if (typeof item.prompt !== 'string' || item.prompt.length > 20000) throw new AuthError(`「${item.name || item.frameId}」生成说明超过本站 20000 字；完整输入保留，未提交`, 413);
    const attachments = data.attachments?.[item.frameId];
    if (!Array.isArray(attachments) || attachments.length !== item.attachments?.length) throw new AuthError('设计附图缺失，尚未报价', 400);
    const references = [];
    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index];
      if (attachment.name !== item.attachments[index].name.replace(/[\\/]/g, '__')) throw new AuthError('附图角色或顺序已变化', 409);
      const registered = await registerUiImage(user, attachment), asset = await uiUseAsset(user, { assetId: registered.assetId, referenceImageId: attachment.referenceImageId });
      references.push({ assetId: asset.id, hash: asset.hash || '', referenceImageId: attachment.referenceImageId, role: item.attachments[index].kind, label: attachment.name });
    }
    if (new Set(references.map(reference => reference.assetId)).size !== references.length) throw new AuthError('同一原件占用了多个附图位置；本站线路不能无歧义发送重复位置，输入保留，尚未提交', 422);
    const effective = await resolveImageGenerationRequestChannel(data.settings.model, data.settings.channelId, undefined, data.settings.quality) || 'original';
    const imageChannel = effective !== 'original' ? await captureImageGenerationRequestChannel(data.settings.model, data.settings.quality, data.settings.channelId) : undefined;
    const id = randomUUID();
    const body = { requestId: id, projectId: workspace.data.projectId, prompt: item.prompt, count: 1, revision: settings.revision,
      model: data.settings.model, channelId: effective, ...(imageChannel ? { imageChannel } : {}), quality: data.settings.quality || 'auto', resolution: data.settings.resolution || '1K', aspectRatio: data.settings.aspectRatio || 'auto',
      referenceIds: references.map(reference => reference.assetId), draft: { styleGroupIds: [], skillIds: [], referencePolicy: { ...defaultStudioReferencePolicy(references.map(reference => reference.assetId)), useFixedReferences: false } } };
    const context = `仅执行本 UI 作业，不继承其他模板。附图实际顺序与角色：\n${references.map((reference, index) => `第${index + 1}张：${reference.role}；${reference.label}；摘要${reference.hash}`).join('\n')}\n线框约束结构、风格图约束视觉、上一版仅用于用户指定的精修，不能互换角色。`;
    const job: UiJob = { id, workspaceId: workspace.id, frameId: item.frameId, runId, parentRunId: data.parentRunId, inputHash: uiHash({ body, context, references, analysisId: data.analysisId }), body, context, references, state: 'prepared' };
    let receipt = await saveUiDocument(user.id, 'request', id, 0, job);
    job.quote = await prepareImageBillingQuote(user.id, body, undefined, undefined, undefined, 0, undefined, source(user, job));
    receipt = await saveUiDocument(user.id, 'request', id, receipt.revision, job);
    jobs.push(receipt.data as UiJob);
  }
  const batch: UiBatch = { id: runId, workspaceId: workspace.id, inputHash: uiHash(jobs.map(job => [job.id, job.inputHash, job.quote])), jobs,
    total: sumCredits(jobs.map(job => job.quote!.estimatedCredits)), confirmed: false, stopped: false, pricingRevision: uiHash(jobs.map(job => job.quote?.pricingRevision)) };
  return saveUiDocument(user.id, 'batch', runId, 0, { ...batch, sourceHash: uiHash(data) });
}
export async function confirmUiBatch(user: SessionUser, input: JsonObject) {
  const document = await readUiDocument(user.id, 'batch', uiId(input.runId)), batch = document.data as UiBatch;
  if (batch.inputHash !== input.inputHash || batch.total !== input.total || document.revision !== input.revision) throw new AuthError('批次报价已变化，请重新查看后确认', 409);
  if (batch.jobs.some(job => Date.parse(job.quote!.expiresAt) <= Date.now())) throw new AuthError('报价已过期，原号保留；请重新报价尚未受理界面', 409);
  return saveUiDocument(user.id, 'batch', document.id, document.revision, { ...batch, confirmed: true, stopped: false, confirmedAt: new Date().toISOString() });
}
export async function submitUiJob(user: SessionUser, input: JsonObject, send: typeof submitStudioBatch = submitStudioBatch) {
  const requestId = uiId(input.requestId), runId = uiId(input.runId);
  // Claim and stop use the same parent CAS in one short transaction. No supplier/quote/global DB calls are inside it.
  const claim = await prisma.$transaction(async tx => {
    const parent = await readUiDocument(user.id, 'batch', runId, tx), jobDocument = await readUiDocument(user.id, 'request', requestId, tx);
    const batch = parent.data as UiBatch, job = jobDocument.data as UiJob;
    if (job.runId !== runId || !batch.jobs.some(item => item.id === job.id && item.inputHash === job.inputHash) || input.inputHash !== job.inputHash) throw new AuthError('原号与本次内容不匹配', 409);
    if (job.state !== 'prepared') return { job, claimed: false };
    if (batch.stopped || !batch.confirmed || input.batchHash !== batch.inputHash) throw new AuthError('此批次尚未确认费用或已停止', 409);
    if (Date.parse(job.quote!.expiresAt) <= Date.now()) throw new AuthError('本屏报价已过期，请重新报价并确认；未受理', 409);
    const nextParent = { ...parent, revision: parent.revision + 1, updatedAt: new Date().toISOString() };
    const touched = await tx.platformSetting.updateMany({ where: { key: uiKey(user.id, 'batch', runId), value_json: JSON.stringify(parent) }, data: { value_json: JSON.stringify(nextParent) } });
    if (!touched.count) throw new AuthError('批次状态已变化，请读取原记录', 409);
    const nextJob = { ...jobDocument, revision: jobDocument.revision + 1, data: { ...job, state: 'sending' } };
    if (!(await tx.platformSetting.updateMany({ where: { key: uiKey(user.id, 'request', requestId), value_json: JSON.stringify(jobDocument) }, data: { value_json: JSON.stringify(nextJob) } })).count) throw new AuthError('本屏已在另一窗口领取，请核对原号', 409);
    return { job, claimed: true };
  });
  if (!claim.claimed) return uiJobStatus(user, requestId);
  const job = claim.job;
  try {
    await assertCanGenerateInProject(user, job.body.projectId);
    const batchId = await send(user.id, { ...job.body, billingQuoteId: job.quote!.billingQuoteId || undefined, maxEstimatedCost: job.quote!.estimatedCredits,
      ...(job.quote!.imageChannel ? { imageChannel: job.quote!.imageChannel } : {}) }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, source(user, job));
    const current = await readUiDocument(user.id, 'request', job.id);
    await saveUiDocument(user.id, 'request', job.id, current.revision, { ...current.data, state: 'accepted', batchId });
  } catch (error) {
    const expected = error instanceof StudioError || error instanceof AuthError || studioBusinessErrorStatus(error) !== null;
    const receipt = expected ? await rejectStudioSubmission(user.id, job.id, studioSubmitFailureDetail(error)) : null;
    const current = await readUiDocument(user.id, 'request', job.id);
    await saveUiDocument(user.id, 'request', job.id, current.revision, { ...current.data, state: receipt?.state === 'rejected' ? 'rejected' : 'unknown', error: error instanceof Error ? error.message : '提交结果待确认' });
  }
  return uiJobStatus(user, requestId);
}
export async function uiJobStatus(user: SessionUser, id: string) {
  const record = await readUiDocument(user.id, 'request', uiId(id)), job = record.data as UiJob;
  const receipt = job.state === 'prepared' ? null : await readStudioSubmitReceipt(user.id, job.id);
  const batchId = createHash('sha256').update(`${user.id}:${job.id}`).digest('hex');
  const tasks = await prisma.imageStudioTask.findMany({ where: { owner_id: user.id, batch_id: batchId }, select: { id: true, asset_id: true, status: true, usage_json: true } });
  return { job, receipt, tasks: tasks.map(task => ({ id: task.id, status: task.status, assetId: studioTaskHasViewableOutput(task) ? task.asset_id : null,
    url: studioTaskHasViewableOutput(task) && task.asset_id ? `/api/tools/ui-design/media?id=${task.asset_id}` : null })) };
}
export async function stopUiBatch(user: SessionUser, id: string) {
  const record = await readUiDocument(user.id, 'batch', uiId(id));
  return saveUiDocument(user.id, 'batch', id, record.revision, { ...record.data, stopped: true });
}
export async function closeUiJob(user: SessionUser, id: string) {
  const record = await readUiDocument(user.id, 'request', uiId(id));
  const receipt = await closeStudioSubmission(user.id, id);
  if (receipt.state === 'closed') await saveUiDocument(user.id, 'request', id, record.revision, { ...record.data, state: 'closed' });
  return receipt;
}
export async function requoteUiBatch(user: SessionUser, id: string) {
  const parent = await readUiDocument(user.id, 'batch', uiId(id)), batch = parent.data as UiBatch;
  const jobs: UiJob[] = [];
  for (const frozen of batch.jobs) {
    const current = await readUiDocument(user.id, 'request', frozen.id), job = current.data as UiJob;
    if (job.state === 'prepared') {
      job.quote = await prepareImageBillingQuote(user.id, job.body, undefined, undefined, undefined, 0, undefined, source(user, job));
      await saveUiDocument(user.id, 'request', job.id, current.revision, job);
    }
    jobs.push(job);
  }
  return saveUiDocument(user.id, 'batch', id, parent.revision, { ...batch, jobs, total: sumCredits(jobs.map(job => job.quote!.estimatedCredits)),
    inputHash: uiHash(jobs.map(job => [job.id, job.inputHash, job.quote])), pricingRevision: uiHash(jobs.map(job => job.quote?.pricingRevision)), confirmed: false });
}
