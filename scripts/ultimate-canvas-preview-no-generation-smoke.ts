import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 46000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['scripts/ultimate-canvas-preview-server.mjs', String(port)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`preview server did not start\n${output}`);
}

async function request(method: string, path: string, payload?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : {} };
}

async function main() {
  try {
    await waitForServer();

    const bootstrap = await request('GET', '/api/tools/ultimate-canvas/bootstrap');
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(bootstrap.data.backend, {
      mode: 'preview', transport: 'same-origin', mock: false,
    });
    assert.equal(bootstrap.data.capabilities.text.enabled, false);
    assert.equal(bootstrap.data.capabilities.image.enabled, false);
    assert.equal(bootstrap.data.capabilities.video.enabled, false);

    for (const attempt of [
      ['POST', '/api/tools/ultimate-canvas/generate', { kind: 'text', prompt: 'test' }],
      ['POST', '/api/assets/generate', { input: { prompt: 'test' } }],
      ['POST', '/api/tasks/create', { prompt: 'test' }],
      ['GET', '/api/tasks/estimate?resolution=720p&duration=5'],
      ['POST', '/api/video/retry/task-opening-1', {}],
      ['GET', '/api/video/status/task-opening-1?refresh=true'],
      ['GET', '/api/video/thumbnail/task-opening-1'],
    ] as const) {
      const result = await request(attempt[0], attempt[1], attempt[2]);
      assert.equal(result.status, 503);
      assert.equal(result.data.error, 'REAL_BACKEND_REQUIRED');
      assert.match(result.data.message, /未连接 SD2/);
      assert.doesNotMatch(JSON.stringify(result.data), /task-mock-|asset-generated-|result_video_url/);
    }

    const tasks = await request('GET', '/api/video-cards/card-opening/tasks');
    assert.equal(tasks.status, 200);
    assert.deepEqual(tasks.data.tasks, []);

    console.log('ultimate-canvas-preview-no-generation-smoke passed');
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
