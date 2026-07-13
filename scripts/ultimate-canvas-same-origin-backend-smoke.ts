import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const contract = require('../public/tools/ultimate-canvas/backend-contract.js');
const origin = 'https://sd2.youdoodesign.com';
const safeUnavailableMessage = '该功能暂时不可用，请稍后重试。';

async function main() {
assert.deepEqual(contract.backendStatus({}), {
  mode: 'unverified', label: '后端状态未验证', isReal: false,
});
assert.deepEqual(contract.backendStatus({ backend: { mode: 'unknown' } }), {
  mode: 'unverified', label: '后端状态未验证', isReal: false,
});
assert.deepEqual(contract.backendStatus({ backend: { mode: 'sd2' } }), {
  mode: 'unverified', label: '后端状态未验证', isReal: false,
});
assert.deepEqual(contract.backendStatus({
  backend: { mode: 'sd2', transport: 'same-origin', mock: true },
}), {
  mode: 'unverified', label: '后端状态未验证', isReal: false,
});
assert.deepEqual(contract.backendStatus({
  backend: { mode: 'mock', transport: 'same-origin', mock: true },
}), {
  mode: 'mock', label: '本地 Mock', isReal: false,
});
assert.deepEqual(contract.backendStatus({
  backend: { mode: 'sd2', transport: 'same-origin', mock: false },
}), {
  mode: 'sd2', label: 'SD2 真实后端', isReal: true,
});

assert.equal(
  contract.resolveApiEndpoint('/api/assets/generate', '/api/assets/generate', origin, 'image'),
  '/api/assets/generate',
);
assert.equal(
  contract.resolveApiEndpoint('/api/tasks/create', '/api/tools/ultimate-canvas/generate', origin, 'text'),
  '/api/tools/ultimate-canvas/generate',
);
assert.equal(
  contract.resolveApiEndpoint('/api/assets/generate', '/api/tasks/create', origin, 'video'),
  '/api/tasks/create',
);
assert.equal(
  contract.resolveApiEndpoint('/api/assets/generate?route=video', '/api/assets/generate', origin, 'image'),
  '/api/assets/generate',
);
assert.equal(
  contract.resolveApiEndpoint('/api/admin/users', '/api/tools/ultimate-canvas/bootstrap', origin, 'canvas'),
  '/api/tools/ultimate-canvas/bootstrap',
);
assert.equal(
  contract.resolveApiEndpoint('/api/admin/users', '/api/admin/users', origin, 'canvas'),
  '',
);
assert.equal(
  contract.resolveApiEndpoint('https://example.invalid/api/tasks/create', '/api/tasks/create', origin, 'video'),
  '/api/tasks/create',
);
assert.equal(
  contract.resolveApiEndpoint('/api/tools/ultimate-canvas/bootstrap?project_id=project%2F1', '', origin, 'canvas'),
  '/api/tools/ultimate-canvas/bootstrap?project_id=project%2F1',
);
for (const endpoint of [
  '/api/tools/ultimate-canvas/document?project_id=p1',
  '/api/tools/ultimate-canvas/upload',
  '/api/assets/library?scope=project',
  '/api/projects',
  '/api/projects/p1',
  '/api/projects/p1/video-cards',
  '/api/video-cards/card1',
  '/api/video-cards/card1/branches/branch1',
  '/api/video-cards/card1/tasks',
  '/api/video-cards/card1/split',
  '/api/video-cards/card1/merge',
  '/api/tasks/estimate?resolution=720p&duration=5',
]) {
  assert.equal(contract.resolveApiEndpoint(endpoint, '', origin, 'canvas'), endpoint);
}

assert.equal(
  contract.resolveTaskStatusEndpoint('/api/video/status/:taskId?refresh=true', 'task/a', origin),
  '/api/video/status/task%2Fa?refresh=true',
);
for (const template of [
  '/api/video/status/no-placeholder?refresh=true',
  '/api/video/status/:taskId/:taskId?refresh=true',
  '/api/tasks/status/:taskId?refresh=true',
  '/api/video/status/:taskId?refresh=false',
  '/api/video/status/:taskId?refresh=true&admin=true',
  'https://example.invalid/api/video/status/:taskId?refresh=true',
]) {
  assert.equal(
    contract.resolveTaskStatusEndpoint(template, 'task/a', origin),
    '/api/video/status/task%2Fa?refresh=true',
  );
}

const providerPayload = {
  error: 'SEEDANCE_API_KEY is missing. Configure the provider in the admin API settings.',
  provider: { code: 'configuration_missing' },
};
const providerError = contract.createApiError(503, providerPayload);
assert.equal(providerError.message, safeUnavailableMessage);
assert.equal(providerError.status, 503);
assert.strictEqual(providerError.response, providerPayload);
assert.equal(contract.requestErrorMessage(503, providerPayload), safeUnavailableMessage);
for (const message of [
  'API Key missing',
  'SEEDANCE_API_KEY missing',
  'Set the environment variable before retrying',
  'Complete environment setup before retrying',
  'Complete setup in the admin API console',
  'Configuration is missing',
]) {
  assert.equal(contract.requestErrorMessage(503, { error: message }), safeUnavailableMessage);
}
assert.equal(contract.requestErrorMessage(401, {}), '登录已失效，请重新登录后继续。');
assert.equal(contract.requestErrorMessage(403, { error: '无权访问当前项目' }), '无权访问当前项目');

const invalidEndpointPayload = {
  error: 'invalid_canvas_endpoint',
  endpoint: '/api/admin/users',
  policy: 'canvas',
};
const invalidEndpointError = contract.createApiError(
  400,
  invalidEndpointPayload,
  'Canvas request endpoint is not allowed.',
);
assert.equal(invalidEndpointError.status, 400);
assert.strictEqual(invalidEndpointError.response, invalidEndpointPayload);

const indexSource = readFileSync('public/tools/ultimate-canvas/index.html', 'utf8');
const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
const generationApiSource = readFileSync('public/tools/ultimate-canvas/generation-api.js', 'utf8');
const bootstrapRouteSource = readFileSync('src/app/api/tools/ultimate-canvas/bootstrap/route.ts', 'utf8');
const generateRouteSource = readFileSync('src/app/api/tools/ultimate-canvas/generate/route.ts', 'utf8');
const previewServerSource = readFileSync('scripts/ultimate-canvas-preview-server.mjs', 'utf8');
const gitignoreSource = readFileSync('.gitignore', 'utf8');

const generationEvents: Array<{ name: string; detail: unknown }> = [];
let generationFetchCount = 0;
const generationWindow: Record<string, any> = {
  UltimateCanvasBackendContract: contract,
  location: { origin },
  dispatchEvent(event: { type: string; detail: unknown }) {
    generationEvents.push({ name: event.type, detail: event.detail });
  },
};
runInNewContext(generationApiSource, {
  window: generationWindow,
  CustomEvent: class CustomEvent {
    type: string;
    detail: unknown;

    constructor(type: string, options: { detail: unknown }) {
      this.type = type;
      this.detail = options.detail;
    }
  },
  fetch: async () => {
    generationFetchCount += 1;
    throw new Error('cross-capability endpoint reached fetch');
  },
  Date,
  Math,
  URL,
});
generationWindow.CanvasGenerationAPI.configure({ endpoints: { image: '/api/tasks/create' } });
await assert.rejects(
  generationWindow.CanvasGenerationAPI.generateImage({ prompt: 'test' }),
  (error: any) => {
    assert.equal(error.message, safeUnavailableMessage);
    assert.equal(error.status, 503);
    assert.equal(error.response?.error, 'canvas_generation_endpoint_unavailable');
    return true;
  },
);
assert.equal(generationFetchCount, 0);
assert.ok(generationEvents.some(event => event.name === 'canvas-generation:error'));

assert.ok(indexSource.indexOf('backend-contract.js') < indexSource.indexOf('generation-api.js'));
assert.ok(indexSource.indexOf('backend-contract.js') < indexSource.indexOf('app.js'));
assert.match(indexSource, /generation-api\.js\?v=20260713-sd2-same-origin/);
assert.match(indexSource, /app\.js\?v=20260713-sd2-same-origin/);
assert.match(appSource, /function backendEndpoint\(candidate, fallback, policy = 'canvas'\)/);
assert.match(appSource, /createApiError\(400,/);
assert.match(appSource, /options\.body/);
assert.match(appSource, /signal: options\.signal/);
assert.match(appSource, /cache: options\.cache/);
assert.match(appSource, /headers: requestHeaders/);
assert.equal((appSource.match(/\bfetch\s*\(/g) || []).length, 1);
assert.match(appSource, /requestJson\(url\.toString\(\), \{\s*cache: 'no-store'/);
assert.match(appSource, /requestJson\('\/api\/tools\/ultimate-canvas\/upload', \{\s*method: 'POST',\s*body: formData/);
assert.match(appSource, /requestJson\(videoStatusUrl\(taskId\), \{\s*cache: 'no-store',\s*policy: 'video-status'/);
assert.ok(!appSource.includes('图形生成能力未配置，请先到后台 API 设置完成配置。'));
assert.ok(!appSource.includes('默认视频 API 未配置，暂不能创建视频任务。'));
assert.ok(!generationApiSource.includes('请先完成后台能力配置和归属选择'));
assert.match(generationApiSource, /resolveApiEndpoint\(value, '', window\.location\.origin, capabilityPolicy\(key\)\)/);
assert.match(bootstrapRouteSource, /backend:\s*\{\s*mode: 'sd2',\s*transport: 'same-origin',\s*mock: false\s*\}/);
assert.match(previewServerSource, /backend:\s*\{\s*mode: 'mock',\s*transport: 'same-origin',\s*mock: true\s*\}/);
assert.ok(!generateRouteSource.includes('Musk API 未启用或缺少 API Key，请先到后台 API 设置完成配置'));
assert.match(gitignoreSource, /^\.superpowers\/sdd\/$/m);
assert.doesNotMatch(gitignoreSource, /^\.superpowers\/$/m);

console.log('ultimate-canvas-same-origin-backend-smoke passed');
}

void main();
