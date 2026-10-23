import { IMAGE_STUDIO_MODELS } from './model-catalog';
import { normalizeStudioRatio } from './ratios';

/** Browser-safe DTO and positive allowlists. Never keep supplier free text. */
export const STUDIO_PROVIDER_ERROR_SCHEMA = 'image.provider-error.v1' as const;
export const MAX_PROVIDER_ERROR_EVENTS = 16;
export const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
export const MAX_PROVIDER_ERROR_EVENT_BYTES = 4 * 1024;
const MAX_COUNT = 1_000_000;
export type StudioProviderErrorPhase = 'initial_request' | 'summary' | 'result' | 'download' | 'validation';
export type StudioProviderErrorBinding = {
  taskId: string; ownerId: string; fingerprint: string; channelId: string | null; configRevision: string | null;
  localRequestId: string | null; providerTaskId: string | null;
};
export type StudioProviderErrorRequest = {
  dispatchObserved: boolean; endpointKind: 'generations' | 'edits' | 'generateContent' | null;
  protocol: 'openai_images' | 'gemini_native' | null; model: string | null; sentModel: string | null;
  quality: string | null; size: string | null; ratio: string | null; n: number | null; referenceCount: number | null;
};
export type StudioProviderErrorFrozen = {
  model: string | null; resolution: string | null; requestedRatio: string | null; resolvedRatio: string | null; expectedSize: string | null;
};
export type StudioProviderErrorEvent = {
  phase: StudioProviderErrorPhase; observedAt: string; lastObservedAt: string; occurrences: number; dispatchObserved: boolean;
  transportHttpStatus: number | null; providerStatus: string | null; providerReasonCode: string | null;
  providerCauseConfirmed: boolean | null; providerErrorStage: string | null;
  attempt: number | null; imageRetryCount: number | null; recoveryCount: number | null; clientDropped: boolean | null;
  localCode: string | null; expectedSize: string | null; actualWidth: number | null; actualHeight: number | null;
  identityEvidence: 'verified' | 'not_independently_verified' | 'conflict' | 'not_applicable';
  bodyRead: 'valid_json' | 'invalid_json' | 'empty_body' | 'oversize' | 'timeout' | 'read_error' | 'not_read';
  unknownFields: Array<{ field: 'code' | 'type' | 'message'; present: true; length: number | null;
    recognition: 'unrecognized'; disposition: 'omitted_for_privacy' }>;
  summarySource: 'server_dictionary'; summary: string;
};
export type StudioProviderErrorDiagnostics = {
  schema: typeof STUDIO_PROVIDER_ERROR_SCHEMA; binding: StudioProviderErrorBinding; frozen: StudioProviderErrorFrozen;
  request: StudioProviderErrorRequest; firstObservedAt: string; lastObservedAt: string;
  eventCount: number; omittedEvents: number; events: StudioProviderErrorEvent[];
};
export type StudioProviderErrorObservation = { request: StudioProviderErrorRequest; event: StudioProviderErrorEvent; onlyIfRecorded?: boolean; omittedEvents?: number };
export type StudioProviderErrorReadResult = {
  state: 'recorded' | 'not_collected' | 'unavailable'; diagnostics: StudioProviderErrorDiagnostics | null;
};
const PHASES = ['initial_request', 'summary', 'result', 'download', 'validation'];
const STATUSES = ['pending', 'queued', 'dispatching', 'running', 'processing', 'success', 'failed', 'uncertain', 'client_disconnected', 'paused', 'canceled'];
const STAGES = ['request', 'response', 'download', 'validation', 'dispatch', 'generation', 'result', 'service', 'upstream'];
const LOCAL_CODES = ['http_error', 'timeout', 'network', 'empty_response', 'invalid_or_oversize_response', 'async_receipt_invalid',
  'async_receipt_storage_required', 'async_query_interrupted', 'async_task_identity_conflict', 'async_failed', 'async_unconfirmed',
  'async_query_unconfirmed', 'empty_output', 'unexpected_count', 'image_too_large', 'unsupported_output', 'response_evidence_unavailable',
  'download_unsafe_url', 'download_http_error', 'download_size_limit', 'download_incomplete', 'download_invalid_or_unreadable',
  'download_timeout', 'download_network', 'download_recovery_limit', 'download_content_type', 'download_empty',
  'download_total_timeout', 'download_aborted', 'download_dns_failed', 'download_tls_failed', 'download_network_failed',
  'download_invalid_url', 'download_dns_timeout', 'download_unsafe_address', 'download_redirect_limit', 'download_body_timeout',
  'download_connect_timeout', 'download_headers_timeout',
  'generated_dimensions_mismatch', 'generated_format_mismatch', 'generated_image_decode_failed', 'generated_input_size_limit',
  'generated_png_size_limit', 'generated_alpha_missing', 'generated_transparency_missing'];
