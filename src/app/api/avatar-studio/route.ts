import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { listStudioTasks, StudioError } from '@/lib/image-studio/tasks';
import { listAvatarRecords, mutateAvatarRecord, readAvatar } from '@/lib/avatar-random/store';
import { prepareAvatarPlan, submitAvatarPlan } from '@/lib/avatar-random/service';
import { adaptAvatarPrompt, parseAvatarRules } from '@/lib/avatar-random/engine';
import type { AvatarPlan, AvatarRecord } from '@/lib/avatar-random/types';
import { prisma } from '@/lib/prisma';
import { randomUUID } from 'node:crypto';
import { avatarKey } from '@/lib/avatar-random/store';
import { studioAssetUrl } from '@/lib/image-studio/media';
import { createHash } from 'node:crypto';
import { getImageGenerationSettingsForModel, isImageGenerationApiReady, isStudioImageGenerationProvider } from '@/lib/integrations/image-generation';
import { IMAGE_STUDIO_MODELS } from '@/lib/image-studio/model-catalog';

async function sourceTask(owner:string,id?:string) {
  if(!id)return null;
  const task=await prisma.imageStudioTask.findFirst({where:{id,owner_id:owner}});
  const asset=task?.asset_id?await prisma.asset.findFirst({where:{id:task.asset_id,owner_id:owner,status:'active',type:'image'}}):null;
  return task?{id:task.id,ordinal:1,status:task.status,error:task.error,asset:asset?{id:asset.id,original_url:studioAssetUrl(asset.id),thumbnail_url:studioAssetUrl(asset.id,true)}:null}:null;
}

