'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fixture = require('./fixtures/fb2322-video-tx.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  let checks = 0;
  for (const file of fixture.callers) {
    const selected = fixture.prefix(root, file);
    assert.match(selected.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(selected.prefixSha256, /^[a-f0-9]{64}$/);
    assert.ok(selected.text.includes('assertProjectActiveInTransaction'));
    assert.ok(selected.text.includes('verifyVideoPricingCredential'));
    assert.ok(!selected.text.includes('await tx.videoTask.create('));
    new Function(`return ${selected.javascript}`); checks++;
  }
  assert.throws(() => fixture.prefix(root, 'src/lib/auth/session.ts')); checks++;
  const input = new Error('synthetic secret snapshot, cookie=never-log');
  input.code = 'P2028'; input.status = 409; input.cause = new TypeError('private nested token');
  const output = fixture.safeError(input);
  assert.equal(output.className, 'Error'); assert.equal(output.status, 409); assert.equal(output.code, 'P2028');
  assert.equal(output.cause.className, 'TypeError'); assert.ok(!JSON.stringify(output).includes('private nested token'));
  assert.ok(!JSON.stringify(output).includes('never-log')); checks++;
  let invoked = false;
  Object.defineProperty(input, 'message', { get() { invoked = true; return 'secret'; } });
  fixture.safeError(input); assert.equal(invoked, false); checks++;
  const cycle = new Error('hidden'); cycle.cause = cycle;
  assert.equal(fixture.safeError(cycle).cause, undefined); checks++;
  globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
  const { requestContext } = require('./fixtures/fb2322-request-context.cjs');
  const { cookies } = require('next/headers');
  for (const value of ['first-synthetic', 'second-synthetic']) await requestContext(new Headers({ cookie: `session=${value}` }), async () => {
    assert.equal((await cookies()).get('session')?.value, value); checks++;
  });
  await assert.rejects(async () => cookies()); checks++;
  console.log(JSON.stringify({ fixture: 'fb2322-pure-harness', passed: checks, actualPrismaExecuted: false,
    actualNextCookieStorage: true, nextVersion: require('next/package.json').version }));
}
void main().catch(error => { console.error(JSON.stringify({ fixture: 'fb2322-pure-harness', ...fixture.safeError(error) })); process.exitCode = 1; });
