import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SEEDANCE_2_0_MODEL_ID, SEEDANCE_2_5_MODEL_ID } from '../src/lib/provider/seedance-models';
import { calculateEstimatedCost } from '../src/lib/pricing';
import { seedanceVideoEditParameters, validateSeedanceEditMode, validateSeedanceEditReference,
  normalizeSeedanceEditPilot, isSeedanceEditPilotAllowed, validateRequestCostCeiling,
  type SeedanceProviderInput } from '../src/lib/provider/seedance-video-edit';

const url = 'https://example.test/action.mp4';
const reference = { url, width: 768, height: 768, durationSeconds: 4 };
const mode = { taskType: 'edit', provider: 'seedance', model: SEEDANCE_2_5_MODEL_ID, mode: 'all_in_one_reference' };
const contract = { urls: [url], reference, duration: 4, ratio: '1:1' };
const edit: SeedanceProviderInput = {
  prompt: '编辑视频，仅替换角色。', model: SEEDANCE_2_5_MODEL_ID,
  generation_mode: 'all_in_one_reference', omni_reference_task_type: 'edit',
  ratio: '1:1', duration: 4, resolution: '480p', generate_audio: false,
  reference_image_urls: ['https://example.test/identity.png'], reference_video_urls: [url],
  seedance_edit_reference: reference, clientRequestId: 'offline-edit-smoke',
};

