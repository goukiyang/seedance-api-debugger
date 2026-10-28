const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader, ts } = require('./audit-task-pagination-loader.cjs');
const phase = process.env.SQL01_VIDEO_RECIPE_PHASE || 'red'; assert.match(phase, /^[a-z0-9_-]+$/i);
const validation = loader()('src/lib/template-studio/validation.ts');
const results = [];
for (const file of ['scripts/verify-sql01-video-tx-server.cjs', 'scripts/sql01-video-fixture.cjs']) {
  const text = fs.readFileSync(file, 'utf8'), tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = []; const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'recipe') declarations.push(node); ts.forEachChild(node, visit); }; visit(tree);
  assert.equal(declarations.length, 1);
  try {
    const initial = declarations[0].initializer.getText(tree);
    const seeded = new Function('validation', 'normalizeRecipe', `return (${initial});`)(validation, validation.normalizeRecipe);
    assert.doesNotThrow(() => validation.normalizeRecipe(seeded), 'Seeded template must satisfy the real business validator before a database run');
    assert(seeded.instruction.trim().length > 0); assert.equal(seeded.assetSlots[0].types[0], 'video');
    results.push({ file, ok: true });
  } catch (error) { results.push({ file, ok: false, className: error.constructor.name, message: error.message }); }
}
assert.throws(() => validation.normalizeRecipe({ instruction: '', fields: [], assetSlots: [], defaultParameters: {} }), error => error.name === 'StudioValidationError');
const evidence = { phase, realNormalizeRecipe: true, syntheticOnly: true, nativePrismaExecuted: false, results, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
fs.writeFileSync(`.role-tests/sql01-video-recipe-${phase}.json`, JSON.stringify(evidence, null, 2), { flag: 'wx' }); console.log(JSON.stringify(evidence));
if (evidence.failed) process.exitCode = 1;
