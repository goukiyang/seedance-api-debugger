import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_H3_API_SETTINGS,
  H3_API_SETTING_KEY,
  H3_DEFAULT_BASE_URL,
  H3_DEFAULT_LORA_ID,
  H3_DEFAULT_PRESET_ID,
  H3_HEALTH_MAX_AGE_MS,
  buildH3ApiSettingsPatch,
  h3HealthSnapshotFromResponse,
  isH3ApiReady,
  isH3Operational,
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
  default_lora_id: 'larry_v4_turbo_lora',
});

assert.equal(H3_API_SETTING_KEY, 'h3_video_api_v1');
assert.equal(H3_DEFAULT_BASE_URL, 'http://127.0.0.1:8893');
assert.equal(H3_DEFAULT_PRESET_ID, 'lightx2v_4step_turbo');
assert.equal(H3_DEFAULT_LORA_ID, 'lightx2v_turbo_lora');
assert.equal(H3_HEALTH_MAX_AGE_MS, 15 * 60 * 1000);
assert.equal(saved.enabled, true);
assert.equal(saved.base_url, 'https://h3-api.example.com');
assert.equal(saved.api_token, 'secret-h3-user-token-1234567890');
assert.equal(saved.admin_token, 'secret-h3-admin-token-1234567890');
assert.equal(saved.default_preset_id, 'larry_v4_8step');
assert.equal(saved.default_lora_id, 'larry_v4_turbo_lora');
assert.equal(isH3ApiReady(saved), true);
assert.equal(isH3Operational(saved), false, '配置齐全但没健康检查时不能开放 H3');

const dto = safeH3ConfigDto(saved);
assert.equal(dto.provider, 'h3_video');
assert.equal(dto.enabled, true);
assert.equal(dto.configured, true);
assert.equal(dto.ready, false);
assert.equal(dto.base_url, 'https://h3-api.example.com');
assert.equal(dto.default_preset_id, 'larry_v4_8step');
assert.equal(dto.health_path, '/health');
assert.equal(dto.presets_path, '/api/h3/presets');
assert.equal(dto.generate_path, '/api/h3/generate');
assert.equal(dto.api_token_configured, true);
assert.equal(dto.admin_token_configured, true);
assert.equal(dto.default_lora_id, 'larry_v4_turbo_lora');
assert.equal(dto.lora_options[0]?.id, 'lightx2v_turbo_lora');
assert.equal(dto.lora_options[1]?.id, 'larry_v4_turbo_lora');
assert.equal(dto.lora_options[2]?.id, 'lightx2v_8step_lora');
assert.deepEqual(dto.missing, []);
assert.equal(JSON.stringify(dto).includes('secret-h3-user-token'), false);
assert.equal(JSON.stringify(dto).includes('secret-h3-admin-token'), false);

const healthy = {
  ...saved,
  health: h3HealthSnapshotFromResponse({
    api: 'ok',
    version: 'h3-api-0.3.2',
    public_base_url: null,
    worker_url: 'http://127.0.0.1:8894',
    default_preset: 'lightx2v_4step_turbo',
    preset_count: 3,
    billing: { charged: false, cost: 0, currency: null, cost_model: 'free_local' },
    worker: { worker: 'ok', comfyui: 'ok' },
    queue: { paused: false, pending: 0, running: 0, max_pending_jobs: 20, active: 0, max_active_jobs: 1 },
  }, {
    presets: [
      {
        id: 'lightx2v_4step_turbo',
        estimated_runtime_sec: 89,
        recommended_timeout_sec: 300,
        runtime_policy: 'benchmark_estimated',
      },
      {
        id: 'larry_v4_6step',
        estimated_runtime_sec: 266.96,
        recommended_timeout_sec: 630,
        runtime_policy: 'benchmark_estimated',
      },
      {
        id: 'larry_v4_8step',
        estimated_runtime_sec: 342.14,
        recommended_timeout_sec: 750,
        runtime_policy: 'benchmark_estimated',
      },
    ],
  }),
};
assert.equal(isH3Operational(healthy), true);
const healthyDto = safeH3ConfigDto(healthy);
assert.equal(healthyDto.ready, true);
assert.equal(healthyDto.admin_queue_ready, true);
assert.equal(healthyDto.health?.api, 'ok');
assert.equal(healthyDto.health?.version, 'h3-api-0.3.2');
assert.equal(healthyDto.health?.public_base_url, null);
assert.equal(healthyDto.health?.worker, 'ok');
assert.equal(healthyDto.health?.comfyui, 'ok');
assert.equal(healthyDto.health?.billing?.charged, false);
assert.equal(healthyDto.health?.billing?.cost, 0);
assert.equal(healthyDto.health?.billing?.cost_model, 'free_local');
assert.equal(healthyDto.health?.queue?.paused, false);
assert.equal(healthyDto.health?.queue?.pending, 0);
assert.equal(healthyDto.health?.queue?.max_pending_jobs, 20);
assert.equal(healthyDto.preset_options[0]?.id, 'lightx2v_4step_turbo');
assert.equal(healthyDto.preset_options[0]?.recommended_timeout_sec, 300);
assert.equal(healthyDto.preset_options[0]?.estimated_runtime_sec, 89);
assert.equal(healthyDto.preset_options[0]?.runtime_policy, 'benchmark_estimated');
assert.ok(healthyDto.preset_options[0]?.detail.includes('建议等待 约 5 分钟'));

const staleHealthy = {
  ...healthy,
  health: {
    ...healthy.health,
    checked_at: new Date(Date.now() - H3_HEALTH_MAX_AGE_MS - 1000).toISOString(),
  },
};
assert.equal(isH3Operational(staleHealthy), false, '健康快照过期时不能继续开放 H3');
assert.equal(safeH3ConfigDto(staleHealthy).ready, false);

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
assert.equal(isH3Operational(clearedAdminToken), false);

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
  assert.ok(publicConfigRouteSource.includes('configured'));
  assert.ok(publicConfigRouteSource.includes('default_lora_id'));
  assert.ok(publicConfigRouteSource.includes('lora_options'));
  assert.ok(publicConfigRouteSource.includes('base_url_configured: Boolean(h3Config.base_url)'));
  assert.ok(publicConfigRouteSource.includes('health'));
  assert.ok(publicConfigRouteSource.includes('version: h3Config.health.version'));
  assert.ok(publicConfigRouteSource.includes('billing: h3Config.health.billing'));
  assert.ok(publicConfigRouteSource.includes('queue: h3Config.health.queue'));
  assert.ok(publicConfigRouteSource.includes('api_token_configured'));
  assert.ok(!publicConfigRouteSource.includes('base_url: h3Config.base_url'));
  assert.ok(!publicConfigRouteSource.includes('admin_token_configured: h3Config.admin_token'));
  assert.ok(!publicConfigRouteSource.includes('worker_url: h3Config.health.worker_url'));
  assert.ok(!publicConfigRouteSource.includes('public_base_url: h3Config.health.public_base_url'));

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
