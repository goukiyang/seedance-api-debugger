const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
globalThis.AsyncLocalStorage = AsyncLocalStorage;
require('tsx/cjs');
const { requestAsyncStorage } = require('./fixtures/next-request-context.ts');
const { cookies, headers } = require('next/headers');

async function main() {
  await assert.rejects(async () => cookies(), /outside a request scope/);
  await Promise.all(['alice', 'bob'].map((user) => requestAsyncStorage.run({
    headers: new Headers({ cookie: `session=${user}`, 'x-fixture-user': user }),
  }, async () => {
    await new Promise((resolve) => setTimeout(resolve, user === 'alice' ? 10 : 1));
    assert.equal((await cookies()).get('session').value, user);
    assert.equal((await headers()).get('x-fixture-user'), user);
  })));
  await assert.rejects(async () => headers(), /outside a request scope/);
  console.log('PASS real Next request cookies/headers and concurrent scope isolation');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
