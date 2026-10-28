const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ts, root } = require('./audit-task-pagination-loader.cjs');
const hash = text => createHash('sha256').update(text).digest('hex');
const files = [
  'src/server/video-tasks/standard-create.ts', 'src/lib/tasks/seedance-draft-upgrade.ts',
  'src/lib/pricing/video-context.ts', 'src/lib/projects/permissions.ts', 'src/lib/video-cards/permissions.ts',
  'src/lib/template-studio/handoff.ts', 'src/lib/template-studio/assets.ts',
  'src/lib/template-studio/templates.ts', 'src/lib/template-studio/context.ts',
];
const trees = new Map(files.map(file => {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const result = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual((result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), [], file);
  return [file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)];
}));
function calls(tree, name, parent = tree) {
  const result = [];
  const visit = node => { if (ts.isCallExpression(node) && node.expression.getText(tree) === name) result.push(node); ts.forEachChild(node, visit); };
  visit(parent); return result;
}
function fn(tree, name) {
  return tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
}
// Exact admission tails and credential functions from 8c0c50e8. No Git runtime dependency.
const tails = ['5548ae7a7fcea845dd500395cc2c4e9f97dfc52b071f8753cf6f38059b64e362',
  '5f70d124aff15f9e8c8ec30102cc743429f07548ad01295cf0f1a3696f3f25f7'];
for (const [index, file] of files.slice(0, 2).entries()) {
  const tree = trees.get(file);
  const callback = calls(tree, 'prisma.$transaction').map(call => call.arguments[0])
    .find(node => node?.getText(tree).includes('resolveVideoPricingContext'));
  assert.ok(callback, file);
  const fresh = calls(tree, 'resolveVideoPricingContext', callback);
  assert.equal(fresh.length, 1); assert.equal(fresh[0].arguments[3]?.getText(tree), 'tx');
  assert.equal(fresh[0].arguments[2]?.getText(tree), index ? "'draft_upgrade'" : "'create'");
  const at = callback.body.statements.findIndex(node => node.getText(tree).includes('await createVideoTaskRecord('));
  assert.ok(at > 0); assert.equal(hash(callback.body.statements.slice(at).map(node => node.getText(tree)).join('\n')), tails[index], file + ' admission tail');
  assert.ok(calls(tree, 'withDatabaseObservationScope').some(call => call.arguments[0].text === (index ? 'video-task.draft-upgrade' : 'video-task.create')));
}
const pricing = trees.get(files[2]);
for (const [name, expected] of Object.entries({
  normalizedVideoPricingReferenceScope: 'a45b5512d5b0f6dfff0616a9846cd8f804e76e254baab6a7696cb774b4703323',
  savedVideoPricingContextInput: 'a8b1a5df0bbc3c800ad5e550e34100d0694aedd0a6d4a5b74abc38713c54b4c8',
  issueVideoPricingCredential: '9674cfbb8e7a38f200edb55b04a3c7c2130f605788d32ce86c3f9ca289c6e7e3',
  verifyVideoPricingCredential: '0ae6021719058e8491f6267c0468c1f0fa72fed675426d8c2959c4220cce5bc4',
  videoPricingBusinessFingerprint: '82429263551bbaebbe367faa6278327d3610583a7ded08cb63e3ec83f3625b61',
})) assert.equal(hash(fn(pricing, name).getText(pricing)), expected, name);
for (const name of ['assertCanGenerateInProject', 'assertCanGenerateInVideoCard', 'authorizeStudioRunForGeneration', 'authorizeStudioAssets']) {
  for (const call of calls(pricing, name, fn(pricing, 'resolveContext'))) assert.equal(call.arguments.at(-1).getText(pricing), 'db', name);
}
for (const [file, functions] of [
  [files[7], ['serializeStudioTemplate', 'getStudioTemplate']],
  [files[8], ['privateVideoContextTarget', 'writePrivateVideoContext', 'contextAccess']],
]) {
  const tree = trees.get(file);
  for (const name of functions) for (const callee of ['requirePrivatePromptRequest', 'privatePromptRequestCapabilities', 'getStudioTemplate']) {
    for (const call of calls(tree, callee, fn(tree, name))) assert.ok(['db', 'client', 'tx'].includes(call.arguments.at(-1).getText(tree)), name + ':' + callee);
  }
}
console.log(JSON.stringify({ syntaxFiles: files.length, transactionPrefixes: 2, originalAdmissionTails: 2,
  unchangedPricingCredentialFunctions: 5, explicitClientPropagation: true, needsIntegratedTypeAndNativeProof: true }));
