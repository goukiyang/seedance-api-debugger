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

function assertNoHiddenTaskIds(data: unknown) {
  assert.doesNotMatch(JSON.stringify(data), /task-(?:opening|mock)-/);
}

function assertEmptyTaskSummary(summary: Record<string, unknown>) {
  for (const key of [
    'task_count',
    'succeeded_count',
    'failed_count',
    'running_count',
    'estimated_credits',
    'charged_credits',
    'refunded_credits',
  ]) {
    if (key in summary) assert.equal(summary[key], 0);
  }
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
    for (const card of bootstrap.data.context.video_cards) {
      assertEmptyTaskSummary(card.summary);
    }

    const branches = await request('GET', '/api/video-cards/card-opening/branches');
    assert.equal(branches.status, 200);
    for (const branch of branches.data.branches) {
      assertEmptyTaskSummary(branch.summary);
    }

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

    for (const field of ['candidate_task_id', 'current_best_task_id', 'final_task_id'] as const) {
      const selection = await request('PATCH', '/api/video-cards/card-opening', { [field]: 'task-opening-1' });
      assert.equal(selection.status, 400);
      assertNoHiddenTaskIds(selection.data);
    }

    const moved = await request('PATCH', '/api/video-cards/card-opening/tasks', {
      action: 'move',
      target_video_card_id: 'card-detail',
      target_branch_id: null,
      task_ids: ['task-opening-1'],
    });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.data.moved_task_ids, []);
    assertNoHiddenTaskIds(moved.data);

    const mergedBranch = await request('PATCH', '/api/video-cards/card-opening/branches/branch-opening-detail', {
      action: 'merge',
      target_branch_id: 'branch-opening-main',
    });
    assert.equal(mergedBranch.status, 200);
    assertNoHiddenTaskIds(mergedBranch.data);

    const promotedBranch = await request('PATCH', '/api/video-cards/card-opening/branches/branch-opening-main', {
      action: 'promote_to_card',
      title: 'Preview branch promotion',
    });
    assert.equal(promotedBranch.status, 200);
    assertNoHiddenTaskIds(promotedBranch.data);

    const split = await request('POST', '/api/video-cards/card-opening/split', {
      title: 'Preview split',
      task_ids: ['task-opening-1'],
      reason: 'No hidden task move',
    });
    assert.equal(split.status, 201);
    assertNoHiddenTaskIds(split.data);

    const mergedCards = await request('POST', '/api/video-cards/card-detail/merge', {
      target_video_card_id: 'card-opening',
      reason: 'No hidden task merge',
    });
    assert.equal(mergedCards.status, 200);
    assertNoHiddenTaskIds(mergedCards.data);

    const bootstrapAfter = await request('GET', '/api/tools/ultimate-canvas/bootstrap');
    for (const card of bootstrapAfter.data.context.video_cards) {
      assertEmptyTaskSummary(card.summary);
    }

    const branchesAfter = await request('GET', '/api/video-cards/card-opening/branches');
    for (const branch of branchesAfter.data.branches) {
      assertEmptyTaskSummary(branch.summary);
    }

    console.log('ultimate-canvas-preview-no-generation-smoke passed');
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
