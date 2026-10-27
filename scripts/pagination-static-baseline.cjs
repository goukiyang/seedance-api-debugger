const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ts } = require('./audit-task-pagination-loader.cjs');
const baseline = require('./pagination-static-baseline.json');
assert.equal(baseline.version, 1);
assert.equal(baseline.algorithm, 'sha256-exact-source-and-typescript-node-text');
const sha = value => createHash('sha256').update(value).digest('hex');

// Exact original text, not a relaxed behavioral approximation. These hashes
// were read once from the documented commits; archives need no Git history.
exports.assertOriginalNode = (file, name) => {
  const expected = baseline.nodes[file];
  assert.ok(expected && /^[a-f0-9]{64}$/.test(expected.sha256[name] || ''), `missing baseline ${file}#${name}`);
  const source = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(tree.parseDiagnostics.length, 0, file);
  let text;
  const visit = node => {
    const matches = expected.kind === 'variable' ? ts.isVariableDeclaration(node) : expected.kind === 'function' ? ts.isFunctionDeclaration(node)
      : expected.kind === 'declaration' && (ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node));
    if (matches && node.name?.getText(tree) === name) text = node.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(text, `missing original declaration ${file}#${name}`);
  assert.equal(sha(text), expected.sha256[name], `original contract changed: ${file}#${name} (${expected.ref})`);
};
exports.assertOriginalFile = file => {
  const expected = baseline.files[file];
  assert.ok(expected && /^[a-f0-9]{64}$/.test(expected.sha256), `missing baseline ${file}`);
  assert.equal(sha(fs.readFileSync(file)), expected.sha256, `original file changed: ${file} (${expected.ref})`);
};
exports.sourceFilesContaining = (directory, needle) => {
  const hits = [];
  const visit = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(entry.name) && fs.readFileSync(file, 'utf8').includes(needle)) hits.push(file.split(path.sep).join('/'));
    }
  };
  visit(directory); return hits.sort();
};
