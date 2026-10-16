import { MAX_STUDIO_GENERATED_BASE64 } from './limits';
import { isPrivateNetworkHost } from '@/lib/media/public-url';

export const STUDIO_RESPONSE_DIAGNOSTIC_LIMITS = Object.freeze({
  nodes: 96, depth: 8, arrayItems: 16, wrapperDepth: 2, outputBytes: 32768,
  candidates: 4, urlCharacters: 16384, ownKeys: 128,
} as const);

export type StudioResponseParseOutcome = 'valid_json' | 'invalid_json' | 'oversize' | 'read_error' | 'empty_body';
export type StudioResponseObservation = {
  httpStatus: number; contentType: string | null; responseBytes: number;
  responseSha256: string; bodyComplete: boolean; parseOutcome: StudioResponseParseOutcome;
};
export type StudioResponseWrapper = 'response' | 'result' | 'body' | 'data';
export type StudioResponseMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/avif' | 'image/tiff' | 'unknown';
type JsonKind = 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'undefined' | 'unsupported';
type Location = 'root' | 'wrapper' | 'candidate' | 'content' | 'part' | 'inline_data' | 'file_data' | 'data_item' | 'image' | 'error' | 'prompt_feedback';
type KnownField = typeof FIELDS[number];
type FieldShape = { name: KnownField; type: JsonKind; length?: number; count?: number; boolean?: boolean; number?: number; enum?: string };
type CaseFieldShape = Pick<FieldShape, 'name' | 'type' | 'length' | 'count'>;
type Structure = { location: Location; wrapperPath: StudioResponseWrapper[]; ordinal: number; depth: number; fields: FieldShape[]; type: JsonKind;
  fieldCount: number; fieldCountTruncated: boolean; nonCanonicalFields: CaseFieldShape[] };
export type StudioResponseDiagnostics = {
  schemaVersion: 1;
  observation: {
    httpStatus: number | null; contentType: string; responseBytes: number | null;
    responseSha256: string | null; bodyComplete: boolean; parseOutcome: StudioResponseParseOutcome | 'unknown';
  };
  rootType: JsonKind;
  structures: Structure[];
  limits: typeof STUDIO_RESPONSE_DIAGNOSTIC_LIMITS;
  truncated: boolean;
};

export type StudioResponseOutputCandidate = {
  kind: 'inline_data' | 'b64_json' | 'url';
  location: 'candidate_content_part_inlineData' | 'candidate_content_part_inline_data'
    | 'candidate_content_part_fileData' | 'candidate_content_part_file_data' | 'data_b64_json' | 'data_url';
  wrapperPath: StudioResponseWrapper[];
  ordinal: number;
  mimeType: StudioResponseMime;
  /** Sensitive: pass only to private storage; never serialize into logs or diagnostics. */
  value: string;
};

const WRAPPERS: readonly StudioResponseWrapper[] = ['response', 'result', 'body', 'data'];
const FIELDS = ['candidates', 'candidate', 'content', 'parts', 'inlineData', 'inline_data', 'mimeType', 'mime_type',
  'text', 'fileData', 'file_data', 'fileUri', 'file_uri', 'data', 'b64_json', 'url', 'images', 'image', 'error',
  'code', 'status', 'message', 'details', 'finishReason', 'finish_reason', 'blockReason', 'block_reason',
  'promptFeedback', 'prompt_feedback', 'safetyRatings', 'role', 'response', 'result', 'body'] as const;
const FINISH_REASONS = ['FINISH_REASON_UNSPECIFIED', 'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE',
  'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'IMAGE_SAFETY',
  'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_OTHER', 'NO_IMAGE', 'IMAGE_RECITATION', 'CONTINUATION'];
const BLOCK_REASONS = ['BLOCKED_REASON_UNSPECIFIED', 'SAFETY', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'MODEL_ARMOR', 'JAILBREAK'];
const STATUSES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND',
  'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED',
  'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
