import assert from 'node:assert/strict';
import { multiviewPrivateTaskMarker, projectPrivateMultiviewTask } from '../src/lib/video/multiview-task-privacy';
import { multiviewGenerationProgress } from '../src/app/multiview/multiview-generation-progress';

// Root cause (2026-10-25): the private projection dropped idempotency_key and the upstream id, so the page's poll
// never matched its own request (no auto-open) and progress never left “等待生成”.
const base = { id: 'task-1', user_id: 'u', owner_user_id: 'u', idempotency_key: 'req-1', provider_client_request_id: 'client-1',
  source_metadata_json: JSON.stringify({ protected_module: multiviewPrivateTaskMarker('1.0.7') }), prompt: 'secret recipe' };
const running = projectPrivateMultiviewTask({ ...base, local_status: 'running', provider_status: 'running', provider_task_id: 'cgt-upstream-9' }) as Record<string, unknown>;
assert.equal(running.idempotency_key, 'req-1');
assert.equal(running.provider_accepted, true);
assert.equal('provider_task_id' in running, false, 'upstream id stays hidden');
assert.equal(JSON.stringify(running).includes('secret recipe'), false);
assert.equal(multiviewGenerationProgress('submitted', running as never)?.step, 2);
const queued = projectPrivateMultiviewTask({ ...base, local_status: 'queued', provider_status: 'queued', provider_task_id: 'cgt-upstream-9' });
assert.equal(multiviewGenerationProgress('submitted', queued as never)?.step, 1);
const notYet = projectPrivateMultiviewTask({ ...base, local_status: 'queued', provider_status: null, provider_task_id: 'req-1' }) as Record<string, unknown>;
assert.equal(notYet.provider_accepted, false, 'the request key itself is not an upstream acceptance');
console.log('multiview progress smoke: ok');
