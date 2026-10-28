const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { ts, root, loader } = require('./audit-task-pagination-loader.cjs');
const files = ['image-studio-recovery-fairness-engineering.ts', 'image-dispatch-fairness-engineering.ts',
  'image-async-recovery-engineering.ts', 'multiview-flow-engineering.ts'];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function ast(source) { return ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true); }
function collect(source, select) {
  const tree = ast(source), nodes = [];
  const visit = node => { if (select(node, tree)) nodes.push(node); ts.forEachChild(node, visit); }; visit(tree); return { tree, nodes };
}
let proxy;
const factory = collect(read('src/lib/database/client.ts'), (node, tree) => ts.isVariableDeclaration(node) && node.name.getText(tree) === 'applicationDatabase');
assert.equal(factory.nodes.length, 1); proxy = factory.nodes[0].initializer.getText(factory.tree);
assert.equal(hash(proxy), '08d92e115ccb79d4586c22196e463714a1c2ee9148a9b13588fa931130082acf', '1e90abaf factory proxy body');
// Plain function receivers exercise the actual JS get trap only. No Prisma
// constructor, query result, native connection or business operation is mocked.
function structuralFacade(state) {
  const js = ts.transpileModule('const result = ' + proxy, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function('shared', 'initialize', 'disconnect', 'databaseTransactionStarted', 'databaseTransactionFinished', 'observeDatabaseError',
    js + '\nreturn result;')(() => state, async () => {}, async () => {}, () => {}, () => {}, () => {});
}
for (const file of files.slice(0, 3)) test('actual reference contract adapts to facade: ' + file, () => {
  const source = read('scripts/' + file);
  const old = collect(source, (node, tree) => ts.isCallExpression(node) && node.expression.getText(tree) === 'assert.equal'
    && node.arguments[0]?.getText(tree) === 'prisma' && /^observed(?:Database)?$/.test(node.arguments[1]?.getText(tree)));
  if (old.nodes.length) {
    const observed = {}, facade = structuralFacade({ extended: observed });
    assert.doesNotThrow(() => new Function('assert', 'prisma', old.nodes[0].arguments[1].getText(old.tree), old.nodes[0].getText(old.tree))(assert, facade, observed));
  } else {
    assert.match(source, /openRealFixtureDatabase\(databasePath\)/);
    assert.match(source, /await fixture\.verify\(\)/);
    assert.doesNotMatch(source, /new PrismaClient\(|setFixtureDatabase\(/);
  }
});
test('actual facade transaction interception must fire before the real target call', async () => {
  const source = read('scripts/multiview-flow-engineering.ts');
  const old = collect(source, (node, tree) => ts.isCallExpression(node) && node.expression.getText(tree) === 'Reflect.set'
    && node.arguments[0]?.getText(tree) === 'prisma' && node.arguments[1]?.getText(tree) === "'$transaction'");
  let calls = 0, fired = false; const events = [];
  const receiver = { async $transaction(value) { assert.equal(this, receiver); events.push('target'); return value; } };
  const state = { extended: receiver }, facade = structuralFacade(state);
  const before = async () => { events.push('before'); if (++calls === 2) fired = true; };
  if (old.nodes.length) {
    const transaction = facade.$transaction.bind(facade);
    assert.equal(Reflect.set(facade, '$transaction', async (...args) => { await before(); return transaction(...args); }), true);
  } else {
    const helper = loader()('scripts/fixtures/real-database-client.ts');
    state.extended = helper.wrapFixtureTransactions(receiver, before);
    assert.match(source, /fixture\.interceptTransactions\(/);
    assert.match(source, /assert\.equal\(calls, 3,/); assert.match(source, /assert\.equal\(revocations, 1,/);
    assert.match(source, /revoked_at, 'Race hook/);
  }
  assert.equal(await facade.$transaction(1), 1); assert.equal(await facade.$transaction(2), 2);
  assert.equal(calls, 2); assert.equal(fired, true); assert.deepEqual(events, ['before', 'target', 'before', 'target']);
});

const originals = [
  [79, '855ce84bfd98718d5aa2817c7125d77bf8b465ea0890b69b37e84c1910a6f7d3', 'b15cbd4bc9624dd2f6adcca63b56e1228967c9ed6cf2672b535068404a5a34ea'],
  [65, 'fd6b1fc9577a660cd0dd51129c19c0416a3dd21ea546dc09b0aeea444c32daa1', '2914b757203f63102f694b1abaec429379441913b2761822648790c97819fc8a'],
  [137, '663f447d25a90799d809aa8e5826c289cec8e25f15d1e612fb80024d004cbc7a', 'dddbfdd62a3398f4a7e7041f55c7e116bb036e34c128b5766dd86b5a8eaf6103'],
  [75, 'f59fb7c8f03c6e6960f19b6fc087d1a9cd44ca318b3c253e12bd48390eea7d33', null],
];
test('all356 original business assertions and three query observers remain exact', () => {
  for (const [index, file] of files.entries()) {
    const source = read('scripts/' + file), assertions = [], observers = [];
    const tree = ast(source); assert.equal(tree.parseDiagnostics.length, 0, file);
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(tree);
        if (expression.startsWith('assert.') && !(expression === 'assert.equal' && node.arguments[0]?.getText(tree) === 'prisma'
          && /^observed(?:Database)?$/.test(node.arguments[1]?.getText(tree)))
          && !/^['"](?:Race hook|Fixture factory)/.test(node.arguments.at(-1)?.getText(tree) || '')) assertions.push(node.getText(tree));
        if (expression.endsWith('.$extends')) observers.push(hash(node.arguments[0].getText(tree)));
      }
      ts.forEachChild(node, visit);
    }; visit(tree);
    assert.equal(assertions.length, originals[index][0], file); assert.equal(hash(assertions), originals[index][1], file);
    assert.deepEqual(observers, originals[index][2] ? [originals[index][2]] : [], file);
  }
});
test('binding helper requires real initialized SQLite evidence and never installs a fake shared state', () => {
  const source = read('scripts/fixtures/real-database-client.ts');
  assert.doesNotMatch(source, /new PrismaClient|setFixtureDatabase|Reflect\.set\(globalThis/);
  for (const fact of ['PRAGMA database_list', 'PRAGMA busy_timeout', 'clientsConstructed', 'sqliteConnectionLimit', 'state.sqlite', 'state.raw', 'state.file', 'state.mode']) assert.ok(source.includes(fact), fact);
  assert.match(source, /assertFreshFixtureFactory\(\)/); assert.match(source, /await prisma\.\$connect\(\)/);
  assert.match(source, /build\(expectedExtended\)/); assert.match(source, /state\.extended = observed/);
  assert.match(source, /state\.extended = previous/);
  assert.equal(ast(source).parseDiagnostics.length, 0);
});
