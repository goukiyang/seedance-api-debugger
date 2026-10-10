import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const baseline = '1f1f56c82a0078dc5d3229f3860547253c866750';
const read = (file: string) => readFileSync(file, 'utf8');
const prior = (file: string) => execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' });
function namedFunctions(source: string, file: string) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      result.set(node.name.text, node.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); return result;
}

const appFile = 'public/tools/ultimate-canvas/app.js';
const app = namedFunctions(read(appFile), appFile), oldApp = namedFunctions(prior(appFile), appFile);
const protectedFunctions = ['installGenerationAdapter', 'collectGenerationPayload', 'applyTextGenerationResult',
  'applyImageGenerationResult', 'applyVideoGenerationResult', 'recoverVideoSubmission', 'bindInlineVideo',
  'applyVideoTaskStatus', 'recheckBoundVideoNodes', 'pollVideoTask', 'submitNodeGeneration',
  'generationSettingsForNode', 'renderGenerationNodeControls', 'generationReferenceItems',
  'openReferenceImport', 'saveContextRulesModal', 'rulesTime', 'canvasGenerationQuotePayload'];
for (const name of protectedFunctions) {
  assert.ok(app.has(name) && oldApp.has(name), name);
  assert.equal(app.get(name), oldApp.get(name), `Protected actual generation/video/original/price logic: ${name}`);
}
const protectedFiles = ['src/lib/credits/policy.ts', 'src/lib/costs/ledger.ts',
  'src/app/tools/ultimate-canvas/CanvasFrame.tsx', 'src/lib/image-studio/worker.ts',
  'src/app/api/tools/ultimate-canvas/video-submission/route.ts', 'src/app/api/tools/ultimate-canvas/generate/route.ts',
  'src/app/api/tasks/create/route.ts', 'src/app/api/assets/generate/route.ts',
  'public/tools/ultimate-canvas/generation-node-workflow.js', 'public/tools/ultimate-canvas/generation-node-interactions.js',
  'src/lib/tools/toolflow-runtime.ts'];
for (const file of protectedFiles) assert.equal(read(file), prior(file), `Protected file ${file}`);
console.log(`PASS ${protectedFunctions.length} actual shared functions and ${protectedFiles.length} existing files remain unchanged`);

const commands: any = { module: { exports: {} } };
runInNewContext(read('public/tools/ultimate-canvas/canvas-commands.js'), commands);
const configuration = { definitionId: 'synthetic-role', version: 2, snapshot: { name: 'Synthetic' } };
const data = commands.module.exports.duplicateNodeData({ id: 'role-a', type: 'role', data: {
  roleConfig: configuration, roleTaskRunId: 'old-run', roleWorkId: 'old-work', roleAttemptId: 'old-attempt',
  roleDeliveryId: 'old-delivery', taskId: 'media-task', generationPayload: { replay: true },
} }, new Map(), new Map());
assert.equal(JSON.stringify(data.roleConfig), JSON.stringify(configuration));
for (const key of ['roleTaskRunId', 'roleWorkId', 'roleAttemptId', 'roleDeliveryId', 'taskId', 'generationPayload']) assert.equal(data[key], undefined, key);

const backend = require('../public/tools/ultimate-canvas/backend-contract.js');
for (const endpoint of ['/roles', '/roles/role-1?version=2', '/role-work?document_id=canvas-1',
  '/role-work/work-1', '/role-work/work-1/execute', '/role-runs', '/role-runs/run-1', '/role-join',
  '/role-attempts/attempt-1', '/role-receipts/mutation-1', '/role-deliveries/delivery-1/attachments/0',
  '/role-deliveries/delivery-1/attachments/19']) {
  const url = '/api/tools/ultimate-canvas' + endpoint;
  assert.equal(backend.resolveApiEndpoint(url, '', 'https://sd2.youdooart.com', 'canvas'), url);
  assert.equal(backend.resolveApiEndpoint('https://external.invalid' + url, '', 'https://sd2.youdooart.com', 'canvas'), '');
}
console.log('PASS role copies retain only pinned configuration; actual same-origin transport supports role APIs without cross-origin grants');
for (const endpoint of ['/role-deliveries/delivery-1/attachments/20', '/role-deliveries/delivery-1/attachments/-1',
  '/role-deliveries/delivery-1/attachments/0/other']) {
  assert.equal(backend.resolveApiEndpoint('/api/tools/ultimate-canvas' + endpoint, '', 'https://sd2.youdooart.com', 'canvas'), '');
}

for (const file of ['public/tools/ultimate-canvas/role-creator.js', 'public/tools/ultimate-canvas/role-workflow.js']) {
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const names = new Set<string>();
      for (const statement of node.statements) if (ts.isFunctionDeclaration(statement) && statement.name) {
        if (names.has(statement.name.text)) errors.push(statement.name.text);
        names.add(statement.name.text);
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set<string>();
      for (const property of node.properties) if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
        const name = property.name?.getText(tree);
        if (name && names.has(name)) errors.push(name);
        if (name) names.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.deepEqual(errors, [], `Duplicate declarations/properties ${file}`);
}
console.log('PASS both leaf actual ASTs have no duplicate same-scope handlers or object properties; no UI visual acceptance claimed');
