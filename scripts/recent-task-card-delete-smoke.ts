import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function readSource(path: string) {
  return readFileSync(path, 'utf8');
}

const generateSource = readSource('src/components/generate/GeneratePageClient.tsx');
const templateSource = readSource('src/components/templates/TemplateGenerateClient.tsx');
const listRouteSource = readSource('src/app/api/video/list/route.ts');
const deleteRouteSource = readSource('src/app/api/tasks/[id]/route.ts');
const globalCss = readSource('src/app/globals.css');

for (const [label, source] of [
  ['GeneratePageClient', generateSource],
  ['TemplateGenerateClient', templateSource],
] as const) {
  assert.match(source, /Trash2/, `${label} should use the shared trash icon`);
  assert.match(source, /className="composer-task-card-delete"/, `${label} should render the recent-card delete control`);
  assert.match(source, /window\.confirm\('从最近生成移除此记录？视频文件不会物理删除，管理员仍可在留存区审计和恢复。'\)/, `${label} should require a second confirmation`);
  assert.match(source, /fetch\(`\/api\/tasks\/\$\{task\.id\}`,[\s\S]*method: 'DELETE'/, `${label} should reuse the task soft-delete API`);
  assert.match(source, /setRecentTasks\(\(current\) => current\.filter\(\(item\) => item\.id !== task\.id\)\)/, `${label} should remove a deleted card from the visible recent list`);
}

assert.match(generateSource, /!isIpSurface && task\.can_delete !== false/, 'IP surface should not expose the internal task delete action');
assert.match(templateSource, /RECENT_TASK_INITIAL_PREFETCH_MAX_PAGES\s*=\s*4/, 'Template page should prefetch past no-preview first pages');
assert.match(templateSource, /visualCount\s*<\s*RECENT_TASK_INITIAL_MIN_VISUALS/, 'Template page should keep fetching until recent cards can show visual results');

assert.match(listRouteSource, /can_delete:/, 'List API should expose whether the current user can delete a recent task');
assert.match(listRouteSource, /ownerId && ownerId === currentUserId/, 'List API should only mark owner tasks as deletable');
assert.match(deleteRouteSource, /TASK_RETENTION_USER_DELETED/, 'Delete API should keep soft-delete retention semantics');
assert.match(deleteRouteSource, /action: 'user_delete_task'/, 'Delete API should write content audit for task removal');

assert.match(globalCss, /\.composer-task-card-delete\s*\{/, 'Recent-card delete control needs scoped CSS');
assert.match(globalCss, /\.composer-task-card:hover \.composer-task-card-delete/, 'Delete control should appear on hover');
assert.match(globalCss, /pointer-events: none/, 'Delete control should not intercept card clicks while hidden');

console.log('recent task card delete smoke passed');
