const assert = require('node:assert/strict');
const fs = require('node:fs');
require('tsx/cjs');
const { toVideoTaskView, videoTaskViewSelect } = require('../src/lib/dto/video-task.ts');
const { toUserSummary } = require('../src/lib/dto/user.ts');
const { videoTaskDetails } = require('../src/lib/dto/video-task-detail.ts');
const { taskDebugJson } = require('../src/lib/dto/task-debug.ts');
const schema = fs.readFileSync('prisma/schema.prisma', 'utf8').match(/model VideoTask \{([\s\S]*?)\n\}/)[1];
const columns = [...schema.matchAll(/^\s+(\w+)\s+(?:String|Int|Float|Boolean|DateTime)\b/gm)].map(match => match[1]);
const task = Object.fromEntries(columns.map(key => [key, `SENTINEL_${key}`]));
Object.assign(task, { id: 'synthetic-task', local_status: 'running', source_metadata_json: null, user_id: 'owner', owner_user_id: 'owner',
  owner: { id: 'owner', name: 'Name', email: 'private@example.invalid', phone: 'SENTINEL_phone', password_hash: 'SENTINEL_password' },
  future_secret: 'SENTINEL_future_secret', project: { id: 'project', name: 'Project', api_key: 'SENTINEL_project_secret' } });
const forbidden = ['callback_url', 'params_json', 'raw_status_response', 'raw_create_response', 'credit_freeze_snapshot',
  'provider_payload_json', 'reference_images_json', 'template_studio_snapshot_json', 'agent_prompt_snapshot', 'final_prompt_snapshot',
  'provider_cost_snapshot', 'provider_usage_snapshot', 'source_metadata_json', 'future_secret'];
const internalViewer = { id: 'owner', role: 'user', account_type: 'internal', feishu: { user_id: 'synthetic-feishu-owner' } };
for (const viewer of [{ ...internalViewer, id: 'member' }, internalViewer, { id: 'admin', role: 'admin' }, { id: 'owner', role: 'user', account_type: 'external' }]) {
  const view = toVideoTaskView(task, viewer);
  for (const key of forbidden) assert.equal(Object.hasOwn(view, key), false, `${viewer.id}:${key}`);
  assert.equal(view.id, task.id);
  assert.equal(JSON.stringify(view).includes('SENTINEL_project_secret'), false);
  assert.equal(JSON.stringify(view).includes('SENTINEL_password'), false);
  if (viewer.account_type === 'external') assert.equal(Object.hasOwn(view, 'provider_task_id'), false);
  else assert.equal(view.provider_task_id, task.provider_task_id);
}
assert.equal(toUserSummary(task.owner, { id: 'member', role: 'user' }).email, undefined);
assert.equal(toUserSummary(task.owner, { id: 'owner', role: 'user' }).email, 'private@example.invalid');
assert.equal(toUserSummary(task.owner, { id: 'admin', role: 'admin' }).email, 'private@example.invalid');
assert.equal(toUserSummary(task.owner, { id: 'admin', role: 'admin' }).password_hash, undefined);
assert.equal(videoTaskViewSelect.raw_create_response, undefined);
assert.equal(videoTaskViewSelect.credit_freeze_snapshot, undefined);
assert.equal(videoTaskViewSelect.owner.select.email, undefined);
for (const local_status of ['running', 'submitted', 'unknown', 'failed']) {
  const diagnostic = toVideoTaskView({ ...task, local_status,
    error_message: '处理详情 Authorization: Bearer DIAGNOSTIC_SECRET https://private.invalid/callback?token=CALLBACK_SECRET',
    delivery_error: 'https://private.invalid/file?signature=DELIVERY_SECRET' }, internalViewer);
  assert.doesNotMatch(JSON.stringify(diagnostic), /DIAGNOSTIC_SECRET|CALLBACK_SECRET|DELIVERY_SECRET|private\.invalid/,
    'Stored diagnostic credentials cannot become user error text');
  assert.equal(diagnostic.local_status, local_status);
}
assert.equal(toVideoTaskView({ ...task, error_message: '提交结果待确认，请查询原任务' }, internalViewer).error_message,
  '提交结果待确认，请查询原任务');
const sourceMedia = { ...task, result_video_url: 'https://private.invalid/result-secret.mp4',
  local_video_path: '/videos/private-secret.mp4', public_video_url: 'https://private.invalid/public-secret.mp4',
  result_last_frame_url: '/uploads/private-frame.png', reference_image_urls: JSON.stringify(['/uploads/private-input.png']),
  reference_video_urls: JSON.stringify(['https://private.invalid/input-video.mp4']), reference_audio_urls: '[]',
  first_frame_url: '/uploads/first-secret.png', last_frame_url: null, frame_image_urls: '[]' };
