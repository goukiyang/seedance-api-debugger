import { createHash, randomUUID } from 'node:crypto';
import type { AvatarConstraints } from './types';
import { decodeDescriptionOutput, DescriptionContractError, originalDescriptionConstraints, validateDescriptionConstraints } from './description-contract';
import { intentIssues, intentView } from './intent';
import { AVATAR_PARSER_VERSION } from './types';

export type DescriptionDiagnostics = { code?: string; phase?: string; timeoutMs?: number; elapsedMs?: number; headersMs?: number; bodyMs?: number; httpStatus?: number; upstreamRequestId?: string; networkCode?: string };
export type DescriptionStatus = { descriptionId: string; parserVersion?: string; constraints?: AvatarConstraints; understanding?: ReturnType<typeof intentView>; state: 'not-started' | 'pending' | 'succeeded' | 'needs-clarification' | 'failed' | 'unknown'; message: string; canRecheck: boolean; canContinueOriginal?: boolean; diagnostics?: DescriptionDiagnostics; retryToken?: string; requestId?: string; failure?: { code: string; stage: string; field?: string }; cost: 'not-started' | 'unknown' | 'response-received' };
type Attempt = { version: 2; parserVersion?: string; requestId: string; state: 'pending' | 'received' | 'succeeded' | 'failed' | 'unknown'; createdAt: string; updatedAt: string; responseId?: string; failure?: DescriptionStatus['failure']; diagnostics?: DescriptionDiagnostics; cost: DescriptionStatus['cost'] };
const DESCRIPTION_ERROR_CODES = new Set(['musk_api_not_configured', 'musk_api_upstream_error', 'musk_api_invalid_response', 'musk_api_empty_content', 'musk_api_timeout', 'musk_api_request_failed']);
const DESCRIPTION_NETWORK_CODE = /^(?:UND_ERR_[A-Z_]+|E(?:CONNRESET|CONNREFUSED|TIMEDOUT|AI_AGAIN|NOTFOUND))$/;
const DESCRIPTION_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARSER_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
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
export const isLegalDescriptionRequestId = (value: unknown): value is string => typeof value === 'string' && DESCRIPTION_REQUEST_ID.test(value);
export const isLegalAvatarParserVersion = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && PARSER_VERSION.test(value);
export function safeDescriptionDiagnostics(error: unknown): DescriptionDiagnostics {
  const value = error && typeof error === 'object' ? error as { code?: unknown; diagnostics?: unknown } : null;
  const source = value?.diagnostics && typeof value.diagnostics === 'object' && !Array.isArray(value.diagnostics)
    ? value.diagnostics as Record<string, unknown> : {};
  const result: DescriptionDiagnostics = {};
  for (const key of ['timeoutMs', 'elapsedMs', 'headersMs', 'bodyMs'] as const) {
    const number = source[key];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 && number <= 86400000) result[key] = number;
  }
  if (typeof source.httpStatus === 'number' && Number.isSafeInteger(source.httpStatus) && source.httpStatus >= 100 && source.httpStatus <= 599) result.httpStatus = source.httpStatus;
  if (typeof value?.code === 'string' && DESCRIPTION_ERROR_CODES.has(value.code)) result.code = value.code;
  if (['awaiting_headers', 'reading_body', 'parsing', 'completed'].includes(String(source.phase))) result.phase = String(source.phase);
  if (typeof source.upstreamRequestId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(source.upstreamRequestId)) result.upstreamRequestId = source.upstreamRequestId;
  if (typeof source.networkCode === 'string' && DESCRIPTION_NETWORK_CODE.test(source.networkCode)) result.networkCode = source.networkCode;
  return result;
}
export function originalDescriptionAttempt(raw: string | null, now = Date.now()) {
  if (!raw) return null;
  const attempt = readAttempt(raw);
  if (attempt.version !== 2 || !isLegalDescriptionRequestId(attempt.requestId)
    || typeof attempt.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(attempt.createdAt)) return null;
  const createdAt = Date.parse(attempt.createdAt), parserVersion = attempt.parserVersion === undefined ? AVATAR_PARSER_VERSION : attempt.parserVersion;
  if (!Number.isFinite(createdAt) || createdAt > now || attempt.cost !== 'unknown' || attempt.responseId !== undefined
    || !isLegalAvatarParserVersion(parserVersion)
    || !(attempt.state === 'unknown' || attempt.state === 'pending' && now - createdAt >= 120000)) return null;
  return { requestId: attempt.requestId, parserVersion };
}
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
  if (a?.requestId && await store.readResponse(a.responseId || a.requestId) !== null) return { ...state, canRecheck: true, cost: 'response-received' as const, message: '已保存文字模型回复，可免费重新检查；没有提交人物图片任务。',
    ...(a.diagnostics ? { diagnostics: safeDescriptionDiagnostics({ diagnostics: a.diagnostics, code: a.diagnostics.code }) } : {}) };
  const original = originalDescriptionAttempt(raw, now);
  return { ...state, ...(original && state.state === 'unknown' ? { canContinueOriginal: true, parserVersion: original.parserVersion } : {}),
    ...(a?.diagnostics ? { diagnostics: safeDescriptionDiagnostics({ diagnostics: a.diagnostics, code: a.diagnostics.code }) } : {}) };
}
function cachedConstraints(value: AvatarConstraints, description: string) {
  try { return validateDescriptionConstraints(value, description); }
  catch (e) {
    if (!(e instanceof DescriptionContractError)) throw e;
    return originalDescriptionConstraints(description);
  }
}
function understoodStatus(description: string, parsed: AvatarConstraints): DescriptionStatus {
  const issues = intentIssues(parsed);
  return { descriptionId: descriptionId(description), parserVersion: AVATAR_PARSER_VERSION, constraints: parsed, understanding: intentView(parsed), state: issues.length ? 'needs-clarification' : 'succeeded', canRecheck: false, cost: 'response-received', message: issues.length ? `有相互冲突的条件：${issues.join('；')}` : parsed.interpretation === 'original' ? '将按原描述生成，不需要按固定格式补填；本次不重复调用文字模型。' : '将按你的描述生成，未指定的外观自动补齐；补充条件可选。' };
}
export async function inspectDescription(description: string, store: DescriptionStore, now = Date.now()): Promise<DescriptionStatus> {
  const cached = await store.readCache();
  if (cached) return understoodStatus(description, cachedConstraints(cached, description));
  return receiptState(descriptionId(description), await store.readAttempt(), store, now);
}

