import assert from 'node:assert/strict';
import { buildSeedanceDraftContent, buildSeedanceDraftUpgradePayload, seedanceDraftCapability } from '@/lib/provider/seedance-draft';

async function main() {
  const previousCreateGate = process.env.SEEDANCE_DRAFT_CREATE_ENABLED;
  const previousUpgradeGate = process.env.SEEDANCE_DRAFT_UPGRADE_ENABLED;
  delete process.env.SEEDANCE_DRAFT_CREATE_ENABLED;
  delete process.env.SEEDANCE_DRAFT_UPGRADE_ENABLED;
  assert.equal(seedanceDraftCapability().upgrade_enabled, false, 'Draft 升级默认必须关闭');
  assert.deepEqual(buildSeedanceDraftContent('provider-draft-123'), [
    { type: 'draft_task', draft_task_id: 'provider-draft-123' },
  ]);

  const upgradePayload = buildSeedanceDraftUpgradePayload({
    model: 'dreamina-seedance-2-5-260628',
    providerDraftTaskId: 'provider-draft-123',
    clientRequestId: 'local-formal-task-123',
  });
  assert.deepEqual(upgradePayload.content, [{ type: 'draft_task', draft_task_id: 'provider-draft-123' }]);
  assert.equal(upgradePayload.resolution, '1080p');
  assert.equal('prompt' in upgradePayload, false);
  assert.equal('seed' in upgradePayload, false);
  assert.equal('ratio' in upgradePayload, false);
  assert.equal('duration' in upgradePayload, false);

  process.env.SEEDANCE_API_KEY = 'smoke-only-key';
  const calls: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    calls.push({ url: String(input), payload });
    return new Response(JSON.stringify({ id: `provider-task-${calls.length}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const { createVideoTask, createSeedanceDraftUpgradeTask } = await import('@/lib/provider/jimeng');
    await createVideoTask({
      prompt: 'smoke draft prompt',
      generation_mode: 'all_in_one_reference',
      model: 'dreamina-seedance-2-5-260628',
      ratio: '16:9',
      duration: 5,
      resolution: '720p',
      seed: 42,
      draft: true,
    });
    await createSeedanceDraftUpgradeTask({
      model: 'dreamina-seedance-2-5-260628',
      providerDraftTaskId: 'provider-draft-123',
      clientRequestId: 'local-formal-task-123',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCreateGate === undefined) delete process.env.SEEDANCE_DRAFT_CREATE_ENABLED;
    else process.env.SEEDANCE_DRAFT_CREATE_ENABLED = previousCreateGate;
    if (previousUpgradeGate === undefined) delete process.env.SEEDANCE_DRAFT_UPGRADE_ENABLED;
    else process.env.SEEDANCE_DRAFT_UPGRADE_ENABLED = previousUpgradeGate;
  }

  const draftCreatePayload = calls[0]?.payload;
  assert.equal(draftCreatePayload?.draft, true);
  const formalPayload = calls[1]?.payload;
  assert.deepEqual(formalPayload?.content, [{ type: 'draft_task', draft_task_id: 'provider-draft-123' }]);
  assert.equal(formalPayload?.resolution, '1080p');
  assert.equal('prompt' in formalPayload, false);
  assert.equal('seed' in formalPayload, false);
  assert.equal('ratio' in formalPayload, false);
  assert.equal('duration' in formalPayload, false);
  assert.equal('reference_image_urls' in formalPayload, false);

  console.log('seedance-draft-upgrade-smoke: PASS');
}

main().catch((error) => {
  console.error('seedance-draft-upgrade-smoke: FAIL');
  console.error(error);
  process.exitCode = 1;
});
