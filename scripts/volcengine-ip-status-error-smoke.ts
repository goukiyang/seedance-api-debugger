import assert from 'node:assert/strict';
import {
  VolcengineIpRequestError,
  volcengineRequestErrorToStatus,
} from '../src/lib/provider/volcengine-ip';

function requestError(code: string, message: string, statusCode = 400) {
  return new VolcengineIpRequestError({
    statusCode,
    normalized: {
      code,
      category: code.toLowerCase().includes('ratelimit') ? 'rate_limit' : 'content_safety',
      retryable: code.toLowerCase().includes('ratelimit'),
      userMessage: '用户可见错误',
      providerMessage: message,
      statusCode,
    },
    raw: { error: { code, message } },
  });
}

const failed = volcengineRequestErrorToStatus(
  'cgt-terminal-failed',
  requestError('ContentSafety', 'copyright restriction'),
);

assert.equal(failed?.provider_task_id, 'cgt-terminal-failed');
assert.equal(failed?.provider_status, 'failed');
assert.equal(failed?.local_status, 'failed');
assert.equal(failed?.error_message, 'copyright restriction');

assert.equal(
  volcengineRequestErrorToStatus(
    'cgt-rate-limited',
    requestError('RateLimitExceeded', 'rate limit', 429),
  ),
  null,
);

console.log('volcengine ip status error smoke passed');
