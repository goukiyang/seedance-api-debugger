const assert = require('node:assert/strict');
const fs = require('node:fs');
const { safeVideoFixtureError } = require('./verify-sql01-video-tx-server.cjs');
class VideoPricingContextError extends Error { constructor() { super('无权使用此素材'); this.name = 'PublicApiError'; this.status = 403; this.code = 'pricing_context_invalid'; } }
const visible = safeVideoFixtureError(new VideoPricingContextError());
assert.equal(visible.className, 'VideoPricingContextError'); assert.equal(visible.name, 'PublicApiError');
assert.equal(visible.status, 403); assert.equal(visible.code, 'pricing_context_invalid'); assert.equal(visible.message, '无权使用此素材');
const secret = 'synthetic-private-snapshot-cookie-token-never-log';
const cause = new Error(secret.repeat(1000)); cause.code = secret; cause.cause = cause;
const top = new Error(secret, { cause }); top.stack = secret; top.details = { prompt: secret }; top.snapshot = secret;
const hidden = safeVideoFixtureError(top), encoded = JSON.stringify(hidden);
assert(!encoded.includes(secret)); assert(encoded.length < 1200); assert.equal(hidden.cause.messageLength, 16384);
assert.equal(hidden.cause.cause.className, 'TruncatedCause');
let getters = 0; const hostile = Object.create(null);
for (const key of ['name', 'message', 'code', 'status', 'cause', 'constructor']) Object.defineProperty(hostile, key, { get() { getters++; throw new Error(secret); } });
assert.doesNotThrow(() => safeVideoFixtureError(hostile)); assert.equal(getters, 0);
const source = fs.readFileSync('scripts/verify-sql01-video-tx-server.cjs', 'utf8');
for (const invariant of ['elapsed < 4000', "performance.now() - start < 4000", 'assert.deepEqual(await protectedRows(), baseline)', 'assert.equal(forbidden, 0)',
  'verifyVideoPricingCredential(signature, context, null, 5)', "phase = 'actual_context_template_assets_and_cookie'"]) assert(source.includes(invariant), invariant);
console.log(JSON.stringify({ syntheticOnly: true, classStatusCauseVisible: true, privateErrorContentRedacted: true, boundedAndGetterSafe: true,
  originalThresholdAndBaselineSourceGuards: true, nativePrismaExecuted: false }));
