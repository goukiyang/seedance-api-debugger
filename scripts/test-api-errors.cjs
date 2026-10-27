const assert = require('node:assert/strict');
const { createDecipheriv, createHash } = require('node:crypto');
process.env.SESSION_SECRET = 'synthetic-error-contract-master-0123456789012345';
require('tsx/cjs');
const { apiErrorResponse, withApiErrors, PublicApiError } = require('../src/lib/http/api-error.ts');
const { requireSecret } = require('../src/lib/security/secrets.ts');
const { CreationError } = require('../src/lib/creation/contract.ts');
const { PricingNumberError } = require('../src/lib/pricing/math.ts');
const { SessionUnavailableError } = require('../src/lib/auth/session-errors.ts');

async function main() {
  const { inspect } = require('./check-api-errors.cjs');
  assert.equal(inspect('fixture.ts', 'return NextResponse.json({ error: error.message }, { status: 500 });').length, 1);
  assert.equal(inspect('fixture.ts', 'return apiErrorResponse(error);').length, 0);
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
    const creation = apiErrorResponse(new CreationError('素材状态已改变', 409, 'creation_conflict'));
    assert.equal(creation.status, 409);
    assert.equal((await creation.json()).error, '素材状态已改变');
    assert.equal(apiErrorResponse(new PricingNumberError()).status, 400);
    const unavailable = apiErrorResponse(new SessionUnavailableError());
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, 'AUTH_UNAVAILABLE');
    const forged = Object.assign(new Error(secret), { name: 'PublicApiError', status: 400 });
    assert.equal(apiErrorResponse(forged).status, 503);
    const passed = new Response('ordinary', { status: 201 });
    assert.equal(await withApiErrors(async () => passed)(), passed);
    const Module = require('node:module');
    const originalLoad = Module._load;
    let fixtureUser = { id: 'synthetic-error-user' };
    let route;
    try {
      Module._load = function (name, ...args) {
        if (name === '@/lib/auth/session') return { getSession: async () => fixtureUser };
        if (name === '@/lib/prisma') return { prisma: { notification: {
          findMany: async () => { throw new Error(secret); },
          count: async () => 0,
          updateMany: async () => { throw new Error(secret); },
        } } };
        return originalLoad.call(this, name, ...args);
      };
      route = require('../src/app/api/notifications/route.ts');
    } finally { Module._load = originalLoad; }
    const { NextRequest } = require('next/server');
    for (const method of ['GET', 'PATCH']) {
      const result = await route[method](new NextRequest('https://synthetic.invalid/api/notifications', {
        method, ...(method === 'PATCH' ? { body: JSON.stringify({ action: 'mark_all_read' }), headers: { 'content-type': 'application/json' } } : {}),
      }));
      assert.equal(result.status, 503);
      const payload = await result.json();
      assert.equal(payload.error, '服务暂时不可用');
      assert(records.some(entry => entry[1]?.errorId === payload.errorId));
      assert(!JSON.stringify(payload).includes(secret));
    }
    fixtureUser = null;
    assert.equal((await route.GET(new NextRequest('https://synthetic.invalid/api/notifications'))).status, 401);
    delete process.env.SESSION_SECRET;
    assert.equal(apiErrorResponse(new Error(secret)).status, 503);
    assert.equal(JSON.stringify(records).includes(secret), false);
  } finally { console.error = original; }
  console.log('PASS API error confidentiality, encrypted diagnostics, explicit business error, key failure');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
