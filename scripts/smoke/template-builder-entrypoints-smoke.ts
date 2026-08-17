import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const drawerSource = readFileSync(join(root, 'src/components/templates/TemplateEditorDrawer.tsx'), 'utf8');

const requiredSnippets = [
  '+ 新增模块（LLM）',
  'LLM 生成',
  '+ 新增规则（LLM）',
  'LLM 生成本类规则',
  'startModuleBuilder',
  'startRuleBuilder',
  'template-module-builder-panel',
  'template-rule-builder-panel',
  '/api/templates/module-builder/generate',
];

for (const snippet of requiredSnippets) {
  assert.ok(
    drawerSource.includes(snippet),
    `TemplateEditorDrawer 缺少入口闭环片段：${snippet}`,
  );
}

console.log('template-builder-entrypoints smoke passed');
