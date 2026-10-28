import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { inspectSource } from './check-static-core.mjs';

assert.equal(inspectSource('src/app/api/fixture/route.ts', "import sharp from 'sharp';").length, 1);
assert.equal(inspectSource('scripts/fixture.ts', "const decoder = require('sharp');").length, 1);
assert.equal(inspectSource('src/lib/fixture.ts', "const decoder = await import('sharp');").length, 1);
assert.equal(inspectSource('src/lib/fixture.ts', "import sharp from './media/sharp';").length, 0);
assert.equal(inspectSource('src/lib/fixture.ts', "import type { Metadata } from 'sharp';").length, 0);
assert.equal(inspectSource('src/lib/fixture.ts', "// import sharp from 'sharp';\nconst note = \"require('sharp')\";").length, 0);
console.log('PASS real parser rejects a direct-decoder mutation without rejecting comments');

const gate = readFileSync('scripts/check-image-recovery.mjs', 'utf8');
const requiredSources = new Map([
  ['scripts/template-author-cover-contract-engineering.ts', ['src/lib/media/storage-roots.ts']],
  ['scripts/image-provider-admin-engineering.ts', ['scripts/fixtures/source-function.ts']],
  ['scripts/projects-design-alignment-engineering.mjs', ['src/lib/dto/user.ts', 'src/lib/pagination/cursor.ts']],
  ['scripts/project-operations-engineering.ts', ['scripts/fixtures/source-function.ts']],
]);
function assertReceiptCoverage(text) {
  const ast = ts.createSourceFile('gate.mjs', text, ts.ScriptTarget.Latest, true);
  const covered = new Map();
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const field = name => node.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(ast) === name)?.initializer;
      const file = field('file'), sources = field('sources');
      if (file && ts.isStringLiteral(file) && requiredSources.has(file.text) && sources && ts.isArrayLiteralExpression(sources)) {
        covered.set(file.text, sources.elements.filter(ts.isStringLiteral).map(value => value.text));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const [file, dependencies] of requiredSources) for (const dependency of dependencies) {
    assert.ok(covered.get(file)?.includes(dependency), `Receipt hash coverage missing ${dependency} for ${file}`);
  }
}
assertReceiptCoverage(gate);
assert.throws(() => assertReceiptCoverage(gate.replace("'scripts/fixtures/source-function.ts'", "'scripts/fixtures/missing-function.ts'")));
console.log('PASS changed fixture dependencies remain bound to the recovery receipt hash manifest');
