import assert from 'node:assert/strict';
import { isCutoutJob } from '../src/lib/cutout/receipt';
import { isSamModelId } from '../src/lib/cutout/models';
import { createCutoutJob, CutoutRequestError, uploadCutoutAsset } from '../src/lib/cutout/client';
import { readBatchResponse } from '../src/lib/image-studio/batch-receipt';

async function main() {
  const base = { job_id: 'fixture-job', kind: 'cutout', status: 'queued', created_at: 1, updated_at: 2, parameters: { fixture: true } };
  for (const bad of [null, [], {}, { success: true }, { ...base, status: 'done' }, { ...base, updated_at: undefined }, { ...base, job_id: '../bad' }, { ...base, parameters: [] }, { ...base, status: 'succeeded', result: {} }, { ...base, status: 'succeeded', result: { items: [{}] } }]) assert.equal(isCutoutJob(bad), false);
  for (const status of ['queued', 'running', 'failed', 'canceled']) assert.equal(isCutoutJob({ ...base, status }), true);
  for (const result of [{ result_url: '/api/cutout/v1/results/fixture/result.png' }, { items: [], manifest_url: '/api/cutout/v1/results/fixture/manifest.json' }, { item: { trim_url: '/api/cutout/v1/results/fixture/trim.png' } }]) assert.equal(isCutoutJob({ ...base, status: 'succeeded', result }), true);
  assert.equal(isCutoutJob(base, { id: 'other-job' }), false);
  assert.equal(isCutoutJob(base, { kind: 'characters' }), false);
  for (const id of ['sam', 'sam-vit-base', 'facebook/sam-vit-base', ' FACEBOOK/SAM-VIT-BASE ']) assert.equal(isSamModelId(id), true);
  for (const id of ['samson', 'birefnet', '', null]) assert.equal(isSamModelId(id), false);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ key: string | null; body: unknown }> = [];
  try {
    globalThis.fetch = async (_url, init) => {
      requests.push({ key: new Headers(init?.headers).get('Idempotency-Key'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      return Response.json({ success: true });
    };
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(createCutoutJob('fixture-asset', 'cutout', { edge_smooth: 8 }, 'fixture-original-key'), error => error instanceof CutoutRequestError && error.submissionMade === null && error.code === 'INVALID_JOB_RECEIPT');
    assert.deepEqual(requests[0], requests[1], 'uncertain replies retain the original key and parameters');
    await assert.rejects(uploadCutoutAsset(new Blob(['fixture']), 'fixture.png'), error => error instanceof CutoutRequestError && error.submissionMade === false);
  } finally { globalThis.fetch = originalFetch; }
  const batch = { id: 'a'.repeat(64), moduleId: 'fixture-module', state: 'ready', total: 1, generated: 0, failed: 0, uncertain: 0, active: 0, pending: 1, prepared: 1, budget: 8, committedCredits: 0, unitCredits: 8 };
  assert.deepEqual((await readBatchResponse(Response.json({ batch }), true)).batch, batch);
  for (const bad of [[], {}, { success: true }, { batch: { ...batch, state: 'success' } }, { batch: { ...batch, active: -1 } }]) await assert.rejects(readBatchResponse(Response.json(bad), true));
  console.log('PASS scoped CUT models/receipt/unknown-key and batch receipt contracts; all fetches mocked, zero external calls/tasks/fees');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
