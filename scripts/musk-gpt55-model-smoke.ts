import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = process.cwd();
const runtimeFiles = [
  'src/lib/integrations/musk.ts',
  'src/app/admin/integrations/AdminIntegrationsClient.tsx',
  'src/app/api/tools/ultimate-canvas/bootstrap/route.ts',
  'src/components/GenerationComposer.tsx',
  'scripts/ultimate-canvas-preview-server.mjs',
  'public/tools/ultimate-canvas/app.js',
  'public/tools/ultimate-canvas/index.html',
  'public/tools/ultimate-canvas/canvas-engine.js',
];

for (const file of runtimeFiles) {
  const source = readFileSync(resolve(projectRoot, file), 'utf8');
  assert.ok(source.includes('gpt-5.5') || source.includes('GPT-5.5'));
  assert.ok(!source.includes('gpt-5.4'));
  assert.ok(!source.includes('gpt5.4'));
}

console.log('Musk GPT-5.5 model smoke passed.');
