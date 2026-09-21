import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  exceedsGenerationPromptLimit,
  GENERATION_PROMPT_LIMIT_MESSAGE,
  generationPromptLimitMessage,
  MAX_GENERATION_PROMPT_CHARS,
} from '../src/lib/prompt/limits';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

assert.equal(MAX_GENERATION_PROMPT_CHARS, 20_000);
assert.equal(exceedsGenerationPromptLimit('x'.repeat(MAX_GENERATION_PROMPT_CHARS)), false);
assert.equal(exceedsGenerationPromptLimit('x'.repeat(MAX_GENERATION_PROMPT_CHARS + 1)), true);
assert.match(GENERATION_PROMPT_LIMIT_MESSAGE, /20000/);
assert.equal(generationPromptLimitMessage('方案提示词'), '方案提示词最多 20000 字');

const promptEditor = read('src/components/PromptEditor.tsx');
const generationComposer = read('src/components/GenerationComposer.tsx');
const createRoute = read('src/app/api/tasks/create/route.ts');
const ipCreateRoute = read('src/app/api/ip/tasks/create/route.ts');

for (const [label, source] of [
  ['PromptEditor', promptEditor],
  ['GenerationComposer', generationComposer],
] as const) {
  assert.match(source, /MAX_GENERATION_PROMPT_CHARS/);
  assert.doesNotMatch(source, /(?:MAX_PROMPT_CHARS|MAX_CHARS)\s*=\s*2000/);
  assert.doesNotMatch(source, /提示词最多 2000 字/);
  assert.ok(source.length > 0, `${label} source should be readable`);
}

for (const [label, source] of [
  ['video create route', createRoute],
  ['IP create route', ipCreateRoute],
] as const) {
  assert.match(source, /exceedsGenerationPromptLimit\(body\.prompt\)/);
  assert.match(source, /exceedsGenerationPromptLimit\(agentPromptSnapshot\)/);
  assert.match(source, /exceedsGenerationPromptLimit\(finalPromptSnapshot\)/);
  assert.doesNotMatch(source, /slice\(0, 12000\)/);
  assert.ok(source.length > 0, `${label} source should be readable`);
}

assert.match(promptEditor, /当前 \$\{length\} 字/);

console.log('[generation-prompt-limit-smoke] ok');
