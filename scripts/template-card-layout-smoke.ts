import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
const component = readFileSync(join(process.cwd(), 'src/components/templates/TemplateContextCardsPanel.tsx'), 'utf8');

const requiredCssSnippets = [
  'grid-template-columns: 20px 76px minmax(260px, 1fr) 92px;',
  'scrollbar-gutter: stable;',
  '-webkit-line-clamp: 2;',
  'grid-template-rows: auto minmax(40px, 1fr) auto;',
  'width: 92px;',
  'grid-template-columns: repeat(3, minmax(0, 1fr));',
];

for (const snippet of requiredCssSnippets) {
  assert.ok(css.includes(snippet), `missing layout guard: ${snippet}`);
}

const requiredComponentSnippets = [
  'template-context-card-list',
  'template-context-card-body',
  'template-context-card-actions',
  'template-context-card-controls',
  'template-context-thumb',
];

for (const snippet of requiredComponentSnippets) {
  assert.ok(component.includes(snippet), `missing component structure: ${snippet}`);
}

console.log('template-card-layout-smoke passed');
