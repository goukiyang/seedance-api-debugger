const assert = require('node:assert/strict');
const { createDecipheriv, createHash } = require('node:crypto');
process.env.SESSION_SECRET = 'synthetic-error-contract-master-0123456789012345';
require('tsx/cjs');
const { apiErrorResponse, withApiErrors, PublicApiError } = require('../src/lib/http/api-error.ts');
const { requireSecret } = require('../src/lib/security/secrets.ts');

async function main() {
  const records = [];
  const original = console.error;
  console.error = (...values) => records.push(values);
  try {
    const secret = 'synthetic-private-prompt-and-token';
    const response = await withApiErrors(async () => { throw new Error(secret); })();
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, '服务暂时不可用');
    assert.match(body.errorId, /^[a-f0-9-]{36}$/);
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(JSON.stringify(records).includes(secret), false);
    const record = records[0][1];
    assert.equal(record.errorId, body.errorId);
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(requireSecret('errorLog')).digest(), Buffer.from(record.iv, 'base64url'));
    decipher.setAAD(Buffer.from(body.errorId));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
    const diagnostic = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]).toString());
    assert.equal(diagnostic.message, secret);
    const expected = apiErrorResponse(new PublicApiError('素材已失效', 409, 'ASSET_UNAVAILABLE'));
    assert.equal(expected.status, 409);
    assert.deepEqual(await expected.json(), { error: '素材已失效', code: 'ASSET_UNAVAILABLE' });
    const forged = Object.assign(new Error(secret), { name: 'PublicApiError', status: 400 });
    assert.equal(apiErrorResponse(forged).status, 503);
    const passed = new Response('ordinary', { status: 201 });
    assert.equal(await withApiErrors(async () => passed)(), passed);
    delete process.env.SESSION_SECRET;
    assert.equal(apiErrorResponse(new Error(secret)).status, 503);
    assert.equal(JSON.stringify(records).includes(secret), false);
  } finally { console.error = original; }
  console.log('PASS API error confidentiality, encrypted diagnostics, explicit business error, key failure');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
