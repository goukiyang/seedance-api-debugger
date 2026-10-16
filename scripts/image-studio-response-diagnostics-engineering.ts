import assert from 'node:assert/strict';
import {
  buildStudioResponseDiagnostics, collectStudioResponseOutputCandidates, sanitizeStudioResponseDiagnostics,
  STUDIO_RESPONSE_DIAGNOSTIC_LIMITS,
} from '../src/lib/image-studio/response-diagnostics';

// Offline structural/privacy checks only. No provider, network, filesystem or database operations.
const observation = { httpStatus: 200, contentType: 'application/json; charset=utf-8', responseBytes: 123,
  responseSha256: 'a'.repeat(64), bodyComplete: true, parseOutcome: 'valid_json' as const };
const secret = 'PRIVATE_RESPONSE_SENTINEL_DO_NOT_STORE';
const value = {
  [secret]: { text: secret }, headers: { authorization: secret }, contents: [{ parts: [{ inlineData: { data: 'AAAA' } }] }],
  candidates: [{ finishReason: secret, content: { role: secret, parts: [
    { text: secret }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
    { fileData: { mimeType: secret, fileUri: `https://example.com/${secret}` } },
  ] } }],
  error: { code: 429, status: secret, message: secret, details: [{ text: secret }] },
  promptFeedback: { blockReason: 'SAFETY' },
};
const diagnostic = buildStudioResponseDiagnostics(value, observation);
const serialized = JSON.stringify(diagnostic);
assert.equal(serialized.includes(secret), false);
assert.equal(serialized.includes('AAAA'), false);
assert.equal(serialized.includes('https://'), false);
assert.equal(diagnostic.observation.responseSha256, observation.responseSha256);
assert.equal(diagnostic.observation.contentType, 'application/json');
assert.ok(serialized.includes('unknown'));
assert.ok(serialized.includes('SAFETY'));
const discovered = collectStudioResponseOutputCandidates(value);
assert.equal(discovered.length, 1);
assert.equal(discovered[0].location, 'candidate_content_part_inlineData');
assert.equal(discovered[0].value, 'AAAA');
assert.equal(discovered[0].mimeType, 'image/png');

const tampered = JSON.parse(serialized);
tampered[secret] = secret;
tampered.observation.contentType = secret;
tampered.observation.responseSha256 = secret;
tampered.limits = { nodes: 999999999 };
tampered.structures[0].fields.push({ name: 'message', type: 'string', text: secret, enum: secret, length: 12 });
const sanitized = sanitizeStudioResponseDiagnostics(tampered);
assert.equal(JSON.stringify(sanitized).includes(secret), false);
assert.equal(sanitized.observation.contentType, 'unknown');
assert.equal(sanitized.observation.responseSha256, null);
assert.deepEqual(sanitized.limits, STUDIO_RESPONSE_DIAGNOSTIC_LIMITS);

const urlValues = ['http://example.com/image.png', 'https://user:pass@example.com/image.png',
  'https://127.0.0.1/image.png', 'https://localhost./image.png', 'https://10.0.0.1/image.png',
  'https://[::1]/image.png', 'https://[::ffff:127.0.0.1]/image.png', 'https://host.internal/image.png',
  `https://example.com/${'a'.repeat(16384)}`];
assert.equal(collectStudioResponseOutputCandidates({ data: urlValues.map(url => ({ url })) }).length, 0);
assert.equal(collectStudioResponseOutputCandidates({ data: [{ url: 'https://example.com/image.png' }] })[0]?.kind, 'url');
assert.equal(collectStudioResponseOutputCandidates({ data: [{ b64_json: 'AB==' }, { b64_json: 'AAA\n' }, { b64_json: '====' }, { b64_json: 'AAA' }] }).length, 0);
assert.equal(collectStudioResponseOutputCandidates({ data: Array.from({ length: 12 }, () => ({ b64_json: 'AAAA' })) }).length, 4);
assert.equal(collectStudioResponseOutputCandidates({ response: { result: { data: [{ b64_json: 'AAAA' }] } } })[0]?.wrapperPath.join('.'), 'response.result');
assert.equal(collectStudioResponseOutputCandidates({ response: { result: { body: { data: [{ b64_json: 'AAAA' }] } } } }).length, 0);
assert.equal(collectStudioResponseOutputCandidates({ input: { data: [{ b64_json: 'AAAA' }] }, contents: [{ parts: [{ inlineData: { data: 'AAAA' } }] }] }).length, 0);

