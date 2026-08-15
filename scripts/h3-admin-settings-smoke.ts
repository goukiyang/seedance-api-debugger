import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_H3_API_SETTINGS,
  H3_API_SETTING_KEY,
  H3_DEFAULT_BASE_URL,
  H3_DEFAULT_PRESET_ID,
  buildH3ApiSettingsPatch,
  isH3ApiReady,
  safeH3ConfigDto,
} from '@/lib/integrations/h3';

const current = {
  ...DEFAULT_H3_API_SETTINGS,
  enabled: false,
};

const saved = buildH3ApiSettingsPatch(current, {
  enabled: true,
  base_url: 'https://h3-api.example.com/',
  api_token: 'secret-h3-user-token-1234567890',
  admin_token: 'secret-h3-admin-token-1234567890',
  default_preset_id: 'larry_v4_8step',
});

assert.equal(H3_API_SETTING_KEY, 'h3_video_api_v1');
assert.equal(H3_DEFAULT_BASE_URL, 'http://127.0.0.1:8893');
assert.equal(H3_DEFAULT_PRESET_ID, 'larry_v4_6step');
assert.equal(saved.enabled, true);
assert.equal(saved.base_url, 'https://h3-api.example.com');
assert.equal(saved.api_token, 'secret-h3-user-token-1234567890');
assert.equal(saved.admin_token, 'secret-h3-admin-token-1234567890');
assert.equal(saved.default_preset_id, 'larry_v4_8step');
assert.equal(isH3ApiReady(saved), true);

const dto = safeH3ConfigDto(saved);
assert.equal(dto.provider, 'h3_video');
assert.equal(dto.enabled, true);
assert.equal(dto.ready, true);
assert.equal(dto.base_url, 'https://h3-api.example.com');
assert.equal(dto.default_preset_id, 'larry_v4_8step');
assert.equal(dto.health_path, '/health');
assert.equal(dto.presets_path, '/api/h3/presets');
assert.equal(dto.generate_path, '/api/h3/generate');
assert.equal(dto.api_token_configured, true);
assert.equal(dto.admin_token_configured, true);
assert.deepEqual(dto.missing, []);
assert.equal(JSON.stringify(dto).includes('secret-h3-user-token'), false);
assert.equal(JSON.stringify(dto).includes('secret-h3-admin-token'), false);

const clearedUserToken = buildH3ApiSettingsPatch(saved, { clear_api_token: true });
assert.equal(clearedUserToken.enabled, false);
assert.equal(clearedUserToken.api_token, null);
assert.equal(clearedUserToken.admin_token, saved.admin_token);
assert.equal(isH3ApiReady(clearedUserToken), false);

const clearedAdminToken = buildH3ApiSettingsPatch(saved, { clear_admin_token: true });
assert.equal(clearedAdminToken.enabled, true, 'admin token is not required for ordinary generation');
assert.equal(clearedAdminToken.api_token, saved.api_token);
assert.equal(clearedAdminToken.admin_token, null);
assert.equal(isH3ApiReady(clearedAdminToken), true);

async function main() {
  const routeModuleUrl = pathToFileURL(`${process.cwd()}/src/app/api/admin/integrations/h3/route.ts`).href;
  const routeModule = await import(routeModuleUrl);
  assert.equal(typeof routeModule.GET, 'function');
  assert.equal(typeof routeModule.PUT, 'function');
  assert.equal(typeof routeModule.POST, 'function');
  assert.equal(routeModule.dynamic, 'force-dynamic');

  const publicConfigRouteSource = fs.readFileSync(
    `${process.cwd()}/src/app/api/config/route.ts`,
    'utf8',
  );
  assert.ok(publicConfigRouteSource.includes('getH3ApiSettings'));
  assert.ok(publicConfigRouteSource.includes('h3_video'));
  assert.ok(publicConfigRouteSource.includes('api_token_configured'));
  assert.ok(!publicConfigRouteSource.includes('admin_token_configured: h3Config.admin_token'));

  const clientSource = fs.readFileSync(
    `${process.cwd()}/src/app/admin/integrations/AdminIntegrationsClient.tsx`,
    'utf8',
  );
  assert.ok(clientSource.includes('/api/admin/integrations/h3'));
  assert.ok(clientSource.includes('H3 本地生成服务'));
  assert.ok(clientSource.includes('h3-api-token'));
  assert.ok(clientSource.includes('h3-admin-token'));
  assert.ok(clientSource.includes('测试连接'));

  console.log('h3-admin-settings smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