const browserMedia = toVideoTaskView(sourceMedia, internalViewer);
assert.doesNotMatch(JSON.stringify(browserMedia), /private\.invalid|private-secret|private-frame|private-input|first-secret/);
assert.equal(browserMedia.result_video_url, '/m/video/synthetic-task/preview');
assert.deepEqual(JSON.parse(browserMedia.reference_image_urls), ['/m/video-input/synthetic-task--image--0/preview']);
assert.equal(browserMedia.first_frame_url, '/m/video-input/synthetic-task--first--0/preview');
for (const id of ['bad/id', 'x'.repeat(181), null]) {
  const invalid = toVideoTaskView({ ...sourceMedia, id }, internalViewer);
  assert.doesNotMatch(JSON.stringify(invalid),
    /private\.invalid|private-secret|private-frame|private-input|first-secret/, 'Invalid identity cannot bypass the media projection');
  assert.equal(invalid.play_url, undefined);
}
assert.throws(() => toVideoTaskView({ id: 'unknown' }, { id: 'owner', role: 'user' }), /保护/);
const protectedTask = { ...task, source_metadata_json: JSON.stringify({ protected_module: { kind: 'multiview', schema: 1, recipeVersion: '1.0.1' } }) };
const protectedView = toVideoTaskView(protectedTask, { id: 'owner', role: 'admin' });
assert.equal(protectedView.prompt, '3D多视图');
assert.equal(JSON.stringify(protectedView).includes('SENTINEL_prompt'), false);
assert.equal(Object.hasOwn(protectedView, 'provider_task_id'), false);
const detailSource = { ...task, provider: 'h3', generation_mode: 'enhance_video', provider_cost_currency: null,
  provider_billing_status: null, provider_billing_time: null, provider_task_id: null, provider_client_request_id: null,
  raw_status_response: JSON.stringify({ data: { actual_cost: 1.5, currency: 'USD', usage: { total_tokens: 42 },
    progress_detail: { stage: 'rendering', elapsed_sec: 12 }, estimated_runtime_sec: 120, secret: 'RAW_SECRET' } }),
  provider_usage_snapshot: null, params_json: JSON.stringify({ source_task_id: 'source', tool_version: 'v2', fps: 24,
    secret: 'PARAM_SECRET', referenceAssets: [{ localAssetId: 'asset', providerAssetId: 'remote', originalUrl: '/m/asset/asset/preview',
      provider: 'test', name: 'Input', order: 1, password: 'REFERENCE_SECRET' }] }),
  provider_payload_json: JSON.stringify({ resolved_mode: 'image_to_video', api_key: 'PAYLOAD_SECRET' }) };
const details = videoTaskDetails(detailSource, internalViewer);
assert.equal(details.provider_billing.actualCost, 1.5);
assert.equal(details.provider_billing.usageTotalTokens, 42);
assert.equal(details.h3_runtime.estimatedRuntimeText, '约 2 分钟');
assert.equal(details.enhance_source_task_id, 'source');
assert.equal(details.enhance_details.fps, 24);
assert.equal(details.resolved_mode, 'image_to_video');
assert.equal(/RAW_SECRET|PARAM_SECRET|REFERENCE_SECRET|PAYLOAD_SECRET/.test(JSON.stringify(details)), false);
assert.equal(videoTaskDetails(detailSource, { id: 'owner', role: 'user', account_type: 'external' }).provider_billing, null);
const privateDetails = videoTaskDetails({ ...detailSource, source_metadata_json: protectedTask.source_metadata_json }, { id: 'owner', role: 'admin' });
assert.equal(privateDetails.provider_billing, null);
assert.equal(privateDetails.enhance_details, null);
assert.deepEqual(privateDetails.reference_assets, []);
const debug = taskDebugJson(JSON.stringify({ apiKey: 'API_SECRET', nested: { Authorization: 'Bearer AUTH_SECRET',
  value: 'Bearer TEXT_SECRET', url: 'https://user:PASS_SECRET@example.invalid/a?token=TOKEN_SECRET&safe=ok' }, status: 'running' }));
assert.equal(/API_SECRET|AUTH_SECRET|TEXT_SECRET|PASS_SECRET|TOKEN_SECRET/.test(debug), false);
assert.equal(JSON.parse(debug).status, 'running');
assert.equal(taskDebugJson('not-json WITH_SECRET').includes('WITH_SECRET'), false);
assert.equal(taskDebugJson('x'.repeat(2 * 1024 * 1024 + 1)).includes('xxxx'), false);
console.log('PASS VideoTask all-column sentinels, four viewer tiers, protected recipes and user summary boundaries');
console.log('PASS task-detail derived billing/runtime/enhancement and bounded administrator secret redaction');