async function main() {
  for (const value of [undefined, null, {}, { enabled: true }, { enabled: true, project_ids: [] },
    { enabled: true, project_ids: [''] }, { enabled: 'true', project_ids: ['project-a'] }]) {
    assert.equal(normalizeSeedanceEditPilot(value).enabled, false);
  }
  const pilot = { enabled: true, project_ids: ['project-a'] };
  assert.equal(isSeedanceEditPilotAllowed(pilot, 'project-a'), true);
  assert.equal(isSeedanceEditPilotAllowed(pilot, 'project-b'), false);
  assert.equal(isSeedanceEditPilotAllowed({ ...pilot, enabled: false }, 'project-a'), false);
  assert.equal(validateRequestCostCeiling(undefined, 18), null);
  assert.equal(validateRequestCostCeiling(18, 18), null);
  for (const ceiling of [17, 0, -1, 18.5, NaN, Infinity, '18', null]) assert.ok(validateRequestCostCeiling(ceiling, 18));
  assert.ok(validateRequestCostCeiling(18, NaN));
  // Exercise the existing admin config patch without constructing/connecting a DB.
  const runtime = globalThis as any;
  const previousPrisma = runtime.prisma;
  const previousPragmas = runtime.prismaSqlitePragmasStarted;
  runtime.prisma = new Proxy({}, { get() { throw new Error('Smoke must not access any database'); } });
  runtime.prismaSqlitePragmasStarted = true;
  try {
    const { buildCodexVideoApiSettingsPatch } = await import('../src/lib/integrations/codex');
    const existing = {
      enabled: true, source_label: 'Codex API', user_selector: { type: 'id' as const, value: 'fixture-user' },
      token_hash: 'sha256:' + '0'.repeat(64), token_preview: 'fixture',
    };
    const enable = buildCodexVideoApiSettingsPatch(existing, {
      enabled: true, user_selector: existing.user_selector, video_edit_pilot: pilot,
    });
    assert.deepEqual(enable.settings.video_edit_pilot, pilot);
    assert.equal(enable.settings.token_hash, existing.token_hash);
    assert.equal(enable.token_changed, false);
    const ordinaryAdminSave = buildCodexVideoApiSettingsPatch(enable.settings, {
      enabled: true, user_selector: existing.user_selector, source_label: 'updated label',
    });
    assert.deepEqual(ordinaryAdminSave.settings.video_edit_pilot, pilot);
    const disable = buildCodexVideoApiSettingsPatch(enable.settings, {
      enabled: true, user_selector: existing.user_selector, video_edit_pilot: { enabled: false, project_ids: ['project-a'] },
    });
    assert.equal(disable.settings.video_edit_pilot?.enabled, false);
    assert.equal(buildCodexVideoApiSettingsPatch(existing, { enabled: true }).settings.video_edit_pilot?.enabled, false);
  } finally {
    runtime.prisma = previousPrisma;
    runtime.prismaSqlitePragmasStarted = previousPragmas;
  }
  assert.equal(validateSeedanceEditMode(mode), null);
  assert.equal(validateSeedanceEditMode({ ...mode, taskType: undefined, provider: 'h3' }), null);
  for (const changed of [
    { taskType: 'edit_video' }, { taskType: 'auto' }, { taskType: null },
    { taskType: true }, { provider: 'h3' }, { model: SEEDANCE_2_0_MODEL_ID },
    { mode: 'first_last_frame' }, { mode: 'smart_multi_frame' }, { draft: true },
  ]) assert.ok(validateSeedanceEditMode({ ...mode, ...changed }));

  assert.equal(validateSeedanceEditReference(contract), null);
  assert.equal(validateSeedanceEditReference({ ...contract, duration: 5, reference: { ...reference, durationSeconds: 4.1 } }), null);
  for (const changed of [
    { urls: [] }, { urls: [url, url] }, { urls: ['https://example.test/other.mp4'] },
    { reference: null }, { reference: { ...reference, width: NaN } },
    { reference: { ...reference, height: 0 } }, { reference: { ...reference, height: 768.5 } },
    { reference: { ...reference, durationSeconds: NaN } },
    { reference: { ...reference, durationSeconds: 3.99 } },
    { reference: { ...reference, durationSeconds: 15.01 } },
    { reference: { ...reference, durationSeconds: 4.01 } },
    { duration: -1 }, { duration: 4.5 }, { duration: 5 }, { ratio: 'adaptive' }, { ratio: '16:9' },
  ]) assert.ok(validateSeedanceEditReference({ ...contract, ...changed }), JSON.stringify(changed));
  assert.equal(validateSeedanceEditReference({ ...contract, ratio: '16:9', reference: { ...reference, width: 1280, height: 720 } }), null);

  const originalInput = structuredClone(edit);
  assert.deepEqual(seedanceVideoEditParameters(edit), { omni_reference_task_type: 'edit', ratio: 'adaptive', duration: -1 });
  assert.deepEqual(edit, originalInput, 'Provider mapping must not mutate business input');
  assert.equal(calculateEstimatedCost('480p', edit.duration!, edit.model).estimatedCost, 18);
  assert.throws(() => seedanceVideoEditParameters({ ...edit, seedance_edit_reference: undefined }));

  const previousFetch = globalThis.fetch;
  const previousKey = process.env.SEEDANCE_API_KEY;
  const previousBase = process.env.SEEDANCE_BASE_URL;
  process.env.SEEDANCE_API_KEY = 'offline-fixture-not-a-real-key';
  process.env.SEEDANCE_BASE_URL = 'https://example.test/never-connect';
  const captured: Record<string, any>[] = [];
  let failProvider = false;
  globalThis.fetch = (async (_request, init) => {
    captured.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(failProvider
      ? { error: { code: 'InvalidParameter.TaskTypeConstraint', message: 'fixture provider rejection' } }
      : { id: 'offline-fixture-task' }), {
      status: failProvider ? 400 : 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const { createVideoTask } = await import('../src/lib/provider/jimeng');
    assert.equal((await createVideoTask(edit)).provider_task_id, 'offline-fixture-task');
    const payload = captured.at(-1)!;
    assert.equal(payload.duration, -1);
    assert.equal(payload.ratio, 'adaptive');
    assert.equal(payload.omni_reference_task_type, 'edit');
    assert.equal(payload.clientRequestId, edit.clientRequestId);
    assert.equal(payload.generate_audio, false);
    assert.equal(payload.resolution, '480p');
    assert.equal('seedance_edit_reference' in payload, false, 'Internal probe metadata must not be sent to provider');
    assert.deepEqual(payload.content.filter((v: any) => v.role).map((v: any) => v.role), ['reference_image', 'reference_video']);
    assert.deepEqual(edit, originalInput);

    for (const model of [SEEDANCE_2_0_MODEL_ID, SEEDANCE_2_5_MODEL_ID]) {
      for (const generation_mode of ['all_in_one_reference', 'first_last_frame', 'smart_multi_frame'] as const) {
        await createVideoTask({
          ...edit, model, generation_mode, omni_reference_task_type: undefined, seedance_edit_reference: undefined,
          first_frame_url: 'https://example.test/first.png', frame_image_urls: ['https://example.test/first.png', 'https://example.test/last.png'],
        });
        const ordinary = captured.at(-1)!;
        assert.equal(ordinary.duration, 4);
        assert.equal(ordinary.ratio, model === SEEDANCE_2_5_MODEL_ID && generation_mode === 'first_last_frame' ? 'adaptive' : '1:1');
        assert.equal('omni_reference_task_type' in ordinary, false);
      }
    }
    const beforeInvalid = captured.length;
    await assert.rejects(createVideoTask({ ...edit, duration: -1 as any }));
    await assert.rejects(createVideoTask({ ...edit, model: SEEDANCE_2_0_MODEL_ID }));
    await assert.rejects(createVideoTask({ ...edit, seedance_edit_reference: undefined }));
    assert.equal(captured.length, beforeInvalid, 'Invalid edit must fail before fetch');
    failProvider = true;
    await assert.rejects(createVideoTask(edit), /fixture provider rejection/);
    assert.equal(captured.length, beforeInvalid + 1, 'No automatic paid retry');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SEEDANCE_API_KEY; else process.env.SEEDANCE_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.SEEDANCE_BASE_URL; else process.env.SEEDANCE_BASE_URL = previousBase;
  }

  // Wiring checks supplement executed pure validation/provider tests, not DB acceptance.
  const route = fs.readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
  assert.ok(route.indexOf('if (editReferenceError)') < route.indexOf('const result = await prisma.$transaction'));
  assert.ok(route.indexOf('if (costCeilingError)') < route.indexOf('const result = await prisma.$transaction'));
  assert.ok(route.includes('editPilotSettings = codexContext.settings.video_edit_pilot'));
  assert.ok(route.includes('isSeedanceEditPilotAllowed(editPilotSettings, requestedVideoCard.project_id)'));
  assert.doesNotMatch(route, /body\.video_edit_pilot/);
  const config = fs.readFileSync('src/app/api/codex/config/route.ts', 'utf8');
  assert.ok(config.includes("omni_reference_task_type: editPilot.enabled ? ['edit'] : []"));
  assert.ok(config.includes('provider_verified: false'));
  assert.ok(route.includes('calculateEstimatedCost(resolution, duration, selectedModel)'));
  assert.ok(route.includes('requested_ratio: ratio, requested_duration: duration, ...seedanceVideoEditParameters(providerInput)'));
  assert.doesNotMatch(route, /body\.seedance_edit_reference/);
  assert.ok(route.includes("if (!VALID_DURATIONS.includes(duration))"));
  assert.ok(route.includes('if (videoCard.ratio_locked && videoCard.ratio && ratio !== videoCard.ratio)'));

  const source = process.argv[2];
  if (source) {
    const meta = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', source], { encoding: 'utf8' }));
    const actualReference = { url, width: meta.streams[0].width, height: meta.streams[0].height, durationSeconds: Number(meta.format.duration) };
    assert.equal(validateSeedanceEditReference({ ...contract, reference: actualReference }), null);
    console.log('actual input probe passed:', JSON.stringify({ width: actualReference.width, height: actualReference.height, duration: actualReference.durationSeconds }));
  }
  console.log('seedance-video-edit-smoke: PASS (offline fetch; no database, upload or provider charge)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
