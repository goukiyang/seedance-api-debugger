const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = createRequire(path.join(process.env.AUD_NODE_MODULES || path.resolve('node_modules'), 'package.json'))('typescript');
const read = file => fs.readFileSync(file, 'utf8');
const native = read('src/lib/database/readonly-hd.ts');
assert.match(native, /new sqlite\.DatabaseSync\(file, \{ readOnly: true \}\)/);
assert.doesNotMatch(native, /@prisma|immutable|db\.(?:exec|run|createSession|applyChangeset|loadExtension)\(/);
assert.match(native, /assertReadonlyDatabaseMount\(file/);
const entry = read('src/lib/media/hd-readonly-db.ts');
assert.doesNotMatch(entry, /from ['"].*database\/client/);
assert.match(entry, /databaseProcessMode === 'readonly'/);
assert.match(read('src/lib/database/client.ts'), /function shared\(\): Shared \{\s+assertDatabaseWriterMode\(\)/);
const script = read('scripts/process-hd-derivatives.ts');
assert.ok(script.startsWith("import './hd-readonly-runtime.cjs';"));
assert.doesNotMatch(script, /limitInputPixels: false|prisma\./);
assert.match(script, /openUntrustedImage\(input.file, 'hd', \{ animated: true \}\)/);
for (const file of ['src/lib/database/process-mode.ts', 'src/lib/database/location.ts', 'src/lib/database/readonly-mount.ts', 'src/lib/database/readonly-hd.ts',
  'src/lib/media/hd-read-repository.ts', 'src/lib/media/hd-prisma-read.ts', 'src/lib/media/hd-readonly-db.ts', 'src/lib/media/hd-owner.ts',
  'src/lib/media/hd-discovery.ts', 'scripts/process-hd-derivatives.ts', 'scripts/verify-audit-strict-readonly-linux.ts']) {
  const result = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.equal(result.diagnostics?.filter(value => value.category === ts.DiagnosticCategory.Error).length || 0, 0, file);
}
console.log('strict readonly source/syntax contracts passed; not native/Linux/Prisma acceptance');
