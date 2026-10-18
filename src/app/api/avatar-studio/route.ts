import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { listStudioTasks, StudioError, publicImageTaskStatus } from '@/lib/image-studio/tasks';
import { avatarResultRecords, listAvatarRecords, mutateAvatarRecord, readAvatar } from '@/lib/avatar-random/store';
import { avatarDescriptionStatus, estimateAvatarDraft, parseAvatarDescription, prepareAvatarPlan, quoteAvatarPlan, submitAvatarPlan, validateAvatarReferences, publicAvatarPlan, currentAvatarOutputContract } from '@/lib/avatar-random/service';
import { publicImageOutputPlan } from '@/lib/image-generation/output-plan';
import { imageBillingView } from '@/lib/image-studio/billing-contract';
import { imageBillingReadinessPayload } from '@/lib/image-studio/billing-readiness';
import { AvatarDescriptionError, isLegalAvatarParserVersion, isLegalDescriptionRequestId } from '@/lib/avatar-random/description-parser';
import { adaptAvatarPrompt, parseAvatarRules } from '@/lib/avatar-random/engine';
import { AVATAR_COMPILER_VERSION, type AvatarPlan, type AvatarRecord } from '@/lib/avatar-random/types';
import { prisma } from '@/lib/prisma';
import { randomUUID } from 'node:crypto';
import { avatarPlanKey } from '@/lib/avatar-random/store';
import { studioAssetUrl } from '@/lib/image-studio/media';
import { studioOutputMismatch as studioDimensionMismatch, studioDimensionMismatchNotice, studioTaskHasViewableOutput, studioOutputMismatchDisposition } from '@/lib/image-studio/dimension-mismatch';
import { createHash } from 'node:crypto';
import { getImageGenerationSettingsForModel, isImageGenerationApiReady, isStudioImageGenerationProvider, getImageGenerationChannelOptions, captureImageGenerationChannel, resolveImageGenerationChannelSnapshot, validateImageGenerationChannel } from '@/lib/integrations/image-generation';
import { IMAGE_STUDIO_MODELS } from '@/lib/image-studio/model-catalog';
import { isAvatarSheet, avatarLayout, withAvatarLayout } from '@/lib/avatar-random/layout';
import { avatarRulesSignature } from '@/lib/avatar-random/intent';
import { QueueCapacityError, QueueMaintenanceError } from '@/lib/image-studio/queue-capacity';
import { ImageGenerationChannelError } from '@/lib/integrations/image-generation';
import { historicalImageSupplier } from '@/lib/image-studio/channel-history';
import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';

function validateOriginalContinuation(body: Record<string, unknown>) {
  if (body.descriptionMode === undefined && body.originalAttemptRequestId === undefined) return;
  const rules = body.rules;
  const description = rules && typeof rules === 'object' && !Array.isArray(rules) ? (rules as { description?: unknown }).description : undefined;
  if (body.descriptionMode !== 'original' || body.actionType !== 'new'
    || typeof body.descriptionId !== 'string' || !/^[a-f0-9]{64}$/.test(body.descriptionId)
    || !isLegalAvatarParserVersion(body.parserVersion) || !isLegalDescriptionRequestId(body.originalAttemptRequestId)
    || typeof description !== 'string' || !description.trim() || description.length > 3000) {
    throw new StudioError('按原描述继续的请求无效，请重新查询当前文案状态', 400);
  }
}