const MIMES: readonly StudioResponseMime[] = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/tiff'];
const CONTENT_TYPES = ['application/json', 'application/problem+json', 'text/plain', 'text/html', 'application/octet-stream'];
const PARSE_OUTCOMES: readonly string[] = ['valid_json', 'invalid_json', 'oversize', 'read_error', 'empty_body'];
const JSON_KINDS: readonly JsonKind[] = ['null', 'array', 'object', 'string', 'number', 'boolean', 'undefined', 'unsupported'];
const LOCATIONS: readonly Location[] = ['root', 'wrapper', 'candidate', 'content', 'part', 'inline_data', 'file_data', 'data_item', 'image', 'error', 'prompt_feedback'];
export const STUDIO_RESPONSE_DIAGNOSTIC_SCHEMA = Object.freeze({
  types: Object.freeze([...JSON_KINDS]), locations: Object.freeze([...LOCATIONS]), fields: Object.freeze([...FIELDS]),
  wrappers: Object.freeze([...WRAPPERS]), mimeTypes: Object.freeze([...MIMES]), contentTypes: Object.freeze([...CONTENT_TYPES]),
  finishReasons: Object.freeze([...FINISH_REASONS]), blockReasons: Object.freeze([...BLOCK_REASONS]),
  statuses: Object.freeze([...STATUSES]), parseOutcomes: Object.freeze([...PARSE_OUTCOMES]),
});

function kind(value: unknown): JsonKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  return type === 'object' || type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined' ? type : 'unsupported';
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// JSON has no accessors. Refuse getters even when a caller supplies a non-JSON object.
function own(value: unknown, key: string): { present: boolean; value?: unknown } {
  if (value === null || typeof value !== 'object') return { present: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? { present: true, value: descriptor.value } : { present: false };
  } catch { return { present: false }; }
}
function field(value: unknown, key: string) { return own(value, key).value; }
function mime(value: unknown): StudioResponseMime {
  return typeof value === 'string' && MIMES.includes(value as StudioResponseMime) ? value as StudioResponseMime : 'unknown';
}
function nonnegativeInteger(value: unknown) { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }
function enumValues(name: KnownField): readonly string[] | null {
  return name === 'finishReason' || name === 'finish_reason' ? FINISH_REASONS
    : name === 'blockReason' || name === 'block_reason' ? BLOCK_REASONS
      : name === 'status' ? STATUSES : name === 'mimeType' || name === 'mime_type' ? MIMES : null;
}
function projectObservation(value: unknown): StudioResponseDiagnostics['observation'] {
  const rawContentType = field(value, 'contentType');
  const contentType = typeof rawContentType === 'string' && rawContentType.length <= 256 ? rawContentType.split(';', 1)[0].trim().toLowerCase() : '';
  const status = field(value, 'httpStatus');
  const sha = field(value, 'responseSha256');
  const outcome = field(value, 'parseOutcome');
  return {
    httpStatus: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    contentType: CONTENT_TYPES.includes(contentType) ? contentType : 'unknown',
    responseBytes: nonnegativeInteger(field(value, 'responseBytes')),
    responseSha256: typeof sha === 'string' && /^[a-f0-9]{64}$/i.test(sha) ? sha.toLowerCase() : null,
    bodyComplete: field(value, 'bodyComplete') === true,
    parseOutcome: typeof outcome === 'string' && PARSE_OUTCOMES.includes(outcome) ? outcome as StudioResponseParseOutcome : 'unknown',
  };
}
function shape(name: KnownField, value: unknown): FieldShape {
  const result: FieldShape = { name, type: kind(value) };
  if (typeof value === 'string') {
    result.length = value.length;
    const allowed = enumValues(name);
    if (allowed) result.enum = allowed.includes(value) ? value : 'unknown';
  } else if (Array.isArray(value)) result.count = value.length;
  else if (typeof value === 'boolean') result.boolean = value;
  else if (name === 'code' && typeof value === 'number' && Number.isSafeInteger(value)) result.number = value;
  return result;
}

function objectFieldSignals(value: unknown): Pick<Structure, 'fieldCount' | 'fieldCountTruncated' | 'nonCanonicalFields'> {
  const signals: Pick<Structure, 'fieldCount' | 'fieldCountTruncated' | 'nonCanonicalFields'> = {
    fieldCount: 0, fieldCountTruncated: false, nonCanonicalFields: [],
  };
  if (!object(value)) return signals;
  let inspected = 0;
  try {
    // Do not materialize Object.keys/ownKeys for an unbounded response object.
    // Reaching the bound is conservatively marked incomplete, even at exactly 128 keys.
    for (const key in value) {
      inspected++;
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        signals.fieldCount++;
        if (key.length > 64) signals.fieldCountTruncated = true;
        if (key.length <= 64 && !FIELDS.includes(key as KnownField)) {
          const canonical = FIELDS.find(name => name.toLowerCase() === key.toLowerCase());
          const entry = canonical ? own(value, key) : { present: false };
          if (canonical && entry.present) {
            const projected = shape(canonical, entry.value);
            signals.nonCanonicalFields.push({ name: canonical, type: projected.type,
              ...(projected.length !== undefined ? { length: projected.length } : {}),
              ...(projected.count !== undefined ? { count: projected.count } : {}) });
          }
        }
      }
      if (inspected >= STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.ownKeys) { signals.fieldCountTruncated = true; break; }
    }
  } catch { signals.fieldCountTruncated = true; }
  return signals;
}

