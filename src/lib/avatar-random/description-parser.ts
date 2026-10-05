import { createHash, randomUUID } from 'node:crypto';
import type { AvatarConstraints } from './types';
import { decodeDescriptionOutput, DescriptionContractError, validateDescriptionConstraints } from './description-contract';
import { intentIssues, intentView } from './intent';
import { AVATAR_PARSER_VERSION } from './types';

export type DescriptionStatus = { descriptionId: string; parserVersion?: string; constraints?: AvatarConstraints; understanding?: ReturnType<typeof intentView>; state: 'not-started' | 'pending' | 'succeeded' | 'needs-clarification' | 'failed' | 'unknown'; message: string; canRecheck: boolean; retryToken?: string; requestId?: string; failure?: { code: string; stage: string; field?: string }; cost: 'not-started' | 'unknown' | 'response-received' };
type Attempt = { version: 2; parserVersion?: string; requestId: string; state: 'pending' | 'received' | 'succeeded' | 'failed' | 'unknown'; createdAt: string; updatedAt: string; responseId?: string; failure?: DescriptionStatus['failure']; cost: DescriptionStatus['cost'] };
export type DescriptionStore = {
  readCache(): Promise<AvatarConstraints | null>;
  readAttempt(): Promise<string | null>;
  createAttempt(value: string): Promise<boolean>;
  replaceAttempt(expected: string, value: string): Promise<boolean>;
  saveResponse(id: string, content: string): Promise<void>;
  readResponse(id: string): Promise<string | null>;
  complete(expected: string, value: string, parsed: AvatarConstraints): Promise<boolean>;
};
export class AvatarDescriptionError extends Error {
  constructor(public readonly parse: DescriptionStatus, public readonly status = 409) { super(parse.message); }
}
export const descriptionId = (description: string) => createHash('sha256').update(`parser-1.0.0:${description}`).digest('hex');
const token = (raw: string) => createHash('sha256').update(raw).digest('hex');
function readAttempt(raw: string): Partial<Attempt> { try { return JSON.parse(raw) || {}; } catch { return {}; } }
function statusFor(id: string, raw: string | null, now: number): DescriptionStatus {
  if (!raw) return { descriptionId: id, state: 'not-started', message: '尚未解析描述，尚未提交图片任务。', canRecheck: false, cost: 'not-started' };
  const a = readAttempt(raw);
  const pending = a.state === 'pending' && Number.isFinite(Date.parse(a.createdAt || '')) && now - Date.parse(a.createdAt!) < 120000;
  if (pending) return { descriptionId: id, state: 'pending', message: '正在解析人物描述，尚未提交图片任务；查询不会重新调用模型。', canRecheck: false, requestId: a.requestId, cost: 'unknown' };
  const unknown = a.version !== 2 || a.state === 'pending' || a.state === 'unknown' || a.state === 'received' || a.state === 'succeeded';
  return { descriptionId: id, state: unknown ? 'unknown' : 'failed', canRecheck: !!a.responseId, requestId: a.requestId, ...(!unknown && !a.responseId ? { retryToken: token(raw) } : {}), cost: a.cost || 'unknown', failure: a.failure,
    message: unknown ? '上次描述解析的结果未确认，不能确定是否已产生文字模型费用；没有提交人物图片任务。'
      : a.responseId ? '文字模型已经回复，但人物要求尚未通过校验。原回复已保留，可重新检查，不调用模型。'
        : '文字模型请求已返回失败，尚未提交图片任务；不能据此保证上次没有产生模型费用。' };
}
async function receiptState(id: string, raw: string | null, store: DescriptionStore, now = Date.now()) {
  const state = statusFor(id, raw, now), a = raw ? readAttempt(raw) : null;
  if (a?.requestId && await store.readResponse(a.responseId || a.requestId) !== null) return { ...state, canRecheck: true, cost: 'response-received' as const, message: '已保存文字模型回复，可免费重新检查；没有提交人物图片任务。' };
  return state;
}
export async function inspectDescription(description: string, store: DescriptionStore, now = Date.now()): Promise<DescriptionStatus> {
  const cached = await store.readCache();
  if (cached) {
    try { const parsed = validateDescriptionConstraints(cached, description), issues = intentIssues(parsed); return { descriptionId: descriptionId(description), parserVersion: AVATAR_PARSER_VERSION, constraints: parsed, understanding: intentView(parsed), state: issues.length ? 'needs-clarification' : 'succeeded', canRecheck: issues.length > 0, cost: 'response-received', message: issues.length ? '已理解部分要求，还有条件需要补充或调整；原回复保留，不会自动再次调用模型。' : '文案已分析，可以生成；快捷条件和锁会一起核对，不再次调用文字模型。' }; }
    catch (e) { return { ...(await receiptState(descriptionId(description), await store.readAttempt(), store, now)), descriptionId: descriptionId(description), state: 'failed', cost: 'response-received', message: '已有解析不符合当前校验要求，原内容保留；不会自动重新调用模型。', failure: { code: 'cached_contract_invalid', stage: 'validation', ...(e instanceof DescriptionContractError ? { field: e.field } : {}) } }; }
  }
  return receiptState(descriptionId(description), await store.readAttempt(), store, now);
}

