import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
const engineSource = readFileSync('public/tools/ultimate-canvas/canvas-engine.js', 'utf8');
const cssSource = readFileSync('public/tools/ultimate-canvas/styles.css', 'utf8');
const indexSource = readFileSync('public/tools/ultimate-canvas/index.html', 'utf8');
const routeSource = readFileSync('src/app/api/tools/ultimate-canvas/generate/route.ts', 'utf8');

assert.match(engineSource, /data-context-rules-open/);
assert.match(engineSource, /context-rules-button/);
assert.match(engineSource, /context-rules-card-button/);

assert.match(appSource, /function isCanvasAdmin\(\)/);
assert.match(appSource, /function contextRulesForNode/);
assert.match(appSource, /querySelectorAll\('\[data-context-rules-open\]'\)\.forEach/);
assert.match(appSource, /data-context-rules-modal/);
assert.match(appSource, /contextRules,/);
assert.match(appSource, /context_rules: contextRules/);
assert.match(appSource, /scheduleCanvasSave\('context_rules_change'\)/);
assert.match(appSource, /video_branch_id/);
assert.match(appSource, /data-video-branch-prompt-select/);
assert.match(appSource, /videoBranchId/);

assert.match(cssSource, /\.context-rules-button\s*\{/);
assert.match(cssSource, /\.node-context-rules-row\s*\{/);
assert.match(cssSource, /\.context-rules-card-button\s*\{/);
assert.match(cssSource, /\.is-canvas-admin \.node-type-text \.context-rules-button/);
assert.match(cssSource, /\.context-rules-button\.has-rules/);
assert.match(cssSource, /\.context-rules-modal/);

assert.match(indexSource, /styles\.css\?v=20260826-canvas-module-refresh/);
assert.match(indexSource, /canvas-engine\.js\?v=20260826-canvas-module-refresh/);
assert.match(indexSource, /app\.js\?v=20260826-canvas-module-refresh/);

assert.match(routeSource, /const rawContextRules =/);
assert.match(routeSource, /const contextRules = user\.role === 'admin' \? rawContextRules : ''/);
assert.match(routeSource, /admin_node_context_rules/);
assert.match(routeSource, /context_rules_applied/);
assert.match(routeSource, /context_rules_ignored/);

console.log('ultimate-canvas-context-rules-smoke passed');
