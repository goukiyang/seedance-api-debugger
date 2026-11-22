import { createHash, randomUUID } from 'node:crypto';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { getMuskApiSettings, resolveMuskChatModels, createMuskChatCompletion, type MuskChatMessage } from '@/lib/integrations/musk';
import { prepareMuskChatMessages } from '@/lib/integrations/musk-chat-images';
import { assertSupplementaryModelEnabled } from '@/lib/pricing/model-access.server';
import { readStudioImage } from '@/lib/image-studio/media';
import { privateModule } from './runtime';
import { readUiDocument, saveUiDocument, uiId } from './store';
import { registerUiImage, uiUseAsset } from './media';
import type { JsonObject } from './types';
export const uiHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function resolveUiAnalysisDirection(original: JsonObject, prepared: JsonObject, model: string, ask: (turn: JsonObject) => Promise<JsonObject>) {
  const raw = await ask(prepared.request);
  try { return await original.resolveAnalysisOutput(raw, prepared.input, model, ask); }
  catch (error) {
    const invalid = error as { code?: string; validationStage?: string; validationErrors?: string[] };
    if (invalid.code !== 'ANALYSIS_INVALID_OUTPUT' || invalid.validationStage !== 'schema') throw error;
    const corrected = await ask({
      input: [{ type: 'text', text: `上一轮 JSON 未通过字段校验。仅修正以下字段、长度或枚举问题，保留有效视觉结论、原页面功能、文案语义和已确认的共用规范。不要增加 schema 以外的字段，不要将设计冲突改成通过，也不要截断需求来通过校验。返回符合相同 schema 的完整方案。\n${JSON.stringify(invalid.validationErrors)}` }],
      outputSchema: prepared.request.outputSchema,
    });
    return original.resolveAnalysisOutput(corrected, prepared.input, model, ask);
  }
}
export async function convertUiAnalysisTurn(turn: JsonObject, owner: string, signal?: AbortSignal) {
  const messages: MuskChatMessage[] = [];
  for (const item of turn.input) {
    if (item.type === 'text') messages.push({ role: 'user', content: item.text });
    else if (item.type === 'image') messages.push(...await prepareMuskChatMessages([{ role: 'user', content: '按紧邻的图片标签及顺序分析。', images: [{ url: item.url }] }], owner, signal));
    else throw new AuthError('分析输入类型无法转换，原资料保留', 422);
  }
  return messages;
}
export async function analyzeUiDesign(user: SessionUser, data: JsonObject, outerSignal?: AbortSignal) {
  const workspaceId = uiId(data.workspaceId), workspace = await readUiDocument(user.id, 'workspace', workspaceId);
  if (workspace.archived) throw new AuthError('此设计已归档', 409);
  const settings = await getMuskApiSettings(), model = data.model;
  if (typeof model !== 'string' || !(await resolveMuskChatModels(settings)).includes(model)) throw new AuthError('请选择当前可用的分析模型，原选择保留', 409);
  await assertSupplementaryModelEnabled('text', model);
  if (!Array.isArray(data.frames) || !data.frames.length || data.frames.length > 181) throw new AuthError('界面选择无效', 400);
  const original = await privateModule('codex-design-analysis.cjs'), standards = await privateModule('design-standards.js');
  const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(360000)]) : AbortSignal.timeout(360000);
  const input = structuredClone(data); delete input.analysisId; delete input.resumeAnalysisId;
  const references = new Map<string, { assetId: string; referenceImageId?: string }>();
  for (const field of ['samples', 'structures', 'baselines']) {
    input[field] = [];
    for (const item of data[field] || []) {
      const registered = item.assetId ? await registerUiImage(user, item) : await registerUiImage(user, { dataUrl: item.dataUrl, name: item.label });
      const asset = await uiUseAsset(user, { assetId: registered.assetId, referenceImageId: item.referenceImageId });
      const url = `/uploads/ui-design-analysis-${asset.id}`;
      references.set(url, { assetId: asset.id, referenceImageId: item.referenceImageId });
      input[field].push({ ...item, assetId: asset.id, referenceImageId: item.referenceImageId, dataUrl: undefined, url, mime: asset.mime_type });
    }
  }
  const analysisId = data.resumeAnalysisId ? uiId(data.resumeAnalysisId) : data.analysisId ? uiId(data.analysisId) : randomUUID(), inputHash = uiHash(input);
  const configRevision = uiHash({ base: settings.base_url, model, allowed: settings.allowed_models });
  let record = data.resumeAnalysisId ? await readUiDocument(user.id, 'analysis', analysisId) : await saveUiDocument(user.id, 'analysis', analysisId, 0, { workspaceId, inputHash, input, model, configRevision, schemaVersion: standards.version, state: 'analyzing', parts: [] });
  if (record.data.inputHash !== inputHash || record.data.model !== model || record.data.configRevision !== configRevision) throw new AuthError('待续分析对应的输入或模型配置已变化；原部分成果保留，请发起本次新分析', 409);
  const parts: JsonObject[] = data.resumeAnalysisId ? [...record.data.parts] : [];
  try {
    for (let offset = Number(record.data.completedFrames || 0); offset < input.frames.length; offset += 3) {
      signal.throwIfAborted();
      const frames = input.frames.slice(offset, offset + 3), ids = new Set(frames.map((frame: JsonObject) => frame.id));
      const batch: JsonObject = { ...input, frames, structures: input.structures.filter((item: JsonObject) => ids.has(item.frameId)), baselines: input.baselines.filter((item: JsonObject) => ids.has(item.frameId)) };
      // Feed validated originals to the unchanged ART input contract, never URLs as image data.
      for (const field of ['samples', 'structures', 'baselines']) batch[field] = await Promise.all(batch[field].map(async (item: JsonObject) => {
        const asset = await uiUseAsset(user, { assetId: item.assetId, referenceImageId: item.referenceImageId }), bytes = await readStudioImage(asset.original_url, signal);
        return { ...item, dataUrl: `data:${asset.mime_type};base64,${bytes.toString('base64')}` };
      }));
      const prepared = original.prepareAnalysisRequest(batch);
      const history: MuskChatMessage[] = [];
      const shared = parts[0] ? { shared: parts[0].shared, artDirection: parts[0].artDirection, styleTransfer: parts[0].styleTransfer, visualSystem: parts[0].standardsReview.visualSystem } : null;
      const ask = async (turn: JsonObject) => {
        const messages = await convertUiAnalysisTurn(turn, user.id, signal);
        messages.push({ role: 'user', content: `输出必须严格符合以下 JSON schema：\n${JSON.stringify(turn.outputSchema)}${shared ? `\n整套已确认的共用方向，以下字段必须逐字保持，不允许产生第二套皮肤：\n${JSON.stringify(shared)}` : ''}` });
        history.push(...messages);
        const chars = JSON.stringify(history.map(message => ({ ...message, content: typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text') }))).length;
        if (chars > 300000) throw new AuthError('本轮及修正上下文超过分析容量；完整资料和已完成部分保留，请缩小单屏结构或需求后继续', 413);
        const turnRecord = await saveUiDocument(user.id, 'analysis-turn', randomUUID(), 0, {
          analysisId, workspaceId, batchOffset: offset, model, state: 'requested', outputSchema: turn.outputSchema,
          messages: history.map(message => ({ ...message, content: typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text') })),
          images: Object.fromEntries(['samples', 'structures', 'baselines'].map(field => [field, batch[field].map((item: JsonObject) => ({ assetId: item.assetId, referenceImageId: item.referenceImageId, frameId: item.frameId, label: item.label }))])),
        });
        record = await saveUiDocument(user.id, 'analysis', analysisId, record.revision, { ...record.data, turns: [...(record.data.turns || []), turnRecord.id] });
        let result;
        try { result = await createMuskChatCompletion({ settings, model, messages: history, jsonMode: true, timeoutMs: 120000, signal }); }
        catch (error) {
          await saveUiDocument(user.id, 'analysis-turn', turnRecord.id, turnRecord.revision, { ...turnRecord.data, state: 'incomplete', error: error instanceof Error ? error.message : '模型答复未完成' });
          throw error;
        }
        await saveUiDocument(user.id, 'analysis-turn', turnRecord.id, turnRecord.revision, { ...turnRecord.data, state: 'answered', response: result.content, usage: result.usage });
        history.push({ role: 'assistant', content: result.content });
        return JSON.parse(result.content);
      };
      const direction = await resolveUiAnalysisDirection(original, prepared, model, ask);
      if (shared && uiHash(shared) !== uiHash({ shared: direction.shared, artDirection: direction.artDirection, styleTransfer: direction.styleTransfer, visualSystem: direction.standardsReview.visualSystem })) throw new AuthError('后批分析与已确认整套视觉方向冲突，已完成分析保留；尚未提交生图', 422);
      parts.push(direction);
      record = await saveUiDocument(user.id, 'analysis', analysisId, record.revision, { ...record.data, parts, completedFrames: offset + frames.length });
    }
    const direction = structuredClone(parts[0]);
    for (const field of ['screens', 'copyPlans', 'referenceFindings']) direction[field] = field === 'referenceFindings' ? direction[field] : parts.flatMap(part => part[field] || []);
    const contract = standards.compile({ profile: data.standardsProfile, description: data.description, changes: data.changes, previousOutputLanguage: data.previousOutputLanguage, frames: data.frames });
    direction.standardsReview.contractKey = contract.key;
    direction.standardsReview.adjustments = parts.flatMap(part => part.standardsReview.adjustments);
    direction.standardsReview.checks = direction.standardsReview.checks.map((check: JsonObject) => {
      const checks = parts.map(part => part.standardsReview.checks.find((row: JsonObject) => row.ruleId === check.ruleId));
      return { ...check, frameIds: data.frames.map((frame: JsonObject) => frame.id), status: checks.some(row => row.status === 'conflict') ? 'conflict' : 'planned', application: Array.from(new Set(checks.map(row => row.application))).join('\n') };
    });
    const review = standards.validateReview(direction.standardsReview, contract);
    if (!review.valid) throw new AuthError(review.errors.join('；'), 422);
    await saveUiDocument(user.id, 'analysis', analysisId, record.revision, { ...record.data, parts, direction, state: 'ready' });
    return { direction, analysisId, inputHash };
  } catch (error) {
    await saveUiDocument(user.id, 'analysis', analysisId, record.revision, { ...record.data, parts, state: signal.aborted ? 'interrupted' : 'incomplete', error: error instanceof Error ? error.message : '分析未完成' });
    throw Object.assign(error as object, { analysisId, completedFrames: record.data.completedFrames || 0,
      ...((error as { code?: string }).code === 'ANALYSIS_INVALID_OUTPUT' ? { status: 422 } : {}) });
  }
}
