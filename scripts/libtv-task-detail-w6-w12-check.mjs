import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const taskPage = readFileSync(new URL('../src/app/tasks/[id]/page.tsx', import.meta.url), 'utf8');
const taskCss = readFileSync(new URL('../src/app/tasks/[id]/TaskResult.module.css', import.meta.url), 'utf8');
const studioCss = readFileSync(new URL('../src/app/image-studio/studio.module.css', import.meta.url), 'utf8');

assert.ok(taskPage.includes('navigator.clipboard.writeText(task.id)'), 'W6 must copy the original task ID');
assert.ok(taskPage.includes('<code className={resultStyles.taskIdText}>{task.id}</code>'), 'W6 must render the full task ID');
assert.ok(taskPage.includes('复制失败，可选中编号复制'), 'W6 must preserve a selectable fallback after copy failure');
assert.match(taskCss, /\.taskIdText[^}]*word-break:\s*break-all/);
assert.match(taskCss, /\.taskIdText[^}]*user-select:\s*text/);

assert.ok(taskPage.includes('authorizeTaskReuseHref(taskActionHref, ownerId)'), 'W9 must authorize explicit current-tab reuse');
assert.equal(taskPage.match(/onClick=\{isEnhanceTask \? undefined : handleTaskReuseClick\}/g)?.length, 2, 'both task-detail reuse entries must use the scoped intent');

assert.match(studioCss, /\.moduleBannerHasImage\s*\{[^}]*block-size:\s*180px/);
assert.match(studioCss, /\.moduleBannerImage\s*\{[^}]*position:\s*absolute[^}]*inline-size:\s*100%[^}]*block-size:\s*auto[^}]*translateY\(-50%\)/);

console.log('W6/W9/W12 static source contract passed');
