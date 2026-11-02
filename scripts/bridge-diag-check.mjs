import assert from 'node:assert/strict';
import diag from '../src/lib/bridge/diag-uploads.ts';
const { generateDiagCode, MAX_DIAG_BYTES, redactDiagnostic, uploadBodyStatus, uploadSizeStatus } = diag;

assert.equal(generateDiagCode(() => 0), 'AAAAAA');
for (let i = 0; i < 100; i++) assert.match(generateDiagCode(), /^[A-HJ-NP-Z2-9]{6}$/);

assert.deepEqual(redactDiagnostic({
  token: 'abc', nested: [{ cookieValue: 'xyz', image: 'data:image/png;base64,AAAA' }],
  note: '普通诊断文字',
}), {
  token: '[隐藏]', nested: [{ cookieValue: '[隐藏]', image: '[data 约 1KB]' }],
  note: '普通诊断文字',
});

assert.equal(uploadSizeStatus(MAX_DIAG_BYTES), null);
assert.equal(uploadSizeStatus(MAX_DIAG_BYTES + 1), 413);
assert.equal(uploadBodyStatus(null), 400);
assert.equal(uploadBodyStatus([]), 400);
assert.equal(uploadBodyStatus({}), 400);
assert.equal(uploadBodyStatus({ items: [] }), null);
console.log('bridge diag pure checks: OK');
