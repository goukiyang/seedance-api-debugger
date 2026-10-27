const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ts, root } = require('./audit-task-pagination-loader.cjs');
const reference = process.env.AUD_STATIC_ARCHIVE_REF;
const checkers = ['check-task-seedance-pagination.cjs', 'check-seedance-selector-pagination.cjs', 'check-multiview-record-pagination.cjs'];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-gitless-pagination-'));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const originalScalePath = 'scripts/verify-audit-scale-db-hd-server.ts';
// Only tracked source text is materialized. No public/media files or Git data.
if (reference) {
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', reference, 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
    .filter(file => /^src\//.test(file) && /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file));
  const archive = execFileSync('git', ['archive', reference, ...names], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', directory], { input: archive });
} else {
  const copySources = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) copySources(file);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file)) {
        fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        fs.copyFileSync(path.join(root, file), path.join(directory, file));
      }
    }
  };
  copySources('src');
}
fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
for (const name of [...checkers, 'audit-task-pagination-loader.cjs', 'pagination-static-baseline.cjs', 'pagination-static-baseline.json', path.basename(originalScalePath)]) {
  const source = path.join(root, 'scripts', name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(directory, 'scripts', name));
}
const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
fs.symlinkSync(process.execPath, path.join(bin, 'node'));
assert.equal(fs.existsSync(path.join(directory, '.git')), false);
const run = name => spawnSync(process.execPath, [path.join(directory, 'scripts', name)], { cwd: directory,
  env: { ...process.env, PATH: bin, AUD_NODE_MODULES: process.env.AUD_NODE_MODULES || path.join(root, 'node_modules') }, encoding: 'utf8', maxBuffer: 1024 * 1024 });
for (const command of ['git', 'rg']) assert.equal(spawnSync(command, ['--version'], { env: { ...process.env, PATH: bin } }).error?.code, 'ENOENT');
for (const name of checkers) test('gitless integrated archive runs ' + name, () => {
  const result = run(name); assert.equal(result.status, 0, result.stderr || result.stdout);
});

const scaleFile = () => fs.readFileSync(path.join(root, originalScalePath), 'utf8');
const parse = source => ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function calls(source, predicate) {
  const tree = parse(source), result = [];
  const visit = node => { if (ts.isCallExpression(node) && predicate(node, tree)) result.push(node); ts.forEachChild(node, visit); };
  visit(tree); return { tree, result };
}
function indexAssertion(source) {
  const { tree, result } = calls(source, (node, tree) => node.expression.getText(tree) === 'assert.ok'
    && node.arguments[0]?.getText(tree).includes('Asset_original_url_idx'));
  assert.equal(result.length, 1); return result[0].getText(tree);
}
test('SCALE index assertion accepts real BigInt plan columns and still rejects a table scan', () => {
  const check = new Function('assert', 'plan', indexAssertion(scaleFile()));
  assert.doesNotThrow(() => check(assert, [{ id: 2n, parent: 0n, notused: 0n, detail: 'SEARCH Asset USING INDEX Asset_original_url_idx (original_url=?)' }]));
  assert.throws(() => check(assert, [{ id: 2n, parent: 0n, detail: 'SCAN Asset' }]), error => error.code === 'ERR_ASSERTION');
});
test('offline guards still reject exact original function and whole-file drift', () => {
  for (const [checker, file, from, to] of [
    [checkers[0], 'src/components/SeedanceAssetPanel.tsx', 'handleProviderDelete =', 'handleProviderDelete = /* synthetic drift */'],
    [checkers[1], 'src/components/SeedanceAssetSelector.tsx', 'handleMoveDown =', 'handleMoveDown = /* synthetic drift */'],
    [checkers[2], 'src/app/multiview/MultiviewRecords.tsx', 'function RecordCard(', 'function RecordCard( /* synthetic drift */'],
    [checkers[1], 'src/app/api/assets/list/route.ts', '', '\n'],
  ]) {
    const target = path.join(directory, file), before = fs.readFileSync(target, 'utf8');
    const after = from ? before.replace(from, to) : before + to; assert.notEqual(after, before);
    try { fs.writeFileSync(target, after); const result = run(checker); assert.notEqual(result.status, 0, file);
      assert.match(result.stderr, /original.*changed|baseline.*changed/i); }
    finally { fs.writeFileSync(target, before); }
  }
});
test('offline inventory still rejects an extra direct or hook consumer without rg', () => {
  const file = path.join(directory, 'src/components/UnexpectedAssetConsumer.tsx');
  for (const marker of ['/api/assets/list', 'useSeedanceAssetPages(']) {
    try {
      fs.writeFileSync(file, 'export const syntheticMarker = ' + JSON.stringify(marker) + ';\n');
      const result = run(checkers[1]); assert.notEqual(result.status, 0); assert.match(result.stderr, /UnexpectedAssetConsumer/);
    } finally { fs.rmSync(file, { force: true }); }
  }
});
test('SCALE retains all integrated hard assertions and synthetic queries', () => {
  const signature = source => {
    const { tree, result } = calls(source, (node, tree) => /^assert\.|^prisma\.\$|^tx\.\$|^hdReadRepository\.|^(?:requestHd|readHdJob|validateHdOwner|lookupLegacyHdOwner)$/.test(node.expression.getText(tree)));
    return result.map(node => node.expression.getText(tree) === 'assert.ok' && node.arguments[0]?.getText(tree).includes('Asset_original_url_idx')
      ? 'index-condition:' + node.arguments[0].getText(tree) : node.getText(tree));
  };
  const current = signature(scaleFile()), expected = require('./pagination-static-baseline.json').scale;
  assert.equal(current.length, expected.criticalCallCount);
  assert.equal(createHash('sha256').update(JSON.stringify(current)).digest('hex'), expected.criticalCallsSha256);
});
test('SCALE cause diagnostics are serializable, classified and confidential', () => {
  const tree = parse(scaleFile()); let node;
  const visit = item => { if (ts.isFunctionDeclaration(item) && item.name?.text === 'safeScaleProofCause') node = item; ts.forEachChild(item, visit); };
  visit(tree); assert.ok(node, 'safeScaleProofCause');
  const js = ts.transpileModule(node.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const safe = new Function('createHash', js + '\nreturn safeScaleProofCause;')(createHash);
  const known = safe(new TypeError('Do not know how to serialize a BigInt'));
  assert.equal(known.name, 'TypeError'); assert.match(known.message, /BigInt/);
  const db = safe(Object.assign(new Error('token=DO_NOT_LOG password=DO_NOT_LOG file:/private/sensitive.db'), { code: 'P2022', meta: { secret: 'DO_NOT_LOG' } }));
  assert.equal(db.code, 'P2022'); assert.match(db.message, /column/); assert.doesNotMatch(JSON.stringify(db), /DO_NOT_LOG|sensitive|private\//);
  const numeric = safe(Object.assign(new Error('DO_NOT_LOG'), { name: 'AssertionError', code: 'ERR_ASSERTION', actual: 32n, expected: 33n }));
  assert.doesNotThrow(() => JSON.stringify(numeric)); assert.match(numeric.message, /32.*33/);
  const unknown = safe({ name: 'DO_NOT_LOG', code: 'DO_NOT_LOG', message: 'DO_NOT_LOG' });
  assert.doesNotMatch(JSON.stringify(unknown), /DO_NOT_LOG/);
});
