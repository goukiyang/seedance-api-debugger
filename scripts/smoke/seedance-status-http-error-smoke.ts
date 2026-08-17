import assert from 'node:assert/strict';
import { buildProviderHttpErrorStatus } from '../../src/lib/provider/jimeng';

const terminalFailure = buildProviderHttpErrorStatus(
  'provider-task-1',
  400,
  { error: { code: 'ProviderTaskFailed', message: 'copyright restriction' } },
);

assert.equal(terminalFailure?.local_status, 'failed');
assert.equal(terminalFailure?.provider_status, 'failed');
assert.equal(terminalFailure?.error_message, '[ProviderTaskFailed] copyright restriction');
assert.equal(terminalFailure?.provider_task_id, 'provider-task-1');

assert.equal(
  buildProviderHttpErrorStatus('provider-task-2', 401, { message: 'invalid api key' }),
  null,
);
assert.equal(
  buildProviderHttpErrorStatus('provider-task-3', 429, { message: 'rate limit' }),
  null,
);
assert.equal(
  buildProviderHttpErrorStatus('provider-task-4', 500, { message: 'provider unavailable' }),
  null,
);

console.log('seedance status http error smoke passed');
