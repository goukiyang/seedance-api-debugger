import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildH3DiagnosticSnapshot } from '../src/lib/provider/h3-diagnostics';

const diagnostic = buildH3DiagnosticSnapshot({
  phase: 'create_failed',
  taskId: 'task-001',
  jobId: 'job-001',
  presetId: 'larry_v4_6step',
  durationSec: 15,
  aspectRatio: '16:9',
  providerStatus: 'failed',
  localStatus: 'failed',
  errorCode: 'h3_request_failed',
  errorMessage: 'worker error with Bearer hidden-token and http://127.0.0.1:8793/internal',
  httpStatus: 503,
  retryAfterSeconds: 30,
  health: {
    api: 'ok',
    version: 'h3-api-0.3.0',
    worker: 'ok',
    comfyui: 'ok',
    worker_url: 'http://127.0.0.1:8793',
    public_base_url: 'https://temporary.example.invalid',
    billing: { charged: false, cost: 0, currency: null, cost_model: 'free_local' },
    queue: { paused: false, pending: 2, running: 1, max_pending_jobs: 20 },
  },
  raw: {
    status: 'failed',
    message: 'failed at https://temporary.example.invalid with 4cdab586cc6848b54431e0506b338fdd9646cb191a9c147cb26a1cab8890eb6b',
    headers: { Authorization: 'Bearer secret-token' },
    api_token: 'secret-token',
    base_url: 'https://temporary.example.invalid',
    outputs: [
      {
        index: 0,
        kind: 'video',
        filename: 'output.mp4',
        download_url: '/api/h3/jobs/job-001/outputs/0',
        content_type: 'video/mp4',
        size_bytes: 1234,
      },
    ],
  },
});

const json = JSON.stringify(diagnostic);
assert.equal(diagnostic.provider, 'h3');
assert.equal(diagnostic.status.http_status, 503);
assert.equal(diagnostic.status.retry_after_seconds, 30);
assert.equal(diagnostic.health?.billing?.cost_model, 'free_local');
assert.equal(diagnostic.queue?.pending, 2);
assert.equal(diagnostic.outputs.count, 1);
assert.equal(diagnostic.outputs.videos[0]?.has_download_url, true);
assert.ok(json.includes('[redacted]'), 'diagnostic should redact sensitive fields');
assert.ok(!json.includes('secret-token'), 'diagnostic must not expose token values');
assert.ok(!json.includes('temporary.example.invalid'), 'diagnostic must not expose base_url values');
assert.ok(!json.includes('127.0.0.1:8793'), 'diagnostic must not expose worker URL values');

const h3Source = readFileSync('src/lib/provider/h3.ts', 'utf8');
const createRouteSource = readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
const finalizerSource = readFileSync('src/lib/video/task-finalizer.ts', 'utf8');

assert.match(h3Source, /h3_diagnostic/, 'H3 status polling must attach diagnostic snapshot');
assert.match(createRouteSource, /phase:\s*'create_failed'/, 'H3 create failure must attach diagnostic snapshot');
assert.match(createRouteSource, /retryAfterSeconds/, 'H3 create failure diagnostic must include Retry-After');
assert.match(finalizerSource, /phase:\s*'status_poll_failed'/, 'H3 status polling exception must attach diagnostic snapshot');
assert.match(finalizerSource, /retryAfterSeconds/, 'H3 status polling exception diagnostic must include Retry-After');

console.log('h3-diagnostics smoke passed');