async function sourceTask(owner:string,id?:string) {
  if(!id)return null;
  const task=await prisma.imageStudioTask.findFirst({where:{id,owner_id:owner,deleted_at:null}});
  const mismatch=task&&studioDimensionMismatch(task);
  const asset=task?.asset_id&&studioTaskHasViewableOutput(task)?await prisma.asset.findFirst({where:{id:task.asset_id,owner_id:owner,status:'active',type:'image'}}):null;
  let outputPlan: unknown;
  try { outputPlan = JSON.parse(task?.snapshot_json || '{}').outputPlan; } catch {}
  return task?{id:task.id,ordinal:1,status:publicImageTaskStatus(task.status),outputSize:task.output_size,outputPlan:publicImageOutputPlan(outputPlan),resultDisposition:mismatch?mismatch.code==='generated_format_mismatch'?'format_mismatch':'dimensions_mismatch':null,error:mismatch&&asset?studioDimensionMismatchNotice(mismatch.validation):task.error,snapshot:historicalImageSupplier(task.snapshot_json),billing:imageBillingView(task,owner,false),asset:asset?{id:asset.id,original_url:studioAssetUrl(asset.id),thumbnail_url:studioAssetUrl(asset.id,true),file_name:asset.file_name,mime_type:asset.mime_type,width:asset.width,height:asset.height}:null}:null;
}