export async function resolveDescription(description: string, options: { approved: boolean; retryToken?: string; recheck?: boolean }, store: DescriptionStore, call: () => Promise<{ content: string }>): Promise<AvatarConstraints> {
  const id = descriptionId(description), cached = await store.readCache();
  if (cached) return cachedConstraints(cached, description);
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
      const failed: Attempt = { ...attempt, ...(hasReceipt ? { responseId: attempt.requestId } : {}), diagnostics: safeDescriptionDiagnostics(e), state: definitive ? 'failed' : 'unknown', updatedAt: new Date().toISOString(), cost: hasReceipt ? 'response-received' : upstream.code === 'musk_api_not_configured' ? 'not-started' : 'unknown', failure: { code: definitive ? 'model_request_rejected' : 'model_receipt_unknown', stage: hasReceipt ? 'persistence' : 'model-request' } };
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
    if (!(e instanceof DescriptionContractError)) throw e;
    // A saved reply with an incompatible schema must not force the user to rewrite.
    // Keep that receipt, ignore unvalidated fields, and forward the original intent.
    parsed = originalDescriptionConstraints(description);
  }
  try {
    const next = JSON.stringify({ ...attempt, responseId: attempt.responseId || attempt.requestId, cost: 'response-received', state: 'succeeded', failure: undefined, updatedAt: new Date().toISOString() });
    if (!await store.complete(raw!, next, parsed)) {
      const existing = await store.readCache();
      if (existing) return cachedConstraints(existing, description);
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
