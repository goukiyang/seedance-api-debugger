import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 46000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['scripts/ultimate-canvas-preview-server.mjs', String(port)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ULTIMATE_CANVAS_MOCK: '1',
    MOCK_GENERATION: 'true',
    ENABLE_MOCK: 'true',
  },
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

function assertNoMockProjectTaskCount(project: {
  _count?: { tasks?: unknown };
  meta_label?: unknown;
} | null | undefined) {
  assert.ok(project);
  assert.equal(project._count?.tasks, 0);
  assert.match(String(project.meta_label || ''), /0\s*任务/);
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
    const realBackendRequiredMessage = bootstrap.data.capabilities.video.message;
    assert.match(realBackendRequiredMessage, /未连接 SD2/);
    for (const project of bootstrap.data.context.projects) {
      assertNoMockProjectTaskCount(project);
    }
    for (const card of bootstrap.data.context.video_cards) {
      assertEmptyTaskSummary(card.summary);
      assertNoMockProjectTaskCount(card.project);
    }

    const cardDetail = await request('GET', '/api/video-cards/card-opening');
    assert.equal(cardDetail.status, 200);
    assertNoMockProjectTaskCount(cardDetail.data.video_card.project);

    const cardList = await request('GET', '/api/projects/project-personal/video-cards');
    assert.equal(cardList.status, 200);
    for (const card of cardList.data.video_cards) {
      assertNoMockProjectTaskCount(card.project);
    }

    const projectUpdate = await request('PATCH', '/api/projects/project-personal', {});
    assert.equal(projectUpdate.status, 200);
    assertNoMockProjectTaskCount(projectUpdate.data.project);

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
      ['POST', '/api/approvals', {
        type: 'ratio_change',
        project_id: 'project-personal',
        video_card_id: 'card-opening',
      }],
    ] as const) {
      const result = await request(attempt[0], attempt[1], attempt[2]);
      assert.equal(result.status, 503);
      assert.equal(result.data.error, 'REAL_BACKEND_REQUIRED');
      assert.equal(result.data.message, realBackendRequiredMessage);
      assert.doesNotMatch(JSON.stringify(result.data), /task-mock-|asset-generated-|approval-mock-|result_video_url/);
    }

    const tasks = await request('GET', '/api/video-cards/card-opening/tasks');
    assert.equal(tasks.status, 200);
    assert.deepEqual(tasks.data.tasks, []);

    for (const payload of [
      { candidate_task_id: 'task-opening-1' },
      { current_best_task_id: null },
      { final_task_id: '' },
    ]) {
      const selection = await request('PATCH', '/api/video-cards/card-opening', payload);
      assert.equal(selection.status, 503);
      assert.equal(selection.data.error, 'REAL_BACKEND_REQUIRED');
      assert.equal(selection.data.message, realBackendRequiredMessage);
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