/** A bounded structural projection. Arbitrary keys, strings and response bytes never enter the result. */
export function buildStudioResponseDiagnostics(value: unknown, observation: StudioResponseObservation): StudioResponseDiagnostics {
  const result: StudioResponseDiagnostics = {
    schemaVersion: 1, observation: projectObservation(observation),
    rootType: kind(value), structures: [], limits: STUDIO_RESPONSE_DIAGNOSTIC_LIMITS, truncated: false,
  };
  const seen = new WeakSet<object>();
  let outputBytes = JSON.stringify(result).length;
  function visit(item: unknown, location: Location, wrapperPath: StudioResponseWrapper[], depth: number, ordinal: number) {
    if (depth > STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.depth || result.structures.length >= STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.nodes) { result.truncated = true; return; }
    if (item !== null && typeof item === 'object') {
      if (seen.has(item)) { result.truncated = true; return; }
      seen.add(item);
    }
    const fields = FIELDS.flatMap(name => {
      const entry = own(item, name);
      return entry.present ? [shape(name, entry.value)] : [];
    });
    const signals = objectFieldSignals(item);
    if (signals.fieldCountTruncated) result.truncated = true;
    const node: Structure = { location, wrapperPath: [...wrapperPath], ordinal, depth, fields, type: kind(item), ...signals };
    const size = JSON.stringify(node).length + 1;
    if (outputBytes + size > STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.outputBytes) { result.truncated = true; return; }
    result.structures.push(node); outputBytes += size;
    const child = (key: KnownField, next: Location) => {
      const entry = own(item, key);
      if (entry.present) visit(entry.value, next, wrapperPath, depth + 1, ordinal);
    };
    const array = (key: KnownField, next: Location) => {
      const values = field(item, key);
      if (!Array.isArray(values)) return;
      if (values.length > STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.arrayItems) result.truncated = true;
      for (let i = 0; i < Math.min(values.length, STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.arrayItems); i++) {
        visit(field(values, String(i)), next, wrapperPath, depth + 1, i);
      }
    };
    if (location === 'root' || location === 'wrapper') {
      array('candidates', 'candidate'); array('data', 'data_item'); array('images', 'image');
      child('error', 'error'); child('promptFeedback', 'prompt_feedback'); child('prompt_feedback', 'prompt_feedback');
      if (wrapperPath.length < STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.wrapperDepth) {
        for (const key of WRAPPERS) {
          const nested = field(item, key);
          if (object(nested)) visit(nested, 'wrapper', [...wrapperPath, key], depth + 1, ordinal);
        }
      } else if (WRAPPERS.some(key => object(field(item, key)))) result.truncated = true;
    } else if (location === 'candidate') child('content', 'content');
    else if (location === 'content') array('parts', 'part');
    else if (location === 'part') {
      child('inlineData', 'inline_data'); child('inline_data', 'inline_data');
      child('fileData', 'file_data'); child('file_data', 'file_data');
    }
  }
  visit(value, 'root', [], 0, 0);
  return result;
}