export async function resolveDescription(description: string, options: { approved: boolean; retryToken?: string; recheck?: boolean }, store: DescriptionStore, call: () => Promise<{ content: string }>): Promise<AvatarConstraints> {
  const id = descriptionId(description), cached = await store.readCache();
  if (cached) {
    try { return validateDescriptionConstraints(cached, description); }
    catch (e) { if (!options.retryToken && !options.recheck) throw new AvatarDescriptionError({ ...(await inspectDescription(description, store)), message: `已有解析无法确认：${e instanceof Error ? e.message : '格式无效'}。原内容保留，不重新收费调用。` }, 422); }
  }
  let raw = await store.readAttempt();
  const state = await receiptState(id, raw, store);
  if (options.retryToken !== undefined && (!options.approved || state.state === 'pending' || state.state === 'unknown' || state.canRecheck || options.retryToken !== state.retryToken)) throw new AvatarDescriptionError(state);
  if (!options.retryToken && raw) {
    if (!state.canRecheck) throw new AvatarDescriptionError(state);
  }
  if (options.recheck && !state.canRecheck) throw new AvatarDescriptionError({ ...state, message: '没有已保存的模型回复可检查；本次未调用模型。' });
  if (!raw || options.retryToken) {
    if (!options.approved || options.recheck) throw new AvatarDescriptionError(state, 400);
    const time = new Date().toISOString();
    const attempt: Attempt = { version: 2, parserVersion: AVATAR_PARSER_VERSION, requestId: randomUUID(), state: 'pending', createdAt: time, updatedAt: time, cost: 'unknown' };
    const next = JSON.stringify(attempt);
    const claimed = raw ? await store.replaceAttempt(raw, next) : await store.createAttempt(next);
    if (!claimed) throw new AvatarDescriptionError(statusFor(id, await store.readAttempt(), Date.now()));
    raw = next;
    try {
      const result = await call();
      if (result.content.length > 262144) throw new DescriptionContractError('response', '模型回复过长，不能安全保存完整回复');
      await store.saveResponse(attempt.requestId, result.content);
      const received: Attempt = { ...attempt, state: 'received', responseId: attempt.requestId, cost: 'response-received', updatedAt: new Date().toISOString() };
      const receivedRaw = JSON.stringify(received);
      if (!await store.replaceAttempt(raw, receivedRaw)) throw new AvatarDescriptionError(await receiptState(id, await store.readAttempt(), store));
      raw = receivedRaw;
    } catch (e) {
      if (e instanceof AvatarDescriptionError) throw e;
      const upstream = e as { code?: string; status?: number };
      const definitive = upstream.code === 'musk_api_not_configured' || upstream.code === 'musk_api_upstream_error' && Number(upstream.status) < 500;
      const hasReceipt = await store.readResponse(attempt.requestId) !== null;
      const failed: Attempt = { ...attempt, ...(hasReceipt ? { responseId: attempt.requestId } : {}), state: definitive ? 'failed' : 'unknown', updatedAt: new Date().toISOString(), cost: hasReceipt ? 'response-received' : upstream.code === 'musk_api_not_configured' ? 'not-started' : 'unknown', failure: { code: definitive ? 'model_request_rejected' : 'model_receipt_unknown', stage: hasReceipt ? 'persistence' : 'model-request' } };
      await store.replaceAttempt(raw, JSON.stringify(failed));
      throw new AvatarDescriptionError(await receiptState(id, await store.readAttempt(), store), 503);
    }
  }
  const attempt = readAttempt(raw!) as Attempt;
  const output = attempt.requestId ? await store.readResponse(attempt.responseId || attempt.requestId) : null;
  if (output === null) throw new AvatarDescriptionError({ ...statusFor(id, raw, Date.now()), canRecheck: false, state: 'unknown', message: '模型回复未能保存或已不可读取，费用结果未确认；不会自动再调用。' }, 503);
  let parsed: AvatarConstraints;
  try {
    parsed = validateDescriptionConstraints(decodeDescriptionOutput(output), description, attempt.parserVersion === AVATAR_PARSER_VERSION || attempt.parserVersion === '1.1.0');
  } catch (e) {
    if (e instanceof AvatarDescriptionError) throw e;
    const field = e instanceof DescriptionContractError ? e.field : 'response';
    const failed: Attempt = { ...attempt, responseId: attempt.responseId || attempt.requestId, cost: 'response-received', state: 'failed', updatedAt: new Date().toISOString(), failure: { code: 'description_contract_invalid', stage: 'validation', field } };
    await store.replaceAttempt(raw!, JSON.stringify(failed));
    const info = statusFor(id, await store.readAttempt(), Date.now());
    throw new AvatarDescriptionError({ ...info, message: `描述解析未通过校验：${e instanceof DescriptionContractError ? e.message : '回复无法确认'}（${field}）。原回复与草稿保留，可免费重新检查；没有提交图片任务。` }, 422);
  }
  try {
    const next = JSON.stringify({ ...attempt, responseId: attempt.responseId || attempt.requestId, cost: 'response-received', state: 'succeeded', failure: undefined, updatedAt: new Date().toISOString() });
    if (!await store.complete(raw!, next, parsed)) {
      const existing = await store.readCache();
      if (existing) return validateDescriptionConstraints(existing, description);
      throw new AvatarDescriptionError(await receiptState(id, await store.readAttempt(), store));
    }
    return parsed;
  } catch (e) {
    if (e instanceof AvatarDescriptionError) throw e;
    const uncertain = JSON.stringify({ ...attempt, state: 'unknown', responseId: attempt.responseId || attempt.requestId, cost: 'response-received', updatedAt: new Date().toISOString(), failure: { code: 'description_save_unconfirmed', stage: 'persistence' } });
    try { await store.replaceAttempt(raw!, uncertain); } catch { /* A failed store cannot confirm a terminal write; the saved receipt is still reusable. */ }
    throw new AvatarDescriptionError({ ...(await receiptState(id, await store.readAttempt(), store)), state: 'unknown', failure: { code: 'description_save_unconfirmed', stage: 'persistence' }, message: '解析结果保存尚未确认，原回复仍保留，可免费重检；本次未提交图片。' }, 503);
  }
}