export const dynamic = 'force-dynamic';
async function run(action: (owner: string) => Promise<unknown>) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (user.status !== 'active' || !canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限有图片生成权限的公司账号使用' }, { status: 403 });
  try { return NextResponse.json(await action(user.id), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (e) { return NextResponse.json({ error: e instanceof StudioError ? e.message : '操作未确认，请重新读取；不要重复新建出图任务' }, { status: e instanceof StudioError ? e.status : 503 }); }
}
export async function GET(req: NextRequest) { return run(async owner => {
  const planId = req.nextUrl.searchParams.get('plan');
  const recordId=req.nextUrl.searchParams.get('record');
  if(recordId){const record=await readAvatar<AvatarRecord>(owner,'record',recordId);if(!record||record.deletedAt)throw new StudioError('记录已失效',404);return {record};}
  if (planId) { const plan = await readAvatar<AvatarPlan>(owner, 'plan', planId); if (!plan) throw new StudioError('草稿不存在', 404); return { plan, sourceTask:await sourceTask(owner,plan.sourceTaskId), ...(await listStudioTasks(owner, undefined, undefined, false, undefined, plan.id)) }; }
  const settings = await getImageStudioSettings();
  const kind=req.nextUrl.searchParams.get('kind')||'result';
  if(!['config','character','result'].includes(kind))throw new StudioError('记录类别无效');
  const records=await listAvatarRecords(owner, req.nextUrl.searchParams.get('cursor') || undefined,kind,req.nextUrl.searchParams.get('deleted')==='1');
  const ids=records.records.flatMap(r=>r.taskId?[r.taskId]:[]);
  const rows=await prisma.imageStudioTask.findMany({where:{id:{in:ids},owner_id:owner}});
  const assets=await prisma.asset.findMany({where:{id:{in:rows.flatMap(t=>t.asset_id?[t.asset_id]:[])},owner_id:owner,status:'active',type:'image'},select:{id:true}});
  const byId=new Set(assets.map(a=>a.id));
  const recordTasks=Object.fromEntries(rows.map(t=>[t.id,{id:t.id,ordinal:t.ordinal,status:t.status,error:t.error,asset:t.asset_id&&byId.has(t.asset_id)?{id:t.asset_id,original_url:studioAssetUrl(t.asset_id),thumbnail_url:studioAssetUrl(t.asset_id,true)}:null}]));
  return { ...records, recordTasks, settings: { model: settings.model, revision: settings.revision, prices: settings.prices } };
}); }
export async function POST(req: NextRequest) { return run(async owner => {
  const body = await req.json();
  if (!body || typeof body !== 'object'||Array.isArray(body)) throw new StudioError('请求无效');
  if (body.action === 'prepare') return { plan: await prepareAvatarPlan(owner, body) };
  if (body.action === 'submit') return { batchId: await submitAvatarPlan(owner, body.id) };
  if (body.action === 'restore') {
    const record = await readAvatar<AvatarRecord>(owner, 'record', body.id);
    if (!record?.candidate || record.deletedAt) throw new StudioError('人物记录已不可用');
    const original=record.planId?await readAvatar<AvatarPlan>(owner,'plan',record.planId):null;
    if(!original)throw new StudioError('原始生成参数快照已不可用，不能伪造默认参数',409);
    const task=record.taskId?await prisma.imageStudioTask.findFirst({where:{id:record.taskId,owner_id:owner}}):null;
    const snapshot=task?.snapshot_json?JSON.parse(task.snapshot_json):null;
    const plan: AvatarPlan = { ...original,id: randomUUID(), candidates: [record.candidate], ...(snapshot?{model:snapshot.model,quality:snapshot.quality,resolution:snapshot.resolution,aspectRatio:snapshot.aspectRatio,settingsRevision:snapshot.settingsRevision,unitCredits:snapshot.unitCredits,referenceIds:JSON.parse(task!.reference_ids)}:{}), createdAt: new Date().toISOString(),sourceTaskId:record.taskId,restoredFrom:record.id,warnings:['已恢复当时完整设置；原模型和参考图保留，出图前需更新报价并重新校验可用性。'] };
    await prisma.platformSetting.create({ data: { key: avatarKey(owner, 'plan', plan.id), value_json: JSON.stringify(plan), updated_by: owner } });
    return { plan,sourceTask:await sourceTask(owner,record.taskId) };
  }
  if(body.action==='quote'){
    const previous=await readAvatar<AvatarPlan>(owner,'plan',body.id);if(!previous)throw new StudioError('人物草稿不存在');
    const settings=await getImageStudioSettings();
    const model=typeof body.model==='string'?body.model:previous.model;
    if(!IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number]))throw new StudioError('原模型已不可用，请明确选择可用模型；人物草稿保留');
    const quality=typeof body.quality==='string'?body.quality:previous.quality,resolution=typeof body.resolution==='string'?body.resolution:previous.resolution;
    const price=settings.prices[model as keyof typeof settings.prices];
    if(price===undefined||price===null)throw new StudioError('原模型已失效或没有报价，历史设置仍保留');
    const api=await getImageGenerationSettingsForModel(model);
    const plan:AvatarPlan={...previous,model,quality,resolution,id:createHash('sha256').update(`quote:${owner}:${previous.id}:${settings.revision}:${model}:${quality}:${resolution}`).digest('hex'),settingsRevision:settings.revision,unitCredits:price,imageReady:isStudioImageGenerationProvider(api.provider)&&isImageGenerationApiReady(api)&&(previous.referenceIds.length?api.supports_image_to_image:api.supports_text_to_image),candidates:previous.candidates.map(c=>adaptAvatarPrompt(c,model)),createdAt:new Date().toISOString()};
    await prisma.platformSetting.upsert({where:{key:avatarKey(owner,'plan',plan.id)},create:{key:avatarKey(owner,'plan',plan.id),value_json:JSON.stringify(plan),updated_by:owner},update:{}});
    return {plan:await readAvatar<AvatarPlan>(owner,'plan',plan.id)};
  }
  if (body.action === 'retry') {
    const previous = await readAvatar<AvatarPlan>(owner, 'plan', body.id);
    if (!previous) throw new StudioError('历史批次不存在');
    const tasks = (await listStudioTasks(owner, undefined, undefined, false, undefined, previous.id)).tasks;
    if (tasks.some(t => ['queued', 'running', 'uncertain'].includes(t.status))) throw new StudioError('仍有进行中或受理未知任务，请先查询');
    const failed = tasks.filter(t => t.status === 'failed');
    if (!failed.length) throw new StudioError('没有可重试的明确失败项');
    const settings = await getImageStudioSettings();
    const plan = { ...previous, id: createHash('sha256').update(`retry:${owner}:${previous.id}`).digest('hex'), candidates: failed.map(t => previous.candidates[t.ordinal - 1]), settingsRevision: settings.revision, unitCredits: settings.prices[previous.model as keyof typeof settings.prices], createdAt: new Date().toISOString() };
    if (plan.unitCredits === null) throw new StudioError('当前模型尚未设置报价');
    await prisma.platformSetting.upsert({where:{key:avatarKey(owner,'plan',plan.id)},create:{key:avatarKey(owner,'plan',plan.id),value_json:JSON.stringify(plan),updated_by:owner},update:{}});
    return { plan:await readAvatar<AvatarPlan>(owner,'plan',plan.id) };
  }
  if (body.action === 'save' && body.record?.kind === 'config') body.record.rules = parseAvatarRules(body.record.rules);
  if (body.action === 'save' && body.record?.kind === 'character') {
    const plan = await readAvatar<AvatarPlan>(owner, 'plan', body.planId);
    const candidate = plan?.candidates[Number(body.index)];
    if (!candidate) throw new StudioError('人物草稿不存在');
    const result = (await listStudioTasks(owner, undefined, undefined, false, undefined, plan!.id)).tasks.find(task => task.ordinal === Number(body.index) + 1 && task.status === 'succeeded') || (Number(body.index)===0 ? await sourceTask(owner,plan!.sourceTaskId):null);
    if (!result?.asset || result.status !== 'succeeded') throw new StudioError('保存人物需要已完成的基准原图');
    body.record = { kind: 'character', rules:candidate.rules,candidate: { ...candidate, baselineAssetId: candidate.baselineAssetId || result.asset.id }, assetId: result.asset.id,planId:plan!.id,taskId:result.id };
  } else if (body.action === 'save' && body.record && body.record.kind !== 'config') throw new StudioError('不能新建或改写历史结果');
  return { record: await mutateAvatarRecord(owner, body) };
}); }
