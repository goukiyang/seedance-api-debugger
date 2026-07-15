import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

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

async function waitForServerAt(url: string, getOutput: () => string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/__sd2-login`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`preview server did not start\n${getOutput()}`);
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

    const previewSource = await readFile('scripts/ultimate-canvas-preview-server.mjs', 'utf8');
    assert.match(previewSource, /const sd2LiveOrigin = 'https:\/\/sd2\.youdoodesign\.com';/);
    assert.match(previewSource, /proxySd2CanvasRequest\(request, response, \{/);
    assert.match(previewSource, /localOrigin: sd2LocalOrigin/);
    assert.match(previewSource, /consumeFeishuExchangePermit/);
    assert.ok(
      previewSource.indexOf('proxySd2CanvasRequest(request, response, {')
        < previewSource.indexOf("if (url.pathname === '/api/auth/me')"),
      'live API requests must proxy before local fixture routing',
    );
    assert.match(previewSource, /headers: \{ 'content-type': 'application\/json' \}/);
    assert.match(previewSource, /JSON\.stringify\(\{ identifier, password \}\)/);
    assert.match(previewSource, /id="login-error"/);

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

    const livePort = port + 1;
    const liveBaseUrl = `http://127.0.0.1:${livePort}`;
    const liveChild = spawn(process.execPath, [
      'scripts/ultimate-canvas-preview-server.mjs',
      String(livePort),
      '--sd2-live',
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let liveOutput = '';
    liveChild.stdout.on('data', (chunk) => { liveOutput += chunk.toString(); });
    liveChild.stderr.on('data', (chunk) => { liveOutput += chunk.toString(); });
    try {
      await waitForServerAt(liveBaseUrl, () => liveOutput);

      const canvas = await fetch(`${liveBaseUrl}/tools/ultimate-canvas/index.html?open=video-card`, {
        redirect: 'manual',
      });
      assert.equal(canvas.status, 302);
      assert.equal(
        canvas.headers.get('location'),
        '/__sd2-login?next=%2Ftools%2Fultimate-canvas%2Findex.html%3Fopen%3Dvideo-card',
      );

      const login = await fetch(`${liveBaseUrl}/__sd2-login`);
      assert.equal(login.status, 200);
      assert.equal(login.headers.get('cache-control'), 'no-store');
      assert.equal(login.headers.get('referrer-policy'), 'no-referrer');
      assert.match(login.headers.get('content-security-policy') || '', /default-src 'none'/);
      const bindingSetCookie = login.headers.get('set-cookie');
      assert(bindingSetCookie);
      assert.match(bindingSetCookie, /^sd2_feishu_relay_nonce=[A-Za-z0-9_-]{43};/);
      assert.match(bindingSetCookie, /HttpOnly/i);
      assert.match(bindingSetCookie, /SameSite=Lax/i);
      assert.match(bindingSetCookie, /Path=\/__sd2-feishu-callback/i);
      assert.match(bindingSetCookie, /Max-Age=300/i);
      assert.doesNotMatch(bindingSetCookie, /Domain=/i);
      const bindingCookie = bindingSetCookie.split(';', 1)[0];
      const bindingNonce = bindingCookie.slice(bindingCookie.indexOf('=') + 1);
      const loginHtml = await login.text();
      const feishuLink = loginHtml.match(/id="feishu-login" href="([^"]+)"/i);
      assert(feishuLink);
      const authorizeUrl = new URL(feishuLink[1].replaceAll('&amp;', '&'));
      assert.equal(authorizeUrl.origin, 'https://sd2.youdoodesign.com');
      assert.equal(authorizeUrl.pathname, '/api/auth/feishu/authorize');
      const relayMarker = new URL(authorizeUrl.searchParams.get('next') || '', authorizeUrl.origin);
      assert.equal(relayMarker.pathname, '/__sd2-feishu-local-relay');
      assert.equal(
        relayMarker.searchParams.get('callback'),
        `${liveBaseUrl}/__sd2-feishu-callback`,
      );
      assert.equal(relayMarker.searchParams.get('next'), '/tools/ultimate-canvas/index.html');
      assert.equal(relayMarker.searchParams.get('nonce'), bindingNonce);
      assert.match(loginHtml, /<form[^>]+method="post"[^>]+action="\/api\/auth\/login"/i);
      assert.match(loginHtml, /name="identifier"/i);
      assert.match(loginHtml, /name="password"/i);

      const callbackUrl = `${liveBaseUrl}/__sd2-feishu-callback?code=single-use-code&next=${encodeURIComponent('/tools/ultimate-canvas/index.html?open=video-card')}&nonce=${bindingNonce}`;
      for (const cookie of [undefined, `sd2_feishu_relay_nonce=${'b'.repeat(43)}`]) {
        const rejectedCallback = await fetch(callbackUrl, {
          headers: cookie ? { cookie } : undefined,
        });
        assert.equal(rejectedCallback.status, 200);
        assert.match(rejectedCallback.headers.get('set-cookie') || '', /sd2_feishu_relay_nonce=;.*Max-Age=0/i);
        const rejectedHtml = await rejectedCallback.text();
        assert.match(rejectedHtml, /window\.history\.replaceState/);
        assert.doesNotMatch(rejectedHtml, /\/api\/auth\/feishu\/login-by-code/);
        assert.doesNotMatch(rejectedHtml, /x-sd2-feishu-exchange-permit/);
        assert.doesNotMatch(rejectedHtml, /JSON\.stringify\(\{ code \}\)/);
      }

      const callback = await fetch(callbackUrl, { headers: { cookie: bindingCookie } });
      assert.equal(callback.status, 200);
      assert.equal(callback.headers.get('cache-control'), 'no-store');
      assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
      assert.match(callback.headers.get('content-security-policy') || '', /default-src 'none'/);
      assert.match(callback.headers.get('set-cookie') || '', /sd2_feishu_relay_nonce=;.*Max-Age=0/i);
      const callbackHtml = await callback.text();
      const clearHistoryIndex = callbackHtml.indexOf('window.history.replaceState');
      const exchangeIndex = callbackHtml.indexOf("fetch('/api/auth/feishu/login-by-code'");
      assert.ok(clearHistoryIndex >= 0);
      assert.ok(exchangeIndex > clearHistoryIndex, 'the callback query must be removed before code exchange');
      assert.match(callbackHtml, /body: JSON\.stringify\(\{ code \}\)/);
      assert.match(callbackHtml, /'x-sd2-feishu-exchange-permit': "[A-Za-z0-9_-]{43}"/);
      assert.doesNotMatch(callbackHtml, /session(?:_token)?=/i);
      assert.doesNotMatch(callbackUrl, /exchange-permit/i);

      const replayedCallback = await fetch(callbackUrl, { headers: { cookie: bindingCookie } });
      assert.equal(replayedCallback.status, 200);
      const replayedHtml = await replayedCallback.text();
      assert.match(replayedHtml, /window\.history\.replaceState/);
      assert.doesNotMatch(replayedHtml, /\/api\/auth\/feishu\/login-by-code/);
      assert.doesNotMatch(replayedHtml, /x-sd2-feishu-exchange-permit/);

      const loginRecovery = await fetch(`${liveBaseUrl}/login`);
      assert.equal(loginRecovery.status, 200);
      assert.match(await loginRecovery.text(), /id="login-error"/i);

      const unrelatedCookieCanvas = await fetch(`${liveBaseUrl}/tools/ultimate-canvas/index.html`, {
        headers: { cookie: 'theme=dark' },
        redirect: 'manual',
      });
      assert.equal(unrelatedCookieCanvas.status, 302);

      const sessionCanvas = await fetch(`${liveBaseUrl}/tools/ultimate-canvas/index.html`, {
        headers: { cookie: 'session=stale' },
        redirect: 'manual',
      });
      assert.equal(sessionCanvas.status, 200);

      const unsafeLogin = await fetch(`${liveBaseUrl}/__sd2-login?next=%2F%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
      assert.equal(unsafeLogin.status, 200);
      assert.doesNotMatch(await unsafeLogin.text(), /<script>alert\(1\)<\/script>/i);
    } finally {
      liveChild.kill();
    }

    const conflictChild = spawn(process.execPath, [
      'scripts/ultimate-canvas-preview-server.mjs',
      String(port + 2),
      '--mock-generation',
      '--sd2-live',
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const conflictExitCode = await new Promise<number | null>((resolve) => {
      conflictChild.once('exit', (code) => resolve(code));
    });
    assert.notEqual(conflictExitCode, 0);

    console.log('ultimate-canvas-preview-no-generation-smoke passed');
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