/** Re-project persisted diagnostics before writing or displaying them. Never trust a stored JSON object as already sanitized. */
export function sanitizeStudioResponseDiagnostics(value: unknown): StudioResponseDiagnostics {
  const rawRootType = field(value, 'rootType');
  const result: StudioResponseDiagnostics = {
    schemaVersion: 1, observation: projectObservation(field(value, 'observation')),
    rootType: JSON_KINDS.includes(rawRootType as JsonKind) ? rawRootType as JsonKind : 'unsupported',
    structures: [], limits: STUDIO_RESPONSE_DIAGNOSTIC_LIMITS, truncated: field(value, 'truncated') === true,
  };
  const structures = field(value, 'structures');
  if (!Array.isArray(structures)) { result.truncated = true; return result; }
  if (structures.length > STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.nodes) result.truncated = true;
  let outputBytes = JSON.stringify(result).length;
  for (let i = 0; i < Math.min(structures.length, STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.nodes); i++) {
    const raw = field(structures, String(i));
    const location = field(raw, 'location');
    const rawPath = field(raw, 'wrapperPath');
    const depth = nonnegativeInteger(field(raw, 'depth'));
    const ordinal = nonnegativeInteger(field(raw, 'ordinal'));
    const type = field(raw, 'type');
    if (!LOCATIONS.includes(location as Location) || !Array.isArray(rawPath) || rawPath.length > STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.wrapperDepth
      || depth === null || depth > STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.depth || ordinal === null || !JSON_KINDS.includes(type as JsonKind)) { result.truncated = true; continue; }
    const wrapperPath: StudioResponseWrapper[] = [];
    for (let p = 0; p < rawPath.length; p++) {
      const key = field(rawPath, String(p));
      if (WRAPPERS.includes(key as StudioResponseWrapper)) wrapperPath.push(key as StudioResponseWrapper);
    }
    if (wrapperPath.length !== rawPath.length) { result.truncated = true; continue; }
    const fields: FieldShape[] = [];
    const rawFields = field(raw, 'fields');
    const seen = new Set<KnownField>();
    if (Array.isArray(rawFields)) for (let f = 0; f < Math.min(rawFields.length, FIELDS.length); f++) {
      const entry = field(rawFields, String(f));
      const name = field(entry, 'name');
      const fieldType = field(entry, 'type');
      if (!FIELDS.includes(name as KnownField) || seen.has(name as KnownField) || !JSON_KINDS.includes(fieldType as JsonKind)) { result.truncated = true; continue; }
      seen.add(name as KnownField);
      const safe: FieldShape = { name: name as KnownField, type: fieldType as JsonKind };
      const length = nonnegativeInteger(field(entry, 'length'));
      const count = nonnegativeInteger(field(entry, 'count'));
      const boolean = field(entry, 'boolean');
      const code = field(entry, 'number');
      if (fieldType === 'string' && length !== null) safe.length = length;
      if (fieldType === 'array' && count !== null) safe.count = count;
      if (fieldType === 'boolean' && typeof boolean === 'boolean') safe.boolean = boolean;
      if (name === 'code' && fieldType === 'number' && typeof code === 'number' && Number.isSafeInteger(code)) safe.number = code;
      const allowed = enumValues(name as KnownField);
      if (allowed && fieldType === 'string') {
        const entryEnum = field(entry, 'enum');
        safe.enum = typeof entryEnum === 'string' && allowed.includes(entryEnum) ? entryEnum : 'unknown';
      }
      fields.push(safe);
    }
    if (Array.isArray(rawFields) && rawFields.length > FIELDS.length) result.truncated = true;
    const rawFieldCount = nonnegativeInteger(field(raw, 'fieldCount'));
    const fieldCount = Math.min(rawFieldCount ?? 0, STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.ownKeys);
    const fieldCountTruncated = field(raw, 'fieldCountTruncated') === true || rawFieldCount === null || rawFieldCount >= STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.ownKeys;
    const nonCanonicalFields: CaseFieldShape[] = [];
    const rawCaseFields = field(raw, 'nonCanonicalFields');
    if (Array.isArray(rawCaseFields)) {
      for (let c = 0; c < Math.min(rawCaseFields.length, STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.ownKeys); c++) {
        const entry = field(rawCaseFields, String(c));
        const name = field(entry, 'name');
        const caseType = field(entry, 'type');
        if (!FIELDS.includes(name as KnownField) || !JSON_KINDS.includes(caseType as JsonKind)) { result.truncated = true; continue; }
        const length = nonnegativeInteger(field(entry, 'length'));
        const count = nonnegativeInteger(field(entry, 'count'));
        nonCanonicalFields.push({ name: name as KnownField, type: caseType as JsonKind,
          ...(caseType === 'string' && length !== null ? { length } : {}),
          ...(caseType === 'array' && count !== null ? { count } : {}) });
      }
      if (rawCaseFields.length > STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.ownKeys) result.truncated = true;
    }
    if (fieldCountTruncated) result.truncated = true;
    const node: Structure = { location: location as Location, wrapperPath, ordinal, depth, type: type as JsonKind, fields,
      fieldCount, fieldCountTruncated, nonCanonicalFields };
    const size = JSON.stringify(node).length + 1;
    if (outputBytes + size > STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.outputBytes) { result.truncated = true; break; }
    result.structures.push(node); outputBytes += size;
  }
  return result;
}

function strictBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STUDIO_GENERATED_BASE64 || value.length % 4 !== 0) return false;
  if (/[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const firstPadding = value.indexOf('=');
  if (firstPadding !== (padding ? value.length - padding : -1)) return false;
  if (!padding) return true;
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(value[value.length - padding - 1]);
  return last >= 0 && (last & (padding === 2 ? 15 : 3)) === 0;
}
function safeCandidateUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.urlCharacters || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return url.protocol === 'https:' && !url.username && !url.password && Boolean(host)
      && !isPrivateNetworkHost(host) && host !== '::' && !host.startsWith('::ffff:')
      && !host.endsWith('.localhost') && !host.endsWith('.internal') && !host.endsWith('.lan') && (host.includes('.') || host.includes(':'))
      && !(host.includes(':') && host.startsWith('ff'))
      && !/^(0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.0\.|198\.(1[89])\.|2(2[4-9]|[3-5]\d)\.)/.test(host);
  } catch { return false; }
}

/** Discovery only: these are unconfirmed private candidates, never confirmed outputs or diagnostic fields. */
export function collectStudioResponseOutputCandidates(value: unknown): StudioResponseOutputCandidate[] {
  const output: StudioResponseOutputCandidate[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;
  function claim(item: unknown) {
    if (!object(item) || seen.has(item) || nodes >= STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.nodes) return false;
    seen.add(item); nodes++;
    return true;
  }
  function scan(item: unknown, wrapperPath: StudioResponseWrapper[]) {
    if (output.length >= STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.candidates || !claim(item)) return;
    const add = (candidate: Omit<StudioResponseOutputCandidate, 'ordinal' | 'wrapperPath'>) => {
      if (output.length < STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.candidates) output.push({ ...candidate, wrapperPath: [...wrapperPath], ordinal: output.length });
    };
    const candidates = field(item, 'candidates');
    if (Array.isArray(candidates)) for (let i = 0; i < Math.min(candidates.length, STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.arrayItems) && output.length < 4; i++) {
      const candidate = field(candidates, String(i));
      if (!claim(candidate)) continue;
      const content = field(candidate, 'content');
      if (!claim(content)) continue;
      const parts = field(content, 'parts');
      if (!Array.isArray(parts)) continue;
      for (let j = 0; j < Math.min(parts.length, STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.arrayItems) && output.length < 4; j++) {
        const part = field(parts, String(j));
        if (!claim(part)) continue;
        for (const key of ['inlineData', 'inline_data'] as const) {
          const inline = field(part, key);
          if (!claim(inline)) continue;
          const data = field(inline, 'data');
          if (strictBase64(data)) add({ kind: 'inline_data', location: key === 'inlineData' ? 'candidate_content_part_inlineData' : 'candidate_content_part_inline_data',
            mimeType: mime(field(inline, 'mimeType') ?? field(inline, 'mime_type')), value: data });
        }
        for (const key of ['fileData', 'file_data'] as const) {
          const file = field(part, key);
          if (!claim(file)) continue;
          const mimeType = mime(field(file, 'mimeType') ?? field(file, 'mime_type'));
          const url = field(file, 'fileUri') ?? field(file, 'file_uri');
          if (mimeType !== 'unknown' && safeCandidateUrl(url)) add({ kind: 'url',
            location: key === 'fileData' ? 'candidate_content_part_fileData' : 'candidate_content_part_file_data', mimeType, value: url });
        }
      }
    }
    const data = field(item, 'data');
    if (Array.isArray(data)) for (let i = 0; i < Math.min(data.length, STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.arrayItems) && output.length < 4; i++) {
      const entry = field(data, String(i));
      if (!claim(entry)) continue;
      const base64 = field(entry, 'b64_json');
      if (strictBase64(base64)) add({ kind: 'b64_json', location: 'data_b64_json', mimeType: 'unknown', value: base64 });
      const url = field(entry, 'url');
      if (safeCandidateUrl(url)) add({ kind: 'url', location: 'data_url', mimeType: 'unknown', value: url });
    }
    if (wrapperPath.length < STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.wrapperDepth) {
      for (const key of WRAPPERS) scan(field(item, key), [...wrapperPath, key]);
    }
  }
  scan(value, []);
  return output;
}
