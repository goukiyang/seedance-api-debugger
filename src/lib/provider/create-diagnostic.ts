export type ProviderCreatePhase = 'fetch' | 'response_body' | 'response_parse' | 'response_validation' | 'complete';
export type ProviderCreateKnownFailure = {
  provider_code?: string;
  parameter?: string;
  request_id?: string;
  reason?: 'invalid_parameter' | 'reference_unavailable';
};
export type ProviderCreateDiagnostic = {
  phase: ProviderCreatePhase;
  elapsed_ms: number;
  encoded_json_bytes: number;
  http_status: number | null;
  name: string | null;
  code: string | null;
  cause: { name: string | null; code: string | null } | null;
  provider_error?: ProviderCreateKnownFailure;
};

const providerCodeFamilies = new Set(['InvalidParameter', 'InvalidArgument', 'BadRequest', 'AuthenticationError',
  'InvalidAPIKey', 'AccessDenied', 'ModelNotOpen', 'QuotaExceeded', 'RateLimitExceeded', 'InternalError', 'ServiceUnavailable']);
const parameterPattern = '(?:content(?:\\[\\d{1,2}\\]|\\.\\d{1,2})(?:\\.(?:image_url|video_url|audio_url))?(?:\\.url)?|model|duration|ratio|resolution|seed|generate_audio|return_last_frame|watermark|callback_url|client_request_id|service_tier|execution_expires_after|output_format|omni_reference_task_type)';

export function providerCreateKnownFailure(raw: unknown, responseRequestId?: string | null): ProviderCreateKnownFailure | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  if (body.id || !body.error || typeof body.error !== 'object' || Array.isArray(body.error)) return undefined;
  const error = body.error as Record<string, unknown>;
  const code = typeof error.code === 'string' ? error.code.split('.')[0] : '';
  if (!providerCodeFamilies.has(code)) return undefined;
  const message = typeof error.message === 'string' ? error.message : '';
  const candidateParameter = error.param ?? error.parameter ?? error.field;
  const parameter = typeof candidateParameter === 'string' ? candidateParameter
    : message.match(new RegExp('[`"\'](' + parameterPattern + ')[`"\']'))?.[1];
  const requestId = responseRequestId || body.request_id || body.requestId || body.RequestId;
  return {
    provider_code: code,
    ...(parameter && new RegExp('^' + parameterPattern + '$').test(parameter) ? { parameter } : {}),
    ...(typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(requestId) ? { request_id: requestId } : {}),
    ...(/resource not found|not accessible|(?:failed|unable|cannot|could not)\s+(?:to\s+)?(?:download|fetch|access)/i.test(message)
      ? { reason: 'reference_unavailable' as const }
      : ['InvalidParameter', 'InvalidArgument', 'BadRequest'].includes(code) ? { reason: 'invalid_parameter' as const } : {}),
  };
}

export function providerCreateFailureUserMessage(diagnostic: ProviderCreateDiagnostic | null | undefined): string | null {
  const error = diagnostic?.provider_error;
  const reason = error?.reason === 'reference_unavailable'
    ? `生成服务无法读取${error.parameter?.includes('video_url') ? '参考视频' : '参考素材'}`
    : error?.reason === 'invalid_parameter' ? '生成服务未接受本次参数' : null;
  return reason ? `${reason}；原提交结果和费用仍待核对，原预留保留，请勿重复提交。` : null;
}

const names = new Set(['Error', 'TypeError', 'AggregateError', 'AbortError', 'TimeoutError', 'DOMException']);
const codes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_ABORTED', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RESPONSE_STATUS_CODE',
]);

// Never copy arbitrary error objects, messages, stacks or cause payloads into a receipt.
function errorFields(value: unknown): { name: string | null; code: string | null } {
  if (!value || typeof value !== 'object') return { name: null, code: null };
  try {
    const fields = value as { name?: unknown; code?: unknown };
    return { name: typeof fields.name === 'string' && names.has(fields.name) ? fields.name : null,
      code: typeof fields.code === 'string' && codes.has(fields.code) ? fields.code : null };
  } catch { return { name: null, code: null }; }
}

export function providerCreateDiagnostic(input: {
  phase: ProviderCreatePhase; startedAt: number; encodedJsonBytes: number; httpStatus: number | null; error?: unknown;
  providerError?: ProviderCreateKnownFailure;
}): ProviderCreateDiagnostic {
  let cause: ProviderCreateDiagnostic['cause'] = null;
  try {
    const value = input.error && typeof input.error === 'object' ? (input.error as { cause?: unknown }).cause : null;
    if (value && typeof value === 'object') cause = errorFields(value);
  } catch { /* A diagnostic getter cannot replace the original failure. */ }
  return { phase: input.phase, elapsed_ms: Math.max(0, Date.now() - input.startedAt),
    encoded_json_bytes: input.encodedJsonBytes, http_status: input.httpStatus, ...errorFields(input.error), cause,
    ...(input.providerError ? { provider_error: input.providerError } : {}) };
}
