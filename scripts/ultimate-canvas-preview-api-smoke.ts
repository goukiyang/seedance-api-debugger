import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 45000 + Math.floor(Math.random() * 1000);
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
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  }
  return data;
}

const get = (path: string) => request('GET', path);
const post = (path: string, payload: unknown) => request('POST', path, payload);
const patch = (path: string, payload: unknown) => request('PATCH', path, payload);

async function main() {
  try {
    await waitForServer();

  const bootstrap = await get('/api/tools/ultimate-canvas/bootstrap');
  const projectId = bootstrap.context.selected_project_id as string;
  const cardId = bootstrap.context.selected_video_card_id as string;
  assert.ok(projectId);
  assert.ok(cardId);

  const detail = await get(`/api/video-cards/${cardId}`);
  assert.equal(detail.video_card.id, cardId);
  assert.equal(detail.permissions.can_manage, true);

  const updated = await patch(`/api/video-cards/${cardId}`, {
    title: '本机闭环主卡',
    objective: '验证完整视频卡工作流',
    ratio: '16:9',
    duration: 5,
    target_resolution: '720p',
  });
  assert.equal(updated.video_card.title, '本机闭环主卡');

  const createdBranch = await post(`/api/video-cards/${cardId}/branches`, {
    title: '动作方向',
    description: '快速运动镜头',
  });
  const branchId = createdBranch.branch.id as string;
  assert.ok(branchId);
  await patch(`/api/video-cards/${cardId}/branches/${branchId}`, { action: 'set_primary' });

  const task = await post('/api/tasks/create', {
    project_id: projectId,
    video_card_id: cardId,
    video_branch_id: branchId,
    prompt: '本机视频闭环测试',
  });
  const taskId = (task.id || task.task_id) as string;
  assert.ok(taskId);
  assert.equal(task.frozen_cost, 0);

  const firstPoll = await get(`/api/video/status/${taskId}?refresh=true`);
  const secondPoll = await get(`/api/video/status/${taskId}?refresh=true`);
  assert.equal(firstPoll.local_status, 'running');
  assert.equal(secondPoll.local_status, 'succeeded');

  const taskList = await get(`/api/video-cards/${cardId}/tasks`);
  assert.equal(taskList.tasks.find((item: { id: string }) => item.id === taskId)?.video_branch_id, branchId);
  await patch(`/api/video-cards/${cardId}`, { candidate_task_id: taskId });

  const retried = await post(`/api/video/retry/${taskId}`, {});
  const retriedTaskId = (retried.id || retried.task_id) as string;
  assert.ok(retriedTaskId);
  assert.notEqual(retriedTaskId, taskId);
  assert.equal(retried.video_branch_id, branchId);

  const target = await post(`/api/projects/${projectId}/video-cards`, {
    title: '本机闭环目标卡',
    objective: '迁移目标',
  });
  const targetCardId = target.video_card.id as string;
  assert.ok(targetCardId);

  const targetBranch = await post(`/api/video-cards/${targetCardId}/branches`, {
    title: '目标方向',
  });
  const targetBranchId = targetBranch.branch.id as string;
  await patch(`/api/video-cards/${cardId}/tasks`, {
    action: 'move',
    target_video_card_id: targetCardId,
    target_branch_id: targetBranchId,
    task_ids: [taskId],
    reason: '本机闭环迁移',
  });

  const split = await post(`/api/video-cards/${targetCardId}/split`, {
    title: '本机闭环拆分卡',
    task_ids: [taskId],
    reason: '拆分验证',
  });
  const splitCardId = (split.new_card?.id || split.video_card?.id) as string;
  assert.ok(splitCardId);

  await post(`/api/video-cards/${splitCardId}/merge`, {
    target_video_card_id: cardId,
    reason: '合并闭环验证',
  });

  const approval = await post('/api/approvals', {
    type: 'ratio_change',
    project_id: projectId,
    video_card_id: cardId,
    reason: '本机闭环审批',
    payload: {
      source: 'ultimate_canvas',
      target_ratio: '9:16',
      change_reason: '本机闭环审批',
    },
  });
  assert.equal(approval.approval.status, 'pending');

  const documentJson = JSON.stringify({
    context: { project_id: projectId, video_card_id: cardId, video_branch_id: branchId },
    canvas: { nodes: [{ id: 'node-local' }], connections: [], viewport: {} },
  });
  await post('/api/tools/ultimate-canvas/document', {
    project_id: projectId,
    document_json: documentJson,
  });
  const restored = await get(`/api/tools/ultimate-canvas/document?project_id=${projectId}`);
  assert.equal(restored.document.document_json, documentJson);

    console.log('ultimate-canvas-preview-api-smoke passed');
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