const cycle: Record<string, unknown> = { candidates: Array.from({ length: 40 }, () => ({ content: { parts: Array.from({ length: 40 }, () => ({ text: secret })) } })) };
cycle.response = cycle;
const bounded = buildStudioResponseDiagnostics(cycle, observation);
assert.equal(bounded.truncated, true);
assert.ok(bounded.structures.length <= STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.nodes);
assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.outputBytes);
assert.equal(JSON.stringify(bounded).includes(secret), false);
const safeCycle = sanitizeStudioResponseDiagnostics(bounded);
assert.ok(Buffer.byteLength(JSON.stringify(safeCycle), 'utf8') <= STUDIO_RESPONSE_DIAGNOSTIC_LIMITS.outputBytes);
assert.equal(collectStudioResponseOutputCandidates(cycle).length, 0);

const empty = buildStudioResponseDiagnostics({}, observation);
const unknownOnly = buildStudioResponseDiagnostics({ [secret]: secret }, observation);
assert.equal(empty.structures[0].fieldCount, 0);
assert.equal(empty.structures[0].fieldCountTruncated, false);
assert.equal(unknownOnly.structures[0].fieldCount, 1);
assert.equal(unknownOnly.structures[0].fields.length, 0);
assert.equal(JSON.stringify(unknownOnly).includes(secret), false);
const caseOnly = { CANDIDATES: [{ CONTENT: { PARTS: [{ INLINEdata: { DATA: 'AAAA' } }] } }], TeXt: secret, ERROR: { MESSAGE: secret } };
const caseDiagnostic = buildStudioResponseDiagnostics(caseOnly, observation);
assert.equal(caseDiagnostic.structures[0].fieldCount, 3);
assert.deepEqual(caseDiagnostic.structures[0].nonCanonicalFields, [
  { name: 'candidates', type: 'array', count: 1 }, { name: 'text', type: 'string', length: secret.length }, { name: 'error', type: 'object' },
]);
assert.equal(JSON.stringify(caseDiagnostic).includes(secret), false);
assert.equal(JSON.stringify(caseDiagnostic).includes('CANDIDATES'), false);
assert.equal(collectStudioResponseOutputCandidates(caseOnly).length, 0);
assert.deepEqual(sanitizeStudioResponseDiagnostics(caseDiagnostic).structures[0].nonCanonicalFields, caseDiagnostic.structures[0].nonCanonicalFields);
const manyKeys = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`${secret}_${i}`, secret]));
const keyBounded = buildStudioResponseDiagnostics(manyKeys, observation);
assert.equal(keyBounded.structures[0].fieldCount, 128);
assert.equal(keyBounded.structures[0].fieldCountTruncated, true);
assert.equal(keyBounded.truncated, true);
assert.equal(JSON.stringify(keyBounded).includes(secret), false);
const longKey = buildStudioResponseDiagnostics({ [secret.repeat(100)]: secret }, observation);
assert.equal(longKey.structures[0].fieldCount, 1);
assert.equal(longKey.structures[0].fieldCountTruncated, true);
assert.equal(longKey.structures[0].nonCanonicalFields.length, 0);
assert.equal(JSON.stringify(longKey).includes(secret), false);
const textOnly = buildStudioResponseDiagnostics({ candidates: [{ content: { parts: [{ text: secret }] }, finishReason: 'STOP' }] }, observation);
assert.ok(textOnly.structures.some(node => node.location === 'part' && node.fields.some(entry => entry.name === 'text' && entry.type === 'string')));
const urlOnly = buildStudioResponseDiagnostics({ data: [{ url: `https://example.com/${secret}` }] }, observation);
assert.ok(urlOnly.structures.some(node => node.location === 'data_item' && node.fields.some(entry => entry.name === 'url' && entry.type === 'string')));
const wrappedError = buildStudioResponseDiagnostics({ response: { error: { code: 429, message: secret, status: 'RESOURCE_EXHAUSTED' } } }, observation);
assert.ok(wrappedError.structures.some(node => node.location === 'error' && node.wrapperPath.join('.') === 'response' && node.fields.some(entry => entry.name === 'code' && entry.number === 429)));
const knownReasons = buildStudioResponseDiagnostics({ promptFeedback: { blockReason: 'BLOCKED_REASON_UNSPECIFIED' }, candidates: [{ finishReason: 'IMAGE_RECITATION' }, { finishReason: 'CONTINUATION' }] }, observation);
for (const known of ['BLOCKED_REASON_UNSPECIFIED', 'IMAGE_RECITATION', 'CONTINUATION']) assert.ok(JSON.stringify(knownReasons).includes(known));
console.log('Response diagnostics offline privacy/shape/limit checks completed.');