const BODY_READS = ['valid_json', 'invalid_json', 'empty_body', 'oversize', 'timeout', 'read_error', 'not_read'];
export function providerErrorObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
  catch { return false; }
}
function own(value: Record<string, unknown>, key: string) {
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
function member(value: unknown, allowed: readonly string[]) { return typeof value === 'string' && allowed.includes(value) ? value : null; }
function int(value: unknown, maximum = MAX_COUNT) { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null; }
function bool(value: unknown) { return typeof value === 'boolean' ? value : null; }
export function providerErrorId(value: unknown) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(value) ? value : null; }
function model(value: unknown) { return member(value, IMAGE_STUDIO_MODELS); }
function size(value: unknown) { return typeof value === 'string' && /^(?:[1-9]\d{1,4}x[1-9]\d{1,4}|(?:0\.5|[124])K)$/.test(value) ? value : null; }
function ratio(value: unknown) {
  if (typeof value !== 'string' || value.length > 30 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try { const normalized = normalizeStudioRatio(value);
    return /^(?:auto|[1-9]\d{0,4}:[1-9]\d{0,4})$/.test(normalized) ? normalized : null;
  } catch { return null; }
}
function timestamp(value: unknown) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null; }
export function providerErrorReason(value: unknown) {
  return typeof value === 'string' && (/^service_http_[1-5]\d\d$/.test(value) || value === 'result_uncertain') ? value : null;
}
export function sanitizeStudioProviderErrorRequest(value: unknown): StudioProviderErrorRequest {
  const input = providerErrorObject(value) ? value : {};
  const dispatched = input.dispatchObserved === true;
  return { dispatchObserved: dispatched, endpointKind: member(input.endpointKind, ['generations', 'edits', 'generateContent']) as StudioProviderErrorRequest['endpointKind'],
    protocol: member(input.protocol, ['openai_images', 'gemini_native']) as StudioProviderErrorRequest['protocol'],
    model: model(input.model), sentModel: dispatched ? model(input.sentModel) : null,
    quality: dispatched ? member(input.quality, ['omitted', 'auto', 'low', 'medium', 'high', 'xhigh', 'standard', 'hd', 'max']) : null,
    size: dispatched ? size(input.size) : null, ratio: dispatched ? ratio(input.ratio) : null,
    n: dispatched && typeof input.n === 'number' && input.n >= 1 ? int(input.n, 8) : null, referenceCount: dispatched ? int(input.referenceCount, 32) : null };
}
export function sanitizeStudioProviderErrorFrozen(value: unknown): StudioProviderErrorFrozen {
  const input = providerErrorObject(value) ? value : {};
  return { model: model(input.model), resolution: member(input.resolution, ['0.5K', '1K', '2K', '4K']), requestedRatio: ratio(input.requestedRatio),
    resolvedRatio: ratio(input.resolvedRatio), expectedSize: size(input.expectedSize) };
}
function summary(event: Pick<StudioProviderErrorEvent, 'providerReasonCode' | 'localCode' | 'identityEvidence' | 'providerStatus'>) {
  if (event.identityEvidence === 'conflict') return '供应商返回的编号与原任务不一致，未将该正文归入原任务。';
  if (event.providerReasonCode?.startsWith('service_http_')) return `供应商声明内部服务返回 HTTP ${event.providerReasonCode.slice(-3)}；具体原因尚未证实。`;
  if (event.providerReasonCode === 'result_uncertain') return '供应商声明结果尚未确认；费用结论仍须按原账单核对。';
  if (event.localCode === 'generated_dimensions_mismatch') return '返图尺寸与请求不符；原图可用性和费用沿原流程处理。';
  if (event.localCode === 'generated_format_mismatch') return '返图格式与请求不符；原图和费用沿原流程处理。';
  if (event.providerStatus === 'success') return '供应商最新状态为成功；返图校验和费用仍沿原流程确认。';
  return event.providerStatus === 'failed' ? '供应商状态为失败，未取得可识别的具体原因。'
    : '已记录安全诊断；具体原因尚未证实。';
}
/** Only exact, reviewed enum fields are read, including inside safe_error. No arbitrary message survives. */
export function buildStudioProviderErrorEvent(input: {
  phase: StudioProviderErrorPhase; dispatchObserved: boolean; payload?: unknown; observedAt?: string;
  transportHttpStatus?: unknown; localCode?: unknown; identityEvidence?: StudioProviderErrorEvent['identityEvidence'];
  bodyRead?: StudioProviderErrorEvent['bodyRead']; expectedSize?: unknown; actualWidth?: unknown; actualHeight?: unknown;
}): StudioProviderErrorEvent {
  const root = providerErrorObject(input.payload) ? input.payload : {};
  const nested = providerErrorObject(own(root, 'safe_error')) ? own(root, 'safe_error') as Record<string, unknown>
    : providerErrorObject(own(root, 'error')) ? own(root, 'error') as Record<string, unknown> : {};
  const field = (key: string) => own(nested, key) ?? own(root, key);
  const observedAt = timestamp(input.observedAt) || new Date().toISOString();
  const event: StudioProviderErrorEvent = { phase: input.phase, observedAt, lastObservedAt: observedAt, occurrences: 1,
    dispatchObserved: input.dispatchObserved, transportHttpStatus: typeof input.transportHttpStatus === 'number' && input.transportHttpStatus >= 100 ? int(input.transportHttpStatus, 599) : null,
    providerStatus: member(own(root, 'status'), STATUSES), providerReasonCode: providerErrorReason(field('reason_code')),
    providerCauseConfirmed: bool(field('cause_confirmed')), providerErrorStage: member(field('error_stage') ?? field('stage'), STAGES),
    attempt: int(field('attempt')), imageRetryCount: int(field('image_retry_count')), recoveryCount: int(field('recovery_count')),
    clientDropped: bool(field('client_dropped')), localCode: member(input.localCode, LOCAL_CODES), expectedSize: size(input.expectedSize),
    actualWidth: int(input.actualWidth, 100000), actualHeight: int(input.actualHeight, 100000),
    identityEvidence: input.identityEvidence || 'not_applicable', bodyRead: input.bodyRead || 'not_read', unknownFields: [],
    summarySource: 'server_dictionary', summary: '' };
  for (const name of ['code', 'type', 'message'] as const) {
    const value = field(name);
    if (value !== undefined) event.unknownFields.push({ field: name, present: true,
      length: typeof value === 'string' ? Math.min(MAX_COUNT, value.length) : null,
      recognition: 'unrecognized', disposition: 'omitted_for_privacy' });
  }
  if (field('reason_code') !== undefined && !event.providerReasonCode && !event.unknownFields.some(value => value.field === 'code')) {
    const value = field('reason_code'); event.unknownFields.push({ field: 'code', present: true,
      length: typeof value === 'string' ? Math.min(MAX_COUNT, value.length) : null, recognition: 'unrecognized', disposition: 'omitted_for_privacy' });
  }
  event.summary = summary(event); return event;
}
function sanitizeEvent(value: unknown): StudioProviderErrorEvent | null {
  if (!providerErrorObject(value) || !member(value.phase, PHASES) || !timestamp(value.observedAt)
    || !timestamp(value.lastObservedAt) || !int(value.occurrences) || typeof value.dispatchObserved !== 'boolean'
    || !member(value.identityEvidence, ['verified', 'not_independently_verified', 'conflict', 'not_applicable']) || !member(value.bodyRead, BODY_READS)) return null;
  const event = buildStudioProviderErrorEvent({ phase: value.phase as StudioProviderErrorPhase, dispatchObserved: value.dispatchObserved,
    observedAt: value.observedAt as string, transportHttpStatus: value.transportHttpStatus, localCode: value.localCode,
    expectedSize: value.expectedSize, actualWidth: value.actualWidth, actualHeight: value.actualHeight,
    identityEvidence: value.identityEvidence as StudioProviderErrorEvent['identityEvidence'], bodyRead: value.bodyRead as StudioProviderErrorEvent['bodyRead'] });
  event.providerStatus = member(value.providerStatus, STATUSES); event.providerReasonCode = providerErrorReason(value.providerReasonCode);
  event.providerCauseConfirmed = bool(value.providerCauseConfirmed); event.providerErrorStage = member(value.providerErrorStage, STAGES);
  event.attempt = int(value.attempt); event.imageRetryCount = int(value.imageRetryCount); event.recoveryCount = int(value.recoveryCount);
  event.clientDropped = bool(value.clientDropped); event.occurrences = value.occurrences as number; event.lastObservedAt = value.lastObservedAt as string;
  if (!Array.isArray(value.unknownFields) || value.unknownFields.length > 3) return null;
  for (const field of value.unknownFields) {
    if (!providerErrorObject(field) || !member(field.field, ['code', 'type', 'message']) || field.present !== true
      || field.recognition !== 'unrecognized' || field.disposition !== 'omitted_for_privacy' || (field.length !== null && int(field.length) === null)) return null;
    event.unknownFields.push({ field: field.field as 'code' | 'type' | 'message', present: true, length: int(field.length),
      recognition: 'unrecognized', disposition: 'omitted_for_privacy' });
  }
  event.summary = summary(event); return new TextEncoder().encode(JSON.stringify(event)).length <= MAX_PROVIDER_ERROR_EVENT_BYTES ? event : null;
}
export function sameStudioProviderErrorBinding(a: StudioProviderErrorBinding, b: StudioProviderErrorBinding) {
  return a.taskId === b.taskId && a.ownerId === b.ownerId && a.fingerprint === b.fingerprint && a.channelId === b.channelId
    && a.configRevision === b.configRevision && a.localRequestId === b.localRequestId
    && (a.providerTaskId === null || b.providerTaskId === null || a.providerTaskId === b.providerTaskId);
}
/** Reconstruct every field on read; corrupt/extra supplier fields never reach an API projection. */
export function parseStudioProviderErrorDiagnostics(raw: string, expected: StudioProviderErrorBinding): StudioProviderErrorDiagnostics | null {
  if (raw.length > MAX_PROVIDER_ERROR_BYTES || new TextEncoder().encode(raw).length > MAX_PROVIDER_ERROR_BYTES) return null;
  let value: unknown; try { value = JSON.parse(raw); } catch { return null; }
  if (!providerErrorObject(value) || value.schema !== STUDIO_PROVIDER_ERROR_SCHEMA || !providerErrorObject(value.binding)) return null;
  const b = value.binding;
  if (!providerErrorId(b.taskId) || !providerErrorId(b.ownerId) || typeof b.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(b.fingerprint)) return null;
  for (const key of ['channelId', 'configRevision', 'localRequestId', 'providerTaskId']) if (b[key] !== null && !providerErrorId(b[key])) return null;
  const binding: StudioProviderErrorBinding = { taskId: b.taskId as string, ownerId: b.ownerId as string, fingerprint: b.fingerprint,
    channelId: b.channelId as string | null, configRevision: b.configRevision as string | null, localRequestId: b.localRequestId as string | null,
    providerTaskId: b.providerTaskId as string | null };
  if (!sameStudioProviderErrorBinding(binding, expected) || !Array.isArray(value.events) || !value.events.length
    || value.events.length > MAX_PROVIDER_ERROR_EVENTS || !timestamp(value.firstObservedAt) || !timestamp(value.lastObservedAt)
    || !int(value.eventCount) || int(value.omittedEvents) === null) return null;
  const events = value.events.map(sanitizeEvent); if (events.some(event => !event)) return null;
  return { schema: STUDIO_PROVIDER_ERROR_SCHEMA, binding, frozen: sanitizeStudioProviderErrorFrozen(value.frozen),
    request: sanitizeStudioProviderErrorRequest(value.request), firstObservedAt: value.firstObservedAt as string,
    lastObservedAt: value.lastObservedAt as string, eventCount: value.eventCount as number, omittedEvents: value.omittedEvents as number,
    events: events as StudioProviderErrorEvent[] };
}
export function studioProviderErrorEventKey(event: StudioProviderErrorEvent) {
  return JSON.stringify([event.phase, event.transportHttpStatus, event.providerStatus, event.providerReasonCode, event.localCode, event.identityEvidence]);
}
export function mergeStudioProviderErrorDiagnostics(current: StudioProviderErrorDiagnostics | null, binding: StudioProviderErrorBinding,
  frozen: StudioProviderErrorFrozen, observation: StudioProviderErrorObservation): StudioProviderErrorDiagnostics {
  const incoming = sanitizeEvent(observation.event); if (!incoming) throw new Error('provider_error_event_invalid');
  const next: StudioProviderErrorDiagnostics = current ? { ...current, binding: { ...current.binding,
    providerTaskId: current.binding.providerTaskId || binding.providerTaskId }, events: current.events.map(event => ({ ...event })) }
    : { schema: STUDIO_PROVIDER_ERROR_SCHEMA, binding, frozen, request: sanitizeStudioProviderErrorRequest(observation.request),
      firstObservedAt: incoming.observedAt, lastObservedAt: incoming.lastObservedAt, eventCount: 0, omittedEvents: 0, events: [] };
  if (!next.request.dispatchObserved && observation.request.dispatchObserved) next.request = sanitizeStudioProviderErrorRequest(observation.request);
  const duplicate = next.events.find(event => studioProviderErrorEventKey(event) === studioProviderErrorEventKey(incoming));
  if (duplicate) {
    const earliest = incoming.observedAt < duplicate.observedAt ? incoming : duplicate;
    const latest = incoming.lastObservedAt > duplicate.lastObservedAt ? incoming : duplicate;
    const count = Math.min(MAX_COUNT, duplicate.occurrences + incoming.occurrences);
    Object.assign(duplicate, latest, { observedAt: earliest.observedAt, lastObservedAt: latest.lastObservedAt, occurrences: count });
  } else next.events.push(incoming);
  next.firstObservedAt = [next.firstObservedAt, incoming.observedAt].sort()[0];
  next.lastObservedAt = [next.lastObservedAt, incoming.lastObservedAt].sort().at(-1)!;
  next.eventCount = Math.min(MAX_COUNT, next.eventCount + incoming.occurrences + (int(observation.omittedEvents) || 0));
  next.omittedEvents = Math.min(MAX_COUNT, next.omittedEvents + (int(observation.omittedEvents) || 0));
  next.events.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  while (next.events.length > MAX_PROVIDER_ERROR_EVENTS || new TextEncoder().encode(JSON.stringify(next)).length > MAX_PROVIDER_ERROR_BYTES) {
    const firstSpecific = next.events.findIndex(event => event.providerReasonCode !== null || event.localCode === 'generated_dimensions_mismatch');
    const latest = next.events.reduce((index, event, candidate) => event.lastObservedAt > next.events[index].lastObservedAt ? candidate : index, 0);
    const remove = next.events.findIndex((_event, index) => index !== latest && index !== (firstSpecific >= 0 ? firstSpecific : 0));
    if (remove < 0) throw new Error('provider_error_aggregate_invalid');
    const removed = next.events.splice(remove, 1)[0]; next.omittedEvents = Math.min(MAX_COUNT, next.omittedEvents + removed.occurrences);
  }
  return next;
}
