import assert from 'node:assert/strict';
import { CutoutRequestError, getCutoutJob, uploadCutoutAsset } from '../src/lib/cutout/client';

// In-memory transport checks: no real uploads, jobs, credentials or fees.
class UploadFixture {
  static latest: UploadFixture;
  upload = new EventTarget();
  status = 200;
  responseText = '';
  timeout = 0;
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  constructor() { UploadFixture.latest = this; }
  open(method: string, url: string) { assert.equal(method, 'POST'); assert.equal(url, '/api/cutout/v1/assets'); }
  send(body: FormData) { assert.ok(body.get('file') instanceof Blob); }
  progress(loaded: number, total: number, lengthComputable: boolean) {
    const event = new Event('progress');
    Object.assign(event, { loaded, total, lengthComputable });
    this.upload.dispatchEvent(event);
  }
  reply(body: unknown, status = 200) {
    this.status = status; this.responseText = JSON.stringify(body); this.onload?.();
  }
}

async function main() {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = UploadFixture as unknown as typeof XMLHttpRequest;
  let checks = 0;
  try {
    const progress: unknown[] = [];
    let settled = false;
    const upload = uploadCutoutAsset(new Blob(['fixture']), 'fixture.png', value => progress.push(value));
    void upload.then(() => { settled = true; });
    const xhr = UploadFixture.latest;
    xhr.progress(25, 100, true);
    xhr.progress(100, 100, true);
    await Promise.resolve();
    assert.equal(settled, false, '100% bytes cannot confirm server acceptance'); checks++;
    assert.deepEqual(progress, [{ loaded: 25, total: 100, percent: 25 }, { loaded: 100, total: 100, percent: 100 }]); checks++;
    xhr.progress(4, 0, false);
    assert.equal(progress.at(-1), null, 'unknown byte total is indeterminate'); checks++;
    xhr.reply({ asset_id: 'fixture', width: 2, height: 2, size: 4 });
    assert.equal((await upload).asset_id, 'fixture'); checks++;
    const incomplete = uploadCutoutAsset(new Blob(['fixture']));
    UploadFixture.latest.reply({ success: true });
    await assert.rejects(incomplete, error => error instanceof CutoutRequestError && error.code === 'INVALID_ASSET_RECEIPT' && error.submissionMade === false); checks++;
    const job = { job_id: 'fixture', kind: 'cutout', status: 'running', created_at: 1, updated_at: 2 };
    globalThis.fetch = async () => Response.json(job);
    assert.equal((await getCutoutJob('fixture')).progress, undefined, 'old API remains compatible'); checks++;
    globalThis.fetch = async () => Response.json({ ...job, started_at: 1, progress: { stage: 'processing', attempt: 1, sequence: 2, reported_at: 2, private: 'not-projected' } });
    assert.deepEqual((await getCutoutJob('fixture')).progress, { stage: 'processing', attempt: 1, sequence: 2, reported_at: 2 }); checks++;
    for (const invalid of [{ stage: 'fake', attempt: 1, sequence: 1, reported_at: 2 }, { stage: 'saving', attempt: 1, sequence: 0, reported_at: 2 }]) {
      globalThis.fetch = async () => Response.json({ ...job, started_at: 'bad', progress: invalid });
      const reply = await getCutoutJob('fixture');
      assert.equal(reply.progress, undefined); assert.equal(reply.started_at, undefined); checks++;
    }
    globalThis.fetch = async () => { throw new Error('fixture network'); };
    await assert.rejects(getCutoutJob('fixture'), error => error instanceof CutoutRequestError && error.status === 0); checks++;
    console.log(JSON.stringify({ passed: true, checks, scope: 'in-memory upload and optional progress contract', realImageJobs: 0, fees: 0 }));
  } finally { globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXhr; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
