import assert from 'node:assert/strict';
import fs from 'node:fs';

// Authentication exports share a Prisma import. Block that module before loading domain helpers.
const prismaPath = require.resolve('../src/lib/prisma');
assert.equal(require.cache[prismaPath], undefined, 'Run in a fresh engineering process');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true,
  exports: { prisma: new Proxy({}, { get() { throw new Error('Database access is forbidden in pure checks'); } }) } } as NodeModule;
const { normalizeVideoInput, inputHash, budgetPeriod } = require('../src/lib/customer-api/contracts') as typeof import('../src/lib/customer-api/contracts');
const { fixedPricingCredits } = require('../src/lib/pricing/math') as typeof import('../src/lib/pricing/math');
const { parsePreviewRange } = require('../src/lib/media/preview-response') as typeof import('../src/lib/media/preview-response');

// Pure input/math/parser checks and source wiring only. No database or provider calls.
const input = { model: 'seedance-2.5-ip', prompt: 'test prompt', duration: 5, resolution: '720p' };
const normalized = normalizeVideoInput(input);
assert.equal(inputHash(normalized), inputHash(normalizeVideoInput({ ...input, seed: -1, ratio: '16:9', image_assets: [] })));
for (const key of ['user_id', 'customer_id', 'project_id', 'reference_image_urls', 'callback_url', 'source_metadata']) {
  assert.throws(() => normalizeVideoInput({ ...input, [key]: 'untrusted' }));
}
for (const invalid of [{ duration: 0 }, { duration: 99 }, { resolution: '4k' }, { prompt: ' ' }, { seed: 0.5 },
  { image_assets: ['https://example.invalid/image.png'] }, { generation_mode: 'first_last_frame' },
  { generation_mode: 'smart_multi_frame', frame_assets: ['asset-0001'] }, { audio_assets: Array(11).fill('asset-0001') }]) {
  assert.throws(() => normalizeVideoInput({ ...input, ...invalid }), JSON.stringify(invalid));
}
assert.equal(normalizeVideoInput({ ...input, audio_assets: ['asset-0001'] }).audio_assets.length, 1);
assert.equal(normalizeVideoInput({ ...input, image_assets: Array.from({ length: 30 }, (_, i) => `asset-${String(i).padStart(4, '0')}`) }).image_assets.length, 30);
assert.deepEqual(budgetPeriod('America/Los_Angeles', new Date('2026-11-01T06:30:00Z')), { day: '2026-10-31', month: '2026-10' });
assert.deepEqual(budgetPeriod('Asia/Shanghai', new Date('2026-10-31T16:01:00Z')), { day: '2026-11-01', month: '2026-11' });
assert.throws(() => budgetPeriod('invalid/timezone'));
assert.equal(fixedPricingCredits('0.01', '1', '5').credits, '0.1');
assert.equal(fixedPricingCredits('0.03', '1', '5').credits, '0.2');
assert.deepEqual(parsePreviewRange('bytes=2-5', 10), { start: 2, end: 5 });
assert.deepEqual(parsePreviewRange('bytes=-3', 10), { start: 7, end: 9 });
assert.equal(parsePreviewRange('bytes=0-1,3-4', 10), null);
assert.equal(parsePreviewRange('bytes=10-', 10), null);

const read = (file: string) => fs.readFileSync(file, 'utf8');
const admission = read('src/lib/customer-api/admission.ts');
assert(admission.indexOf('if (original) return') < admission.indexOf('const quote = await prisma.apiQuote'));
assert(admission.includes('await tx.apiRequest.create') && admission.includes('await tx.apiConfiguration.updateMany'));
const shared = read('src/lib/video/ip-create.ts');
const transaction = shared.indexOf('const result = await prisma.$transaction');
assert(shared.indexOf('await apiAdmission.beforeCreate(tx)', transaction) > transaction);
assert(shared.indexOf('await apiAdmission.bindTask(tx, task.id)', transaction) < shared.indexOf('submissionStarted = true', transaction));
assert(shared.includes('{ balanceOnly: Boolean(apiAdmission) }'));
assert(read('src/lib/credits/policy.ts').includes('if (!options.balanceOnly) await ensureDailyQuotaBucket'));
assert(read('src/lib/video/local-cache.ts').includes('finishPrivateApiOutput'));
assert(read('src/lib/video/public-delivery.ts').includes("source?.source_type === 'customer_api'"));
assert(read('src/lib/video/media-ingest.ts').includes("source?.source_type === 'customer_api'"));
assert(read('src/lib/video/thumbnail.ts').includes("task.source_type === 'customer_api'"));
const projection = read('src/lib/customer-api/tasks.ts').split('return { id: receipt.id')[1];
for (const forbidden of ['provider_task_id:', 'source_metadata_json:', 'raw_status_response:', 'result_video_url:', 'local_video_path:']) assert(!projection.includes(forbidden));
const schema = read('prisma/schema.prisma').split('model ApiConfiguration')[1].split('model CreditAccount')[0];
assert(schema.includes('@default(false)') && schema.includes('onDelete: Restrict'));
const spec = JSON.parse(read('api-contracts/customer-api/openapi.json'));
for (const route of ['/models', '/assets/uploads', '/assets/uploads/{id}/transfer', '/assets/uploads/{id}/complete',
  '/assets/uploads/{id}/recover', '/video/quotes', '/video/tasks', '/video/requests/{requestId}', '/video/tasks/{id}/content', '/usage']) assert(spec.paths[route]);
assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
console.log('customer-api engineering: pure input/period/price/range and static wiring PASS; no multi-customer, database, provider, browser or billing flow executed');
