import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function assertContains(content: string, needle: string, label: string) {
  if (!content.includes(needle)) {
    throw new Error(`${label} missing: ${needle}`);
  }
}

function assertBefore(content: string, first: string, second: string, label: string) {
  const firstIndex = content.indexOf(first);
  const secondIndex = content.indexOf(second);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex > secondIndex) {
    throw new Error(`${label} order mismatch`);
  }
}

const route = read('src/app/api/admin/outputs/route.ts');
assertContains(route, 'generation_mode: true', 'admin outputs API generation mode select');
assertContains(route, 'provider: true', 'admin outputs API provider select');
assertContains(route, "is_enhance_task: task.generation_mode === 'enhance_video' || task.provider === 'volcengine_mediakit'", 'admin outputs API enhance flag');

const client = read('src/app/admin/outputs/AdminOutputsClient.tsx');
assertContains(client, 'is_enhance_task: boolean;', 'admin outputs client item type');
assertContains(client, 'output.is_enhance_task', 'admin outputs client enhance condition');
assertContains(client, 'status-badge status-badge-enhance', 'admin outputs client enhance badge class');
assertContains(client, '超分', 'admin outputs client enhance badge label');
assertBefore(
  client,
  'output.is_enhance_task',
  'localStatusClass(output.local_status)',
  'admin outputs enhance badge before status badge',
);
assertBefore(
  client,
  'output.is_enhance_task',
  'retentionClass(output.retention_status)',
  'admin outputs enhance badge before retention badge',
);

const css = read('src/app/globals.css');
assertContains(css, '.status-badge-enhance', 'global enhance status badge style');

console.log('admin-outputs-enhance-badge smoke passed');