export const dynamic = 'force-dynamic';
async function run(action: (owner: string) => Promise<unknown>) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (user.status !== 'active' || !canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限有图片生成权限的公司账号使用' }, { status: 403 });
  try { return NextResponse.json(await action(user.id), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (e) {
    if (e instanceof ImageGenerationChannelError) return NextResponse.json({ error: e.message, code: e.code, submitted: false }, { status: e.status });
    if (e instanceof QueueCapacityError || e instanceof QueueMaintenanceError) return NextResponse.json({ error: e.message, code: e.code, submitted: false }, { status: e.status });
    if (e instanceof AvatarDescriptionError) {
      console.warn('[AvatarDescription]', JSON.stringify({ requestId: e.parse.requestId, state: e.parse.state, ...e.parse.failure, diagnostics: e.parse.diagnostics }));
      return NextResponse.json({ error: e.message, parse: e.parse }, { status: e.status, headers: { 'Cache-Control': 'private, no-store' } });
    }
    return NextResponse.json({ error: e instanceof StudioError ? e.message : '操作未确认，请重新读取；不要重复新建出图任务' }, { status: e instanceof StudioError ? e.status : 503 });
  }
}
export async function GET(req: NextRequest) { return run(async owner => {
  const imageTaskId=req.nextUrl.searchParams.get('imageTask');
  if(imageTaskId){if(!/^[a-zA-Z0-9-]{1,100}$/.test(imageTaskId))throw new StudioError('图片记录无效');return {sourceTask:await sourceTask(owner,imageTaskId), resultRecords: await avatarResultRecords(owner, [imageTaskId])};}
  const planId = req.nextUrl.searchParams.get('plan');
  const recordId=req.nextUrl.searchParams.get('record');
  if(recordId){const record=await readAvatar<AvatarRecord>(owner,'record',recordId);if(!record||record.deletedAt)throw new StudioError('记录已失效',404);return {record};}
  if (planId) {
    const plan = await readAvatar<AvatarPlan>(owner, 'plan', planId);
    if (!plan) throw new StudioError('草稿不存在', 404);
    const result = await listStudioTasks(owner, undefined, undefined, false, undefined, plan.id);
    return { plan: publicAvatarPlan(plan), sourceTask: await sourceTask(owner, plan.sourceTaskId), ...result,
      resultRecords: await avatarResultRecords(owner, [...result.tasks.map(task => task.id), ...(plan.sourceTaskId ? [plan.sourceTaskId] : [])]) };
  }
  const settings = await getImageStudioSettings();
  const kind=req.nextUrl.searchParams.get('kind')||'result';
  if(!['config','character','result'].includes(kind))throw new StudioError('记录类别无效');
  const records=await listAvatarRecords(owner, req.nextUrl.searchParams.get('cursor') || undefined,kind,req.nextUrl.searchParams.get('deleted')==='1');
  const ids=records.records.flatMap(r=>r.taskId?[r.taskId]:[]);
  const rows=await prisma.imageStudioTask.findMany({where:{id:{in:ids},owner_id:owner}});
  const assets=await prisma.asset.findMany({where:{id:{in:rows.flatMap(t=>t.asset_id?[t.asset_id]:[])},owner_id:owner,status:'active',type:'image'},select:{id:true}});
  const byId=new Set(assets.map(a=>a.id));
  const recordTasks=Object.fromEntries(rows.map(t=>[t.id,{id:t.id,ordinal:t.ordinal,status:publicImageTaskStatus(t.status),error:t.error,snapshot:historicalImageSupplier(t.snapshot_json),billing:imageBillingView(t,owner,false),asset:t.asset_id&&byId.has(t.asset_id)?{id:t.asset_id,original_url:studioAssetUrl(t.asset_id),thumbnail_url:studioAssetUrl(t.asset_id,true)}:null}]));
  return { ...records, recordTasks, settings: { model: settings.model, revision: settings.revision, prices: settings.prices, imageChannels: await getImageGenerationChannelOptions(), billingReadiness: await imageBillingReadinessPayload() } };
}); }
export async function POST(req: NextRequest) { return run(async owner => {
  const body = await req.json();
  if (!body || typeof body !== 'object'||Array.isArray(body)) throw new StudioError('请求无效');
  if (body.action === 'billing-quote') {
    if (body.planId === undefined) return estimateAvatarDraft(owner, body);
    if (typeof body.planId !== 'string' || body.planId.length > 120) throw new StudioError('人物草稿编号无效');
    return quoteAvatarPlan(owner, body.planId);
  }
  if (body.action === 'parse-status') return { parse: await avatarDescriptionStatus(owner, body.description) };
  if (body.action === 'analyze') {
    if (typeof body.description !== 'string' || !body.description.trim() || body.description.length > 3000 || !Number.isSafeInteger(body.draftRevision) || body.draftRevision < 0) throw new StudioError('文案或当前草稿无效');
    await parseAvatarDescription(owner, body.description.trim(), body.approveTextModel === true, typeof body.parseRetryToken === 'string' ? body.parseRetryToken : undefined);
    return { parse: await avatarDescriptionStatus(owner, body.description), binding: { ownerId: owner, description: body.description.trim(), draftRevision: body.draftRevision } };
  }
  if (body.action === 'parse-recheck') {
    if (typeof body.description !== 'string' || body.description.length > 3000) throw new StudioError('人物描述无效');
    await parseAvatarDescription(owner, body.description.trim(), false, undefined, true);
    return { parse: await avatarDescriptionStatus(owner, body.description) };
  }
  if (body.action === 'prepare') { validateOriginalContinuation(body); return { plan: await prepareAvatarPlan(owner, body) }; }
  if (body.action === 'submit') return { batchId: await submitAvatarPlan(owner, body.id, body.layout, body) };
  if (body.action === 'restore') {
    const record = await readAvatar<AvatarRecord>(owner, 'record', body.id);
    if (!record || (!record.candidate && !record.sheetCandidates) || record.deletedAt) throw new StudioError('人物记录已不可用');
    const original=record.planId?await readAvatar<AvatarPlan>(owner,'plan',record.planId):null;
    if(!original)throw new StudioError('原始生成参数快照已不可用，不能伪造默认参数',409);
    const task=record.taskId?await prisma.imageStudioTask.findFirst({where:{id:record.taskId,owner_id:owner}}):null;
    const snapshot=task?.snapshot_json?JSON.parse(task.snapshot_json):null;
    const plan: AvatarPlan = { ...original,id: `${isAvatarSheet(original)?'sheet-':''}${randomUUID()}`, candidates: record.sheetCandidates || [record.candidate!], ...(snapshot?{model:snapshot.model,quality:snapshot.quality,resolution:snapshot.resolution,aspectRatio:snapshot.aspectRatio,settingsRevision:snapshot.settingsRevision,unitCredits:snapshot.unitCredits,referenceIds:JSON.parse(task!.reference_ids)}:{}), createdAt: new Date().toISOString(),sourceTaskId:record.taskId,restoredFrom:record.id,warnings:['已恢复当时完整设置；原模型和参考图保留，出图前需更新报价并重新校验可用性。'] };
    // Restoring settings creates a new intent, never the old key or its fee authorization.
    Object.assign(plan, { ratioContractVersion: 3, outputPlan: undefined, outputPlanHash: undefined });
    await prisma.platformSetting.create({ data: { key: avatarPlanKey(owner, plan), value_json: JSON.stringify(plan), updated_by: owner } });
    return { plan: publicAvatarPlan(plan),sourceTask:await sourceTask(owner,record.taskId) };
  }
  if(body.action==='quote'){
    const previous=await readAvatar<AvatarPlan>(owner,'plan',body.id);if(!previous)throw new StudioError('人物草稿不存在');
    await validateAvatarReferences(owner, previous.referenceIds);
    if (!body.rules || avatarRulesSignature(parseAvatarRules(body.rules), false) !== avatarRulesSignature(previous.candidates[0].rules, false)) throw new StudioError('人物条件已变化，不能沿用旧人物报价；请按当前条件准备人物', 409);
    if ((body.layout || avatarLayout(previous)) === avatarLayout(previous) && avatarRulesSignature(parseAvatarRules(body.rules)) !== avatarRulesSignature(previous.candidates[0].rules)) throw new StudioError('人数或候选数量已变化，请按当前条件准备人物', 409);
    if (body.layout !== undefined && !['independent','contact-sheet','contact-sheet-9'].includes(body.layout)) throw new StudioError('人物排版无效');
    const layout=body.layout || avatarLayout(previous);
    const settings=await getImageStudioSettings();
    const model=typeof body.model==='string'?body.model:previous.model;
    if(!IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number]))throw new StudioError('原模型已不可用，请明确选择可用模型；人物草稿保留');
    const quality=typeof body.quality==='string'?body.quality:previous.quality,resolution=typeof body.resolution==='string'?body.resolution:previous.resolution;
    let price=settings.prices[model as keyof typeof settings.prices];
    const channelId=typeof body.channelId==='string'?body.channelId:previous.channelId||'original';
    const effectiveChannelId=await resolveImageGenerationRequestChannel(model,channelId)||'original';
    const imageChannel=effectiveChannelId!=='original'?await captureImageGenerationChannel(model,effectiveChannelId):undefined;
    const api=imageChannel?await resolveImageGenerationChannelSnapshot(imageChannel,undefined,true,model):await getImageGenerationSettingsForModel(model);
    if(imageChannel){const capability=validateImageGenerationChannel(api,{model,quality,resolution,ratio:isAvatarSheet({layout})?'1:1':previous.aspectRatio,referenceCount:previous.referenceIds.length});if(!capability.ok)throw new StudioError(capability.error);price=capability.capability.fixedPoints;}
    if(!imageChannel&&(price===undefined||price===null))throw new StudioError('原模型已失效或没有报价，历史设置仍保留');
    let plan:AvatarPlan;
    try { plan=withAvatarLayout({...previous,sourceTaskId:undefined,model,channelId,imageChannel,quality,resolution,id:(isAvatarSheet({layout})?'sheet-':'')+createHash('sha256').update(`quote:output-v3:${AVATAR_COMPILER_VERSION}:${owner}:${previous.id}:${settings.revision}:${model}:${quality}:${resolution}:${layout}:${channelId}:${imageChannel?.configRevision||'legacy'}`).digest('hex'),settingsRevision:settings.revision,unitCredits:price,imageReady:isStudioImageGenerationProvider(api.provider)&&isImageGenerationApiReady(api)&&(previous.referenceIds.length?api.supports_image_to_image:api.supports_text_to_image),candidates:previous.candidates.map(c=>adaptAvatarPrompt(c,model)),createdAt:new Date().toISOString()},layout);
      Object.assign(plan, currentAvatarOutputContract(plan, api)); }
    catch(e){throw new StudioError((e as Error).message);}
    await prisma.platformSetting.upsert({where:{key:avatarPlanKey(owner,plan)},create:{key:avatarPlanKey(owner,plan),value_json:JSON.stringify(plan),updated_by:owner},update:{}});
    return {plan:publicAvatarPlan(await readAvatar<AvatarPlan>(owner,'plan',plan.id))};
  }
  if (body.action === 'retry') {
    const previous = await readAvatar<AvatarPlan>(owner, 'plan', body.id);
    if (!previous) throw new StudioError('历史批次不存在');
    const tasks = (await listStudioTasks(owner, undefined, undefined, false, undefined, previous.id)).tasks;
    if (tasks.some(t => ['queued', 'running', 'uncertain'].includes(t.status))) throw new StudioError('仍有进行中或受理未知任务，请先查询');
    const failed = tasks.filter(t => t.status === 'failed');
    if (!failed.length) throw new StudioError('没有可重试的明确失败项');
    const settings = await getImageStudioSettings();
    const plan = { ...previous, sourceTaskId: undefined, id: (isAvatarSheet(previous)?'sheet-':'')+createHash('sha256').update(`retry:${owner}:${previous.id}`).digest('hex'), candidates: isAvatarSheet(previous) ? previous.candidates : failed.map(t => previous.candidates[t.ordinal - 1]), settingsRevision: settings.revision, unitCredits: previous.imageChannel ? previous.unitCredits : settings.prices[previous.model as keyof typeof settings.prices], createdAt: new Date().toISOString() };
    const api = plan.imageChannel ? await resolveImageGenerationChannelSnapshot(plan.imageChannel, undefined, true, plan.model) : await getImageGenerationSettingsForModel(plan.model);
    Object.assign(plan, currentAvatarOutputContract(plan, api));
    if (!previous.imageChannel && plan.unitCredits === null) throw new StudioError('当前模型尚未设置报价');
    await prisma.platformSetting.upsert({where:{key:avatarPlanKey(owner,plan)},create:{key:avatarPlanKey(owner,plan),value_json:JSON.stringify(plan),updated_by:owner},update:{}});
    return { plan:publicAvatarPlan(await readAvatar<AvatarPlan>(owner,'plan',plan.id)) };
  }
  if (body.action === 'save' && body.record?.kind === 'config') body.record.rules = parseAvatarRules(body.record.rules);
  if (body.action === 'save' && body.record?.kind === 'character') {
    const plan = await readAvatar<AvatarPlan>(owner, 'plan', body.planId);
    if (plan && isAvatarSheet(plan)) throw new StudioError('整张宫格不能保存为某一个人的身份基准。请切换独立头像并重新报价出图。');
    const candidate = plan?.candidates[Number(body.index)];
    if (!candidate) throw new StudioError('人物草稿不存在');
    const result = (await listStudioTasks(owner, undefined, undefined, false, undefined, plan!.id)).tasks.find(task => task.ordinal === Number(body.index) + 1 && task.asset && (task.status === 'succeeded' || studioOutputMismatchDisposition(task.resultDisposition))) || (Number(body.index)===0 ? await sourceTask(owner,plan!.sourceTaskId):null);
    if (!result?.asset || result.status !== 'succeeded' && !studioOutputMismatchDisposition(result.resultDisposition)) throw new StudioError('保存人物需要已返回的基准原图');
    body.record = { kind: 'character', rules:candidate.rules,candidate: { ...candidate, baselineAssetId: candidate.baselineAssetId || result.asset.id }, assetId: result.asset.id,planId:plan!.id,taskId:result.id };
  } else if (body.action === 'save' && body.record && body.record.kind !== 'config') throw new StudioError('不能新建或改写历史结果');
  return { record: await mutateAvatarRecord(owner, body) };
}); }
