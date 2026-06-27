import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  AIMEDIAKIT_API_SETTING_KEY,
  buildAiMediaKitApiSettingsPatch,
  isAiMediaKitApiReady,
  safeAiMediaKitConfigDto,
} from '@/lib/integrations/aimediakit';

const current = {
  enabled: false,
  base_url: 'https://mediakit.cn-beijing.volces.com',
  api_key: null,
};

const saved = buildAiMediaKitApiSettingsPatch(current, {
  enabled: true,
  base_url: 'https://mediakit.example.com/',
  api_key: 'secret-aimediakit-key-1234567890',
});

assert.equal(AIMEDIAKIT_API_SETTING_KEY, 'aimediakit_enhance_video_api_v1');
assert.equal(saved.enabled, true);
assert.equal(saved.base_url, 'https://mediakit.example.com');
assert.equal(saved.api_key, 'secret-aimediakit-key-1234567890');
assert.equal(isAiMediaKitApiReady(saved), true);

const dto = safeAiMediaKitConfigDto(saved);
assert.equal(dto.provider, 'aimediakit_enhance_video');
assert.equal(dto.enabled, true);
assert.equal(dto.ready, true);
assert.equal(dto.api_key_configured, true);
assert.equal(dto.enhance_video_path, '/api/v1/tools/enhance-video');
assert.equal(dto.task_status_path, '/api/v1/tasks/{task_id}');
assert.equal(dto.request_upload_path, '/api/v1/tools-sync/request-media-upload-url');
assert.equal(JSON.stringify(dto).includes('secret-aimediakit-key'), false);
assert.equal(JSON.stringify(dto).includes('api_key_masked'), false);

const cleared = buildAiMediaKitApiSettingsPatch(saved, { clear_api_key: true });
assert.equal(cleared.enabled, false);
assert.equal(cleared.api_key, null);
assert.equal(isAiMediaKitApiReady(cleared), false);

const baseUrlOnlyPatch = buildAiMediaKitApiSettingsPatch(saved, {
  base_url: 'https://mediakit-next.example.com',
});
assert.equal(baseUrlOnlyPatch.enabled, true);
assert.equal(baseUrlOnlyPatch.base_url, 'https://mediakit-next.example.com');
assert.equal(baseUrlOnlyPatch.api_key, saved.api_key);

async function main() {
  const routeModuleUrl = pathToFileURL(`${process.cwd()}/src/app/api/admin/integrations/aimediakit/route.ts`).href;
  const routeModule = await import(routeModuleUrl);
  assert.equal(typeof routeModule.GET, 'function');
  assert.equal(typeof routeModule.PUT, 'function');
  assert.equal(routeModule.dynamic, 'force-dynamic');

  const clientSource = fs.readFileSync(
    `${process.cwd()}/src/app/admin/integrations/AdminIntegrationsClient.tsx`,
    'utf8',
  );
  assert.ok(clientSource.includes('/api/admin/integrations/aimediakit'));
  assert.ok(clientSource.includes('aimediakit-api-key'));
  assert.ok(clientSource.includes('AI MediaKit 视频超分 API'));
  assert.ok(clientSource.includes('autoComplete="new-password"'));

  const standaloneSource = fs.readFileSync(
    `${process.cwd()}/src/app/admin/integrations/aimediakit/page.tsx`,
    'utf8',
  );
  assert.ok(standaloneSource.includes('AdminIntegrationsClient'));

  console.log('aimediakit-admin-settings smoke passed');
}

main().catch((error) => {
  throw error;
});
