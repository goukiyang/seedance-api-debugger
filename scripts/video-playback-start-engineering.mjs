import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = process.cwd();
const file = path.join(root, 'src/app/api/video/play/[id]/route.ts');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const checks = [];
const ready = { id: 'fixture-video', local_video_path: '/videos/fixture.mp4',
  public_video_url: 'https://stable.fixture.invalid/video.mp4', result_video_url: 'https://provider.fixture.invalid/video.mp4' };

async function play({ task = ready, user = { id: 'fixture' }, allowed = true, size = 100, missing = false, method = 'GET' } = {}) {
  const calls = [];
  class AuthError extends Error { status = 403; }
  const exports = {};
  const dependencies = {
    'fs/promises': { stat: async () => { calls.push('stat'); if (missing) throw new Error('ENOENT'); return { isFile: () => true, size }; } },
    'next/server': { NextResponse: { json: (body, options) => ({ status: options.status, body }),
      redirect: (url, status) => ({ status, url }) } },
    '@/lib/prisma': { prisma: { videoTask: { findUnique: async () => { calls.push('task'); return task; } } } },
    '@/lib/auth/session': { AuthError, getSession: async () => user },
    '@/lib/projects/permissions': { assertCanViewTask: async () => { calls.push('permission'); if (!allowed) throw new AuthError('denied'); } },
    '@/lib/video/thumbnail': { isSafeTaskId: () => true, localPublicVideoPath: value => value ? `/fixture/public${value}` : null },
    '@/lib/media/preview-response': { mediaPreviewResponse: async (request, source, mime) => {
      calls.push('local-stream'); return { status: 206, method: request.method, source, mime, range: request.headers.get('range') };
    } },
  };
  vm.runInNewContext(code, { exports, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`); return dependencies[name];
  } }, { filename: file });
  const request = new Request('https://site.fixture.invalid/api/video/play/fixture-video', { method, headers: { Range: 'bytes=0-63' } });
  const response = await exports[method](request, { params: { id: 'fixture-video' } });
  return { response, calls };
}

const local = await play();
assert.equal(local.response.status, 206);
assert.equal(local.response.source, ready.local_video_path);
assert.equal(local.response.range, 'bytes=0-63');
assert.deepEqual(local.calls, ['task', 'permission', 'stat', 'local-stream']);
checks.push('authorized_local_original_precedes_external_url_and_preserves_range');
const head = await play({ method: 'HEAD' });
assert.equal(head.response.method, 'HEAD');
checks.push('head_uses_same_authorized_local_source');
for (const options of [{ missing: true }, { size: 0 }, { task: { ...ready, local_video_path: null } }]) {
  const { response } = await play(options);
  assert.equal(response.status, 302); assert.equal(response.url, ready.public_video_url);
}
checks.push('missing_empty_or_unavailable_local_file_falls_back_to_stable_url');
assert.equal((await play({ task: { ...ready, local_video_path: null, public_video_url: null } })).response.url, ready.result_video_url);
assert.equal((await play({ task: { ...ready, local_video_path: null, public_video_url: null, result_video_url: 'h3-internal-output://fixture' } })).response.status, 425);
checks.push('provider_fallback_and_internal_output_wait_are_preserved');
const denied = await play({ allowed: false });
assert.equal(denied.response.status, 403); assert.ok(!denied.calls.includes('stat'));
const anonymous = await play({ user: null });
assert.equal(anonymous.response.status, 401); assert.deepEqual(anonymous.calls, []);
assert.equal((await play({ task: null })).response.status, 404);
checks.push('permission_and_session_checks_precede_all_media_sources');
console.log(JSON.stringify({ task: 'VID-START01', checks, browserAcceptance: false, modelCalls: 0 }, null, 2));
