import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  VOLCENGINE_IP_API_SETTING_KEY,
  buildVolcengineIpApiSettingsPatch,
  isVolcengineIpApiReady,
  safeVolcengineIpConfigDto,
} from '@/lib/integrations/volcengine-ip';

const current = {
  enabled: false,
  base_url: 'https://ark.cn-beijing.volces.com/api/v3',
  default_model: '',
  api_key: null,
};

const saved = buildVolcengineIpApiSettingsPatch(current, {
  enabled: true,
  base_url: 'https://ark.example.com/api/v3/',
  default_model: 'doubao-seedance-2-0-fast-test',
  api_key: 'fixture-volc-key-1234567890',
});

assert.equal(VOLCENGINE_IP_API_SETTING_KEY, 'volcengine_ip_api_v1');
assert.equal(saved.enabled, true);
assert.equal(saved.base_url, 'https://ark.example.com/api/v3');
assert.equal(saved.default_model, 'doubao-seedance-2-0-fast-test');
assert.equal(saved.api_key, 'fixture-volc-key-1234567890');
assert.equal(isVolcengineIpApiReady(saved), true);

const dto = safeVolcengineIpConfigDto(saved);
assert.equal(dto.enabled, true);
assert.equal(dto.ready, true);
assert.equal(dto.api_key_configured, true);
assert.equal(dto.model_configured, true);
assert.equal(JSON.stringify(dto).includes('fixture-volc-key'), false);

const cleared = buildVolcengineIpApiSettingsPatch(saved, { clear_api_key: true });
assert.equal(cleared.enabled, false);
assert.equal(cleared.api_key, null);
assert.equal(isVolcengineIpApiReady(cleared), false);

async function main() {
  const routeModuleUrl = pathToFileURL(`${process.cwd()}/src/app/api/admin/integrations/volcengine-ip/route.ts`).href;
  const routeModule = await import(routeModuleUrl);
  assert.equal(typeof routeModule.GET, 'function');
  assert.equal(typeof routeModule.PUT, 'function');
  assert.equal(typeof routeModule.POST, 'function');
  assert.equal(routeModule.dynamic, 'force-dynamic');

  const clientSource = fs.readFileSync(
    `${process.cwd()}/src/app/admin/integrations/AdminIntegrationsClient.tsx`,
    'utf8',
  );
  assert.ok(clientSource.includes('/api/admin/integrations/volcengine-ip'));
  assert.ok(clientSource.includes('volcengine-api-key'));
  assert.ok(clientSource.includes('火山 IP 生成 API'));
  assert.ok(clientSource.includes('autoComplete="new-password"'));

  console.log('volcengine-ip-admin-settings smoke passed');
}

main().catch((error) => {
  throw error;
});
