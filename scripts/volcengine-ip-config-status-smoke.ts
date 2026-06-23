import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  VOLCENGINE_IP_DEFAULT_BASE_URL,
  getVolcengineIpPublicConfigStatus,
} from '@/lib/provider/volcengine-ip';

const previousEnv = {
  VOLCENGINE_IP_API_KEY: process.env.VOLCENGINE_IP_API_KEY,
  VOLCENGINE_IP_MODEL: process.env.VOLCENGINE_IP_MODEL,
  VOLCENGINE_IP_BASE_URL: process.env.VOLCENGINE_IP_BASE_URL,
  ARK_API_KEY: process.env.ARK_API_KEY,
  ARK_MODEL: process.env.ARK_MODEL,
  ARK_BASE_URL: process.env.ARK_BASE_URL,
};

for (const key of Object.keys(previousEnv) as Array<keyof typeof previousEnv>) {
  delete process.env[key];
}

const missing = getVolcengineIpPublicConfigStatus();
assert.equal(missing.provider, 'volcengine_ip');
assert.equal(missing.ready, false);
assert.equal(missing.api_key_configured, false);
assert.equal(missing.model_configured, false);
assert.deepEqual(missing.missing, ['api_key', 'model']);
assert.equal(missing.base_url, VOLCENGINE_IP_DEFAULT_BASE_URL);
assert.equal(JSON.stringify(missing).includes('secret'), false);
assert.equal(JSON.stringify(missing).includes('api_key_masked'), false);

process.env.VOLCENGINE_IP_API_KEY = 'secret-volc-key-1234567890';
process.env.VOLCENGINE_IP_MODEL = 'doubao-seedance-2-0-fast-test';
process.env.VOLCENGINE_IP_BASE_URL = 'https://ark.example.com/api/v3/';

const ready = getVolcengineIpPublicConfigStatus();
assert.equal(ready.ready, true);
assert.equal(ready.api_key_configured, true);
assert.equal(ready.model_configured, true);
assert.deepEqual(ready.missing, []);
assert.equal(ready.base_url, 'https://ark.example.com/api/v3');
assert.equal(ready.model, 'doubao-seedance-2-0-fast-test');
assert.equal(JSON.stringify(ready).includes('secret-volc-key'), false);
assert.equal(JSON.stringify(ready).includes('secr...7890'), false);

async function main() {
  const routeModuleUrl = pathToFileURL(`${process.cwd()}/src/app/api/admin/integrations/volcengine-ip/route.ts`).href;
  const routeModule = await import(routeModuleUrl);
  assert.equal(typeof routeModule.GET, 'function');
  assert.equal(routeModule.dynamic, 'force-dynamic');

  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  console.log('volcengine-ip-config-status smoke passed');
}

main().catch((error) => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  throw error;
});
