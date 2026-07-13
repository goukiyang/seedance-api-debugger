import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = require('../public/tools/ultimate-canvas/backend-contract.js');
const origin = 'https://sd2.youdoodesign.com';

assert.deepEqual(contract.backendStatus({}), {
  mode: 'sd2', label: 'SD2 \u771f\u5b9e\u540e\u7aef', isReal: true,
});
assert.deepEqual(contract.backendStatus({ backend: { mode: 'unknown' } }), {
  mode: 'sd2', label: 'SD2 \u771f\u5b9e\u540e\u7aef', isReal: true,
});

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
const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
const generationApiSource = readFileSync('public/tools/ultimate-canvas/generation-api.js', 'utf8');
assert.ok(indexSource.indexOf('backend-contract.js') < indexSource.indexOf('generation-api.js'));
assert.ok(indexSource.indexOf('backend-contract.js') < indexSource.indexOf('app.js'));
assert.match(appSource, /function backendEndpoint\(candidate, fallback\)\s*\{\s*return window\.UltimateCanvasBackendContract\.resolveApiEndpoint\(candidate, fallback, window\.location\.origin\);/s);
assert.match(appSource, /text: backendEndpoint\(capabilities\.text\?\.endpoint, '\/api\/tools\/ultimate-canvas\/generate'\)/);
assert.match(appSource, /script: backendEndpoint\(capabilities\.script\?\.endpoint, '\/api\/tools\/ultimate-canvas\/generate'\)/);
assert.match(appSource, /image: backendEndpoint\(capabilities\.image\?\.endpoint, '\/api\/assets\/generate'\)/);
assert.match(appSource, /video: backendEndpoint\(capabilities\.video\?\.endpoint, '\/api\/tasks\/create'\)/);
assert.match(appSource, /descriptor\.url = backendEndpoint\(capabilities\.image\?\.endpoint, descriptor\.url\);/);
assert.match(appSource, /descriptor\.url = backendEndpoint\(capabilities\.video\?\.endpoint, descriptor\.url\);/);
assert.ok(!appSource.includes('descriptor.url = capabilities.image?.endpoint || descriptor.url;'));
assert.ok(!appSource.includes('descriptor.url = capabilities.video?.endpoint || descriptor.url;'));
assert.match(appSource, /const endpoint = backendEndpoint\(url, ''\);\s*if \(!endpoint\) throw new Error\('Canvas requests must target a same-origin \/api\/ endpoint\.'\);\s*const res = await fetch\(endpoint,/s);
assert.match(appSource, /window\.UltimateCanvasBackendContract\.requestErrorMessage\(res\.status, data\)/);
assert.match(appSource, /return window\.UltimateCanvasBackendContract\.resolveTaskStatusEndpoint\(\s*canvasRuntime\.bootstrap\?\.capabilities\?\.video\?\.status_endpoint_template,\s*taskId,\s*window\.location\.origin\s*\);/s);
assert.match(appSource, /backendEndpoint\(canvasRuntime\.bootstrap\?\.capabilities\?\.text\?\.endpoint, '\/api\/tools\/ultimate-canvas\/generate'\)/);
assert.match(appSource, /const backend = window\.UltimateCanvasBackendContract\.backendStatus\(data\);/);
assert.match(appSource, /\? backend\.label\s*:/);
assert.match(generationApiSource, /resolveApiEndpoint\(value, '', window\.location\.origin\)/);

console.log('ultimate-canvas-same-origin-backend-smoke passed');
