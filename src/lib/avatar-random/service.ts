import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { createMuskChatCompletion, getMuskApiSettings, isMuskApiReady, MuskApiError } from '@/lib/integrations/musk';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { StudioError, submitStudioBatch } from '@/lib/image-studio/tasks';
import { IMAGE_STUDIO_MODELS, normalizeImageStudioQuality } from '@/lib/image-studio/model-catalog';
import { getImageGenerationSettingsForModel, isImageGenerationApiReady, isStudioImageGenerationProvider } from '@/lib/integrations/image-generation';
import { normalizeImageResolution } from '@/lib/image-generation/resolution';
import { catalog, identityFields } from './catalog';
import { adaptAvatarPrompt, createAvatarCandidates, emptyConstraints, parseAvatarRules } from './engine';
import { avatarKey, avatarPlanKey, avatarRecordKey, readAvatar } from './store';
import { AVATAR_COMPILER_VERSION, type AvatarConstraints, type AvatarCandidate, type AvatarPlan, type AvatarRecord } from './types';
import { descriptionSystemPrompt } from './description-contract';
import { AvatarDescriptionError, descriptionId, inspectDescription, resolveDescription, type DescriptionStore } from './description-parser';
import { avatarLayout, avatarOutputCount, withAvatarLayout, isAvatarSheet, avatarSheetLabel } from './layout';
import { avatarRulesSignature } from './intent';
import { defaultStudioReferencePolicy, validateStudioReferenceCounts } from '@/lib/image-studio/reference-policy';
import { studioVisibleAssetWhere } from '@/lib/image-studio/protected-assets';

export async function validateAvatarReferences(owner: string, ids: string[]) {
  try { validateStudioReferenceCounts(defaultStudioReferencePolicy(ids), ids, 0, 0); }
  catch (error) { throw new StudioError((error as Error).message); }
  if (!ids.length) return;
  const identity = await prisma.user.findUnique({ where: { id: owner }, select: { id: true, role: true, account_type: true, feature_profile_id: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true } });
  if (!identity) throw new StudioError('参考图已不可用或无权使用', 403);
  const count = await prisma.asset.count({ where: { id: { in: ids }, owner_id: owner, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(identity)] } });
  if (count !== new Set(ids).size) throw new StudioError('参考图已不可用或无权使用，请移除或重新选择', 403);
}

function avatarResultTitle(candidate: AvatarCandidate, layout: AvatarPlan['layout'], index: number) {
  const text = (candidate.rules.description || candidate.constraints.description || candidate.constraints.summary || '').replace(/[\r\n\t]+/g, ' ').trim();
  const brief = text.split(/[。！？!?；;]/)[0].trim();
  const title = Array.from(brief || '随机人物').slice(0, 24).join('');
  return `${title} · ${isAvatarSheet({layout}) ? avatarSheetLabel(layout) : `人物 ${index + 1}`}`;
}

