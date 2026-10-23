import assert from 'node:assert/strict';

export const RELEASE_ERROR_SCHEMA = 'sd2-release-error.v1';
export const RELEASE_ERROR_CATEGORIES = Object.freeze([
  'busy_retryable',
  'input_permanent',
  'evidence_missing',
  'not_applicable',
  'internal_failure',
]);

const CATEGORY = new Set(RELEASE_ERROR_CATEGORIES);
const RETRYABLE = new Set(['busy_retryable']);
const IDENTIFIER = /^[a-z][a-z0-9_.-]{0,127}$/;

function plainObject(value, name) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  return value;
}

function shortText(value, name, maximum = 2000) {
  assert.ok(typeof value === 'string' && value.length > 0 && value.length <= maximum, `${name} is invalid`);
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), `${name} contains control characters`);
  return value;
}

export function validateReleaseError(value) {
  plainObject(value, 'release error');
  assert.deepEqual(Object.keys(value).sort(), [
    'category', 'code', 'nextStep', 'object', 'reason', 'retryable', 'schema', 'stop',
  ]);
  assert.equal(value.schema, RELEASE_ERROR_SCHEMA);
  assert.ok(CATEGORY.has(value.category), 'Unknown release error category');
  assert.match(value.code, IDENTIFIER);
  plainObject(value.object, 'release error object');
  assert.deepEqual(Object.keys(value.object).sort(), ['id', 'kind']);
  assert.match(value.object.kind, IDENTIFIER);
  shortText(value.object.id, 'release error object id', 4096);
  shortText(value.reason, 'release error reason');
  shortText(value.nextStep, 'release error nextStep');
  assert.equal(value.retryable, RETRYABLE.has(value.category));
  assert.equal(value.stop, value.category !== 'busy_retryable' && value.category !== 'not_applicable');
  return value;
}

export function releaseError({ category, code, object, reason, nextStep }) {
  return validateReleaseError({
    schema: RELEASE_ERROR_SCHEMA,
    category,
    code,
    object,
    reason,
    nextStep,
    retryable: RETRYABLE.has(category),
    stop: category !== 'busy_retryable' && category !== 'not_applicable',
  });
}

export class ReleaseEngineError extends Error {
  constructor(record, options = {}) {
    const checked = validateReleaseError(record);
    super(`${checked.code}: ${checked.reason}`, options);
    this.name = 'ReleaseEngineError';
    this.releaseError = checked;
    this.code = checked.code;
  }
}

export function throwReleaseError(input, options) {
  throw new ReleaseEngineError(releaseError(input), options);
}

function errorObject(error, context) {
  const kind = context.object?.kind || 'release_operation';
  const id = context.object?.id || context.phase || context.checkId || 'unknown';
  return { kind, id };
}

function causeCode(error) {
  return typeof error?.code === 'string' ? error.code : null;
}

export function classifyReleaseError(error, context = {}) {
  if (error instanceof ReleaseEngineError) return error.releaseError;
  if (error?.releaseError) return validateReleaseError(error.releaseError);
  const object = errorObject(error, context), code = causeCode(error);
  if (context.inputError === true) {
    return releaseError({ category: 'input_permanent', code: 'input_contract_rejected', object,
      reason: `The supplied input was explicitly identified as invalid${code ? ` (${code})` : ''}.`,
      nextStep: 'Correct the named input and recapture its identity before starting another attempt.' });
  }
  if (code === 'ETIMEDOUT') {
    return releaseError({ category: 'evidence_missing', code: 'operation_timed_out', object,
      reason: 'The operation crossed its execution or evidence boundary before a trustworthy result was recorded.',
      nextStep: 'Stop dependent work and inspect the preserved attempt, process, and original-result evidence; do not infer failure, success, or safe retry.' });
  }
  if (['EBUSY', 'EAGAIN'].includes(code)) {
    if (context.verifiedBusy === true) {
      if (!(typeof context.busyEvidence === 'string' && context.busyEvidence.length > 0 && context.busyEvidence.length <= 512
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(context.busyEvidence))) {
        return releaseError({ category: 'evidence_missing', code: 'busy_evidence_invalid', object,
          reason: `The operation reported ${code}, but its claimed busy evidence is missing or unsafe to record.`,
          nextStep: 'Stop dependent work and recapture a bounded, safe identity for the exact lock, resource, and owner.' });
      }
      const evidence = context.busyEvidence;
      return releaseError({ category: 'busy_retryable', code: `resource_${code.toLowerCase()}`, object,
        reason: `The named resource is verifiably busy (${code}): ${evidence}`,
        nextStep: 'Keep the current attempt unchanged, refresh the same resource evidence, and retry only this read-only or idempotent step.' });
    }
    return releaseError({ category: 'evidence_missing', code: 'busy_evidence_unverified', object,
      reason: `The operation reported ${code}, but no reviewed lock or resource evidence proves a retryable busy state.`,
      nextStep: 'Stop dependent work and identify the exact resource, owner, and lease before deciding whether retry is safe.' });
  }
  if (['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP', 'EINVAL', 'ENAMETOOLONG'].includes(code)) {
    return releaseError({ category: 'input_permanent', code: `input_${code.toLowerCase()}`, object,
      reason: `The supplied object has a permanent type, path, or permission mismatch (${code}).`,
      nextStep: 'Correct the named input or permission contract before starting another attempt.' });
  }
  if (['ENOENT', 'ENODATA'].includes(code)) {
    return releaseError({ category: 'evidence_missing', code: `evidence_${code.toLowerCase()}`, object,
      reason: `Required durable evidence is missing (${code}).`,
      nextStep: 'Recover or recapture the exact evidence; do not infer success, exit status, or ownership.' });
  }
  if (code === 'NOT_APPLICABLE') {
    return releaseError({ category: 'not_applicable', code: 'operation_not_applicable', object,
      reason: 'The check does not apply to this artifact or phase.',
      nextStep: 'Record the explicit non-applicability and continue only independent checks.' });
  }
  return releaseError({ category: 'internal_failure', code: 'unclassified_internal_failure', object,
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.' });
}

export function aggregateReleaseErrors(items, context = {}) {
  assert.ok(Array.isArray(items) && items.length > 0 && items.length <= 256, 'A bounded nonempty error list is required');
  const records = items.map((item, index) => {
    plainObject(item, `aggregate item ${index}`);
    assert.equal(item.readOnly, true, 'Only read-only checks may be aggregated');
    assert.equal(item.independent, true, 'Only independent checks may be aggregated');
    assert.notEqual(item.dependencyValid, false, 'A check with an invalid dependency must stop immediately');
    assert.match(item.checkId, IDENTIFIER);
    return { checkId: item.checkId, error: classifyReleaseError(item.error, {
      ...context, checkId: item.checkId, object: item.object || context.object,
      verifiedBusy: item.verifiedBusy ?? context.verifiedBusy,
      busyEvidence: item.busyEvidence ?? context.busyEvidence,
      inputError: item.inputError ?? context.inputError,
    }) };
  });
  const stop = records.some(({ error }) => error.stop);
  return {
    schema: 'sd2-release-error-aggregate.v1',
    phase: context.phase || null,
    count: records.length,
    retryableCount: records.filter(({ error }) => error.retryable).length,
    stop,
    records,
  };
}
