'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');

const callers = ['src/app/api/tasks/create/route.ts', 'src/lib/tasks/seedance-draft-upgrade.ts'];
const pricingFile = 'src/lib/pricing/video-context.ts';
const sha = value => createHash('sha256').update(value).digest('hex');
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
function tree(file, source) { return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true); }
function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function namedCalls(node, name, source) {
  const found = [];
  walk(node, child => { if (ts.isCallExpression(child) && child.expression.getText(source) === name) found.push(child); });
  return found;
}
function creationTransaction(file, source) {
  const ast = tree(file, source), found = [];
  walk(ast, node => {
    if (!ts.isCallExpression(node) || node.expression.getText(ast) !== 'prisma.$transaction') return;
    const callback = node.arguments[0];
    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)
      && namedCalls(callback.body, 'resolveVideoPricingContext', ast).length) found.push(callback);
  });
  assert.equal(found.length, 1, `${file}: exactly one creation transaction with pricing recheck required`);
  return { ast, callback: found[0] };
}
function sourceViolations(root, overrides = {}) {
  const problems = [], pricing = overrides[pricingFile] ?? read(root, pricingFile), ast = tree(pricingFile, pricing);
  const exported = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveVideoPricingContext');
  const db = exported?.parameters[3];
  if (!db || db.name.getText(ast) !== 'db' || db.initializer?.getText(ast) !== 'prisma') problems.push('pricing: fourth db parameter must default to existing global prisma');
  if (!exported || !namedCalls(exported, 'resolveContext', ast).some(call => call.arguments[3]?.getText(ast) === 'db')) problems.push('pricing: public resolver must forward db to actual resolveContext');
  for (const file of callers) {
    const source = overrides[file] ?? read(root, file), { ast: parsed, callback } = creationTransaction(file, source);
    for (const call of namedCalls(callback.body, 'resolveVideoPricingContext', parsed)) {
      if (call.arguments[3]?.getText(parsed) !== callback.parameters[0]?.name.getText(parsed)) problems.push(`${file}: transaction pricing recheck does not receive its actual tx`);
    }
  }
  return problems;
}
function withoutTransactionDbArgument(file, source) {
  const { ast, callback } = creationTransaction(file, source);
  const call = namedCalls(callback.body, 'resolveVideoPricingContext', ast)[0];
  assert.equal(call.arguments.length, 4, 'mutation requires an actual fixed four-argument caller');
  return source.slice(0, call.arguments[2].end) + source.slice(call.arguments[3].end);
}
function prefix(root, file) {
  assert.ok(callers.includes(file), 'Only the two assigned b9 callers can be evaluated');
  const source = read(root, file), { ast, callback } = creationTransaction(file, source), statements = [];
  let stopped = false;
  for (const statement of callback.body.statements) {
    let createsTask = false;
    walk(statement, node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'tx.videoTask.create') createsTask = true;
    });
    if (createsTask) { stopped = true; break; }
    statements.push(statement.getText(ast));
  }
  assert.ok(stopped, `${file}: real task write boundary missing; refuse executing a different prefix`);
  const text = statements.join('\n');
  assert.ok(text.includes('resolveVideoPricingContext') && text.includes('verifyVideoPricingCredential'));
  assert.ok(text.includes('assertProjectActiveInTransaction'));
  const wrapped = `(async (tx) => {\n${text}\nreturn 'checked-before-task-write';\n})`;
  const javascript = ts.transpileModule(wrapped, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  return { sourceSha256: sha(source), prefixSha256: sha(text), text, javascript };
}
async function runPrefix(root, file, bindings, tx) {
  const selected = prefix(root, file);
  return new Function(...Object.keys(bindings), `return ${selected.javascript}`)(...Object.values(bindings))(tx);
}
function safeError(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 2) return { className: 'NonErrorOrTruncated' };
  const property = key => {
    for (let at = error, count = 0; at && count < 4; at = Object.getPrototypeOf(at), count++) {
      const value = Object.getOwnPropertyDescriptor(at, key);
      if (value) return Object.hasOwn(value, 'value') ? value.value : undefined;
    }
  };
  const constructor = property('constructor'), code = property('code'), status = property('status'), message = property('message'), cause = property('cause');
  const className = typeof constructor === 'function' ? constructor.name : 'OtherError';
  return {
    className: /^[A-Za-z][A-Za-z0-9]{0,70}$/.test(className) ? className : 'OtherError',
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : null,
    code: typeof code === 'string' && /^(P\d{4}|pricing_[a-z_]+|PRIVATE_PROMPT_[A-Z_]+|ERR_ASSERTION)$/.test(code) ? code : null,
    message: typeof message === 'string' && /^fb2322_[a-z_]+$/.test(message) ? message : '[redacted diagnostic message]',
    messageLength: typeof message === 'string' ? Math.min(message.length, 16384) : 0,
    ...(cause && cause !== error ? { cause: safeError(cause, depth + 1) } : {}),
  };
}
exports.callers = callers;
exports.pricingFile = pricingFile;
exports.sourceViolations = sourceViolations;
exports.withoutTransactionDbArgument = withoutTransactionDbArgument;
exports.prefix = prefix;
exports.runPrefix = runPrefix;
exports.safeError = safeError;
exports.sha = sha;
