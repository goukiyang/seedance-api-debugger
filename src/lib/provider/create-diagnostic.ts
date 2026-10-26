export type ProviderCreatePhase = 'fetch' | 'response_body' | 'response_parse' | 'response_validation' | 'complete';
export type ProviderCreateDiagnostic = {
  phase: ProviderCreatePhase;
  elapsed_ms: number;
  encoded_json_bytes: number;
  http_status: number | null;
  name: string | null;
  code: string | null;
  cause: { name: string | null; code: string | null } | null;
};

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
}): ProviderCreateDiagnostic {
  let cause: ProviderCreateDiagnostic['cause'] = null;
  try {
    const value = input.error && typeof input.error === 'object' ? (input.error as { cause?: unknown }).cause : null;
    if (value && typeof value === 'object') cause = errorFields(value);
  } catch { /* A diagnostic getter cannot replace the original failure. */ }
  return { phase: input.phase, elapsed_ms: Math.max(0, Date.now() - input.startedAt),
    encoded_json_bytes: input.encodedJsonBytes, http_status: input.httpStatus, ...errorFields(input.error), cause };
}
