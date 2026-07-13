import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = require('../public/tools/ultimate-canvas/backend-contract.js');
const origin = 'https://sd2.youdoodesign.com';

assert.equal(contract.resolveApiEndpoint('/api/assets/generate', '/api/fallback', origin), '/api/assets/generate');
assert.equal(
  contract.resolveApiEndpoint('https://sd2.youdoodesign.com/api/tasks/create?source=canvas', '/api/fallback', origin),
  '/api/tasks/create?source=canvas',
);
assert.equal(
  contract.resolveApiEndpoint('https://example.invalid/api/tasks/create', '/api/tasks/create', origin),
  '/api/tasks/create',
);
assert.equal(contract.resolveApiEndpoint('/admin/integrations', '/api/fallback', origin), '/api/fallback');
assert.equal(
  contract.resolveTaskStatusEndpoint('/api/video/status/:taskId?refresh=true', 'task/a', origin),
  '/api/video/status/task%2Fa?refresh=true',
);
assert.deepEqual(contract.backendStatus({ backend: { mode: 'mock' } }), {
  mode: 'mock', label: '本地 Mock', isReal: false,
});
assert.deepEqual(contract.backendStatus({ backend: { mode: 'sd2' } }), {
  mode: 'sd2', label: 'SD2 真实后端', isReal: true,
});
assert.equal(contract.requestErrorMessage(401, {}), '登录已失效，请重新登录后继续。');
assert.equal(contract.requestErrorMessage(403, { error: '无权访问当前项目' }), '无权访问当前项目');

const indexSource = readFileSync('public/tools/ultimate-canvas/index.html', 'utf8');
assert.ok(indexSource.indexOf('backend-contract.js') < indexSource.indexOf('generation-api.js'));
assert.ok(indexSource.indexOf('backend-contract.js') < indexSource.indexOf('app.js'));

console.log('ultimate-canvas-same-origin-backend-smoke passed');