function descriptionStore(owner: string, description: string): DescriptionStore {
  const id = descriptionId(description), key = avatarKey(owner, 'parse-attempt', id);
  return {
    readCache: () => readAvatar<AvatarConstraints>(owner, 'parse', id),
    readAttempt: async () => (await prisma.platformSetting.findUnique({ where: { key }, select: { value_json: true } }))?.value_json || null,
    createAttempt: async value_json => { try { await prisma.platformSetting.create({ data: { key, value_json, updated_by: owner } }); return true; }
      catch (e) { if (await prisma.platformSetting.findUnique({ where: { key }, select: { id: true } })) return false; throw e; } },
    replaceAttempt: async (expected, value_json) => (await prisma.platformSetting.updateMany({ where: { key, value_json: expected }, data: { value_json, updated_by: owner } })).count === 1,
    saveResponse: async (requestId, content) => { const responseKey = avatarKey(owner, 'parse-response', `${id}-${requestId}`); await prisma.platformSetting.upsert({ where: { key: responseKey }, create: { key: responseKey, value_json: JSON.stringify({ content }), updated_by: owner }, update: {} }); },
    readResponse: async requestId => { const row = await prisma.platformSetting.findUnique({ where: { key: avatarKey(owner, 'parse-response', `${id}-${requestId}`) }, select: { value_json: true } }); return row ? JSON.parse(row.value_json).content : null; },
    complete: (expected, value_json, parsed) => prisma.$transaction(async tx => {
      if (!(await tx.platformSetting.updateMany({ where: { key, value_json: expected }, data: { value_json, updated_by: owner } })).count) return false;
      const parsedKey = avatarKey(owner, 'parse', id);
      await tx.platformSetting.upsert({ where: { key: parsedKey }, create: { key: parsedKey, value_json: JSON.stringify(parsed), updated_by: owner }, update: { value_json: JSON.stringify(parsed), updated_by: owner } });
      return true;
    }),
  };
}
export async function avatarDescriptionStatus(owner: string, description: unknown) {
  if (typeof description !== 'string' || description.length > 3000) throw new StudioError('人物描述无效');
  return inspectDescription(description.trim(), descriptionStore(owner, description.trim()));
}
export async function parseAvatarDescription(owner: string, description: string, approved: boolean, retryToken?: string, recheck = false) {
  if (!description) return emptyConstraints();
  return resolveDescription(description, { approved, retryToken, recheck }, descriptionStore(owner, description), async () => {
    const settings = await getMuskApiSettings();
    if (!isMuskApiReady(settings)) throw new MuskApiError('描述解析服务未配置', 503, 'musk_api_not_configured');
    return createMuskChatCompletion({ settings, temperature: 0, messages: [{ role: 'system', content: descriptionSystemPrompt }, { role: 'user', content: description }] });
  });
}
export async function prepareAvatarPlan(owner: string, body: Record<string, unknown>) {
  const rules = parseAvatarRules(body.rules);
  await validateAvatarReferences(owner, rules.referenceIds || []);
  if (body.actionType !== undefined && !['new', 'styling', 'tweak'].includes(String(body.actionType))) throw new StudioError('人物操作无效');
  const previousId = typeof body.previousId === 'string' ? body.previousId : null;
  const previous = previousId ? await readAvatar<AvatarPlan>(owner, 'plan', previousId) : null;
  const index = Number(body.previousIndex || 0);
  const current = previous?.candidates[index];
  const action = body.actionType === 'styling' ? 'styling' : body.actionType === 'tweak' ? 'tweak' : 'new';
  if (action !== 'new' && (isAvatarSheet(rules) || previous && isAvatarSheet(previous))) throw new StudioError('宫格整图不是单人的身份基准。请先切换独立头像并重新报价出图，再保存人物或换造型。');
  if (action !== 'new' && !current) throw new StudioError('请先恢复一个可用的人物');
  if (action === 'tweak' && (typeof body.field !== 'string' || !(body.field in catalog) || rules.description !== current!.rules.description)) throw new StudioError('微调只修改所选字段；描述已变化，请先恢复草稿或选择换一个人');
  if (current && action!=='new' && rules.people!==current.members.length) throw new StudioError('微调或换造型不能改变人数，请选择换一个人');
  if (rules.description) {
    const parse = await avatarDescriptionStatus(owner, rules.description);
    if (parse.state !== 'succeeded') throw new AvatarDescriptionError(parse);
    if (body.descriptionId !== parse.descriptionId || body.parserVersion !== parse.parserVersion) throw new StudioError('文案分析已变化，请先查询当前分析结果；本次不调用模型', 409);
  }
  // Preparing a quote must never implicitly purchase a text-model request.
  const constraints = await parseAvatarDescription(owner, rules.description, false);
  if (constraints.members?.length && !(isAvatarSheet(rules) ? [1,rules.candidates].includes(constraints.members.length) : constraints.members.length === rules.people)) throw new StudioError('描述中的人物数量与排版不一致；宫格可指定一套共同条件或与格数相同的人物，独立图按每张人数设置');
  const settings = await getImageStudioSettings();
  const model = typeof body.model === 'string' && IMAGE_STUDIO_MODELS.includes(body.model as typeof IMAGE_STUDIO_MODELS[number]) ? body.model : settings.model;
  const quality = normalizeImageStudioQuality(model, body.quality), resolution = normalizeImageResolution(model, typeof body.resolution === 'string' ? body.resolution : '1K');
  const referenceIds: string[] = [];
  const keepIdentity=action==='styling'||action==='tweak'&&typeof body.field==='string'&&!identityFields.includes(body.field);
  if (keepIdentity) {
    const baselineId = current!.baselineAssetId || (typeof body.baselineAssetId === 'string' ? body.baselineAssetId : '');
    const source = await prisma.imageStudioTask.findFirst({ where: { owner_id: owner, asset_id: baselineId, status: 'succeeded', snapshot_json: { contains: `"characterId":"${current!.characterId}"` } } });
    const singleSource = source && !isAvatarSheet({ layout: JSON.parse(source.snapshot_json || '{}').avatarLayout });
    if (!singleSource && action==='styling') throw new StudioError('保持此人需要其已完成的独立原图参考；宫格整图不能用作单人的身份基准');
    const asset = await prisma.asset.findFirst({ where: { id: baselineId, owner_id: owner, status: 'active', type: 'image' } });
    if (!asset && action==='styling') throw new StudioError('人物原图已不可用，请重新选择');
    if (baselineId && (!singleSource || !asset)) throw new StudioError('原身份基准已不可用，人物草稿和历史仍保留；不能丢弃参考图后冒充保持同人',409);
    if(singleSource&&asset) referenceIds.push(baselineId);
  }
  const historyRows = await prisma.platformSetting.findMany({ where: { OR:['plan','sheet-plan'].map(kind=>({key:{startsWith:`avatar:v1:${owner}:${kind}:`}})) }, orderBy: { created_at: 'desc' }, take: 30 });
  const history = historyRows.flatMap(r => (JSON.parse(r.value_json) as AvatarPlan).candidates);
  let candidates = createAvatarCandidates(rules, constraints, current, action, typeof body.field === 'string' ? body.field : undefined, history);
  if (keepIdentity&&referenceIds[0]) candidates.forEach(c => c.baselineAssetId = referenceIds[0]);
  // The verified single-person baseline stays first; optional references cannot replace it.
  referenceIds.push(...(rules.referenceIds || []).filter(id => !referenceIds.includes(id)));
  await validateAvatarReferences(owner, referenceIds);
  candidates=candidates.map(c=>adaptAvatarPrompt(c,model));
  const unitCredits = settings.prices[model as keyof typeof settings.prices];
  const api = await getImageGenerationSettingsForModel(model);
  if(referenceIds.length&&!api.supports_image_to_image)throw new StudioError('当前模型通道不支持参考图，请更换模型或移除可选参考；同人基准不能自动移除');
  const imageReady=unitCredits!==null&&Number.isInteger(unitCredits)&&unitCredits>=0&&isStudioImageGenerationProvider(api.provider)&&isImageGenerationApiReady(api)&&(referenceIds.length?api.supports_image_to_image:api.supports_text_to_image);
  const plan: AvatarPlan = withAvatarLayout({ id: randomUUID(), candidates, model, quality, resolution, aspectRatio: rules.people > 1 ? '3:2' : '1:1', settingsRevision: settings.revision, unitCredits, referenceIds, createdAt: new Date().toISOString(), imageReady, imageSeedSupport:'unsupported',warnings:candidates.flatMap(c=>c.members.flatMap(d=>d.warnings||[])) }, avatarLayout(rules));
  if(isAvatarSheet(plan))plan.id=`sheet-${plan.id}`;
  await prisma.platformSetting.create({ data: { key: avatarPlanKey(owner, plan), value_json: JSON.stringify(plan), updated_by: owner } });
  return plan;
}
export async function submitAvatarPlan(owner: string, id: string, expectedLayout?: unknown, draft?: Record<string, unknown>) {
  const plan = await readAvatar<AvatarPlan>(owner, 'plan', id);
  if (!plan) throw new StudioError('人物草稿不存在', 404);
  if (!draft?.rules || avatarRulesSignature(parseAvatarRules(draft.rules)) !== avatarRulesSignature(plan.candidates[0].rules) || draft.model !== plan.model || draft.quality !== plan.quality || draft.resolution !== plan.resolution) throw new StudioError('人物条件或图片参数已变化，请重新分析或报价；不能用旧报价出图', 409);
  const layout = avatarLayout(plan), count = avatarOutputCount(plan);
  if (expectedLayout !== undefined && expectedLayout !== layout) throw new StudioError('排版已变化，请重新报价；不能按旧计划直接提交新排版', 409);
  if (isAvatarSheet({layout}) && (!plan.sheetPrompt || plan.aspectRatio !== '1:1')) throw new StudioError('宫格快照不完整，请重新准备人物');
  const settings = await getImageStudioSettings();
  const alreadyQueued = await prisma.imageStudioTask.findFirst({ where: { owner_id: owner, batch_id: createHash('sha256').update(`${owner}:${plan.id}`).digest('hex') } });
  if (!alreadyQueued && plan.candidates.some(candidate => candidate.compilerVersion !== AVATAR_COMPILER_VERSION)) throw new StudioError('人物草稿需更新报价以保留完整原描述；不用重填描述或重新分析', 409);
  if (!alreadyQueued && (plan.unitCredits===null||settings.revision !== plan.settingsRevision || settings.prices[plan.model as keyof typeof settings.prices] !== plan.unitCredits)) throw new StudioError('报价已变化，请更新报价后确认费用；人物草稿不需要重新随机', 409);
  const api = await getImageGenerationSettingsForModel(plan.model);
  if (!alreadyQueued && (!isStudioImageGenerationProvider(api.provider) || !isImageGenerationApiReady(api))) throw new StudioError('当前模型生成通道尚未就绪', 503);
  if (!alreadyQueued) await validateAvatarReferences(owner, plan.referenceIds);
  return submitStudioBatch(owner, { requestId: plan.id, prompt: isAvatarSheet({layout}) ? plan.sheetPrompt : plan.candidates[0].prompt, count, revision: plan.settingsRevision, referenceIds: plan.referenceIds, model: plan.model, quality: plan.quality, resolution: plan.resolution, aspectRatio: plan.aspectRatio }, { candidates: plan.candidates, layout, onQueued: async (tx, batchId) => {
    for (let i = 0; i < count; i++) {
      const candidate = plan.candidates[i], taskId = `${batchId}-${i}`;
      const record: AvatarRecord = { id: randomUUID(), kind: 'result', layout, name: avatarResultTitle(candidate, layout, i), revision: 1, deletedAt: null, createdAt: plan.createdAt, updatedAt: plan.createdAt, ...(isAvatarSheet({layout}) ? { sheetCandidates: plan.candidates } : { candidate }), rules: candidate.rules, planId: plan.id, taskId, qualityStatus: 'unreviewed' };
      if(isAvatarSheet({layout}))record.id=`sheet-${record.id}`;
      await tx.platformSetting.create({ data: { key: avatarRecordKey(owner, record), value_json: JSON.stringify(record), updated_by: owner } });
    }
  } });
}
