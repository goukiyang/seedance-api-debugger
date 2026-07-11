import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  projectDisplayName,
  projectMetaLabel,
  projectRemovalAction,
} from '../src/lib/projects/display';
import {
  videoCardRemovalAction,
  videoCardSpecLabel,
  videoCardStatusLabel,
} from '../src/lib/video-cards/display';

function read(relativePath: string) {
  return readFileSync(relativePath, 'utf8');
}

function contains(source: string, needle: string, label: string) {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
}

function excludes(source: string, needle: string, label: string) {
  assert.ok(!source.includes(needle), `${label}: unexpected ${needle}`);
}

const personalProject = {
  name: '我的默认项目',
  type: 'personal',
  can_manage_project: true,
  _count: { tasks: 2, reference_albums: 1 },
};
assert.equal(projectDisplayName(personalProject), '个人空间');
assert.equal(projectMetaLabel(personalProject), '个人默认 · 2 任务 · 1 图集');
assert.equal(projectRemovalAction(personalProject), null);
assert.equal(projectRemovalAction({
  name: '空项目',
  type: 'team',
  can_manage_project: true,
  _count: { tasks: 0, reference_albums: 0 },
}), 'delete');
assert.equal(projectRemovalAction({
  name: '有内容项目',
  type: 'team',
  can_manage_project: true,
  _count: { tasks: 1, reference_albums: 0 },
}), 'archive');

assert.equal(videoCardStatusLabel('sealed'), '已封板');
assert.equal(videoCardSpecLabel({
  status: 'active',
  platform: '抖音',
  ratio: '9:16',
  duration: 5,
  target_resolution: '1080p',
}), '抖音 · 9:16 · 5s · 1080p');
assert.equal(videoCardRemovalAction({ status: 'active', summary: { task_count: 0 } }, true), 'discard');
assert.equal(videoCardRemovalAction({ status: 'active', summary: { task_count: 2 } }, true), 'archive');
assert.equal(videoCardRemovalAction({ status: 'active', branch_count: 1, summary: { task_count: 0 } }, true), 'archive');
assert.equal(videoCardRemovalAction({ status: 'archived', summary: { task_count: 2 } }, true), null);

const bootstrap = read('src/app/api/tools/ultimate-canvas/bootstrap/route.ts');
contains(bootstrap, "role: { not: 'viewer' }", 'normal user project list excludes viewers');
contains(bootstrap, 'owner: { select:', 'bootstrap returns project and card owners');
contains(bootstrap, 'reference_albums:', 'bootstrap returns album counts');
contains(bootstrap, 'can_manage_project:', 'bootstrap returns project management permission');
contains(bootstrap, 'prisma.videoTask.groupBy', 'bootstrap returns video card task counts without cost totals');
contains(bootstrap, 'prisma.videoBranch.groupBy', 'bootstrap returns video card branch counts');
contains(bootstrap, 'savedVideoCardId', 'bootstrap restores saved video card context');
excludes(bootstrap, 'api_key', 'bootstrap does not expose provider keys');
excludes(bootstrap, 'base_url', 'bootstrap does not expose provider base URL');

const app = read('public/tools/ultimate-canvas/app.js');
contains(app, 'data-context-toggle="project"', 'project custom picker exists');
contains(app, 'data-context-toggle="video-card"', 'video card custom picker exists');
excludes(app, 'data-context-project', 'project picker is not a native select');
excludes(app, 'data-context-video-card', 'video card picker is not a native select');
contains(app, "flushCanvasSave('before_project_change')", 'project switching saves old context');
contains(app, 'clearCanvasForContext()', 'project switching clears stale canvas');
contains(app, 'documentProjectId === projectId', 'save uses project-bound document id');
contains(app, "formData.set('canvas_node_id', canvasNodeId)", 'upload carries canvas node id');
contains(app, "client_name: 'ultimate_canvas'", 'video generation identifies canvas client');
contains(app, "source: 'ultimate_canvas'", 'video generation carries canvas source metadata');
contains(app, 'status_endpoint_template', 'polling uses backend status endpoint template');
contains(app, 'window.setTimeout(poll, delay)', 'polling is serialized with timeout');
excludes(app, 'window.setInterval(poll', 'polling does not overlap with interval');
excludes(app, 'api.openai.com', 'frontend does not call OpenAI directly');
excludes(app, 'api_key', 'frontend does not accept provider keys');
excludes(app, 'base_url', 'frontend does not accept provider base URLs');

const videoCardRoute = read('src/app/api/video-cards/[id]/route.ts');
contains(videoCardRoute, "lifecycleAction === 'archive' || lifecycleAction === 'discard'", 'video card route exposes scoped lifecycle actions');
contains(videoCardRoute, 'prisma.videoBranch.count', 'discard checks video card branches');
contains(videoCardRoute, '不能废弃；请改为归档', 'cards with history cannot be discarded');
excludes(videoCardRoute, 'export async function DELETE', 'video cards are not hard deleted');

const styles = read('public/tools/ultimate-canvas/styles.css');
contains(styles, '.canvas-context-menu', 'context menu styles exist');
contains(styles, '.canvas-confirm-overlay', 'confirmation modal styles exist');
contains(styles, '.node-generation-status', 'generation status styles exist');

console.log('ultimate-canvas-complete-smoke passed');
