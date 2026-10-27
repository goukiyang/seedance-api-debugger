const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const levels = new Set(['public', 'user', 'internal', 'admin', 'service']);
const rates = new Set(['auth', 'login', 'registration-code', 'feedback']);

function inspectRoute(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const wrappers = new Set(), bindings = new Map(), exports = new Map();
  for (const node of tree.statements) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@/lib/http/route') {
      for (const item of node.importClause?.namedBindings?.elements || []) {
        if ((item.propertyName || item.name).text === 'route') wrappers.add(item.name.text);
      }
    }
    const exported = node.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      bindings.set(declaration.name.text, declaration.initializer);
      if (exported && methods.has(declaration.name.text)) exports.set(declaration.name.text, declaration.initializer);
    }
    if (exported && ts.isFunctionDeclaration(node) && methods.has(node.name?.text)) exports.set(node.name.text, node);
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const item of node.exportClause.elements) if (methods.has(item.name.text)) {
        exports.set(item.name.text, node.moduleSpecifier ? undefined : item.propertyName || item.name);
      }
    }
  }
  function policy(node, seen = new Set()) {
    if (!node) return null;
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return null;
      seen.add(node.text); return policy(bindings.get(node.text), seen);
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !wrappers.has(node.expression.text)
      || !node.arguments[0] || !ts.isObjectLiteralExpression(node.arguments[0])) return null;
    if (node.arguments[0].properties.some(ts.isSpreadAssignment)) return null;
    const entries = new Map(node.arguments[0].properties.filter(ts.isPropertyAssignment).map(item => [item.name.getText(tree), item.initializer]));
    const access = entries.get('access'), rate = entries.get('rateLimit');
    if (!access || !ts.isStringLiteral(access) || !levels.has(access.text) || !rate
      || !(rate.kind === ts.SyntaxKind.FalseKeyword || ts.isStringLiteral(rate) && rates.has(rate.text))) return null;
    if (access.text === 'service' && !entries.has('authenticate')) return null;
    return { access: access.text, rateLimit: rate.kind === ts.SyntaxKind.FalseKeyword ? false : rate.text };
  }
  const findings = [], declarations = [];
  for (const [method, node] of exports) {
    const value = policy(node);
    if (!value) findings.push(`${file}:${method}: missing explicit route access/rate policy`);
    else declarations.push({ file, method, ...value });
  }
  if (!exports.size) findings.push(`${file}: no inspectable HTTP handler`);
  return { findings, declarations };
}
function inventory(root) {
  const base = path.join(root, 'src/app');
  const files = fs.readdirSync(base, { recursive: true }).filter(file => file === 'route.ts' || file.endsWith('/route.ts')).sort();
  const results = files.map(file => inspectRoute(`src/app/${file}`, fs.readFileSync(path.join(base, file), 'utf8')));
  return { findings: results.flatMap(value => value.findings), declarations: results.flatMap(value => value.declarations) };
}
function main() {
  const result = inventory(process.cwd());
  const anonymous = result.declarations.filter(value => ['public', 'service'].includes(value.access));
  const file = 'src/lib/http/public-routes.json';
  if (process.argv.includes('--write') && !result.findings.length) fs.writeFileSync(file, JSON.stringify(anonymous, null, 2) + '\n');
  let stored;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { stored = null; }
  if (JSON.stringify(stored) !== JSON.stringify(anonymous)) result.findings.push('public-route manifest does not match current explicit declarations');
  result.findings.forEach(item => console.error(item));
  console.log(JSON.stringify({ schema: 'route-policy-inventory.v1', declared: result.declarations.length, anonymous: anonymous.length, failures: result.findings.length }));
  process.exitCode = result.findings.length ? 1 : 0;
}
module.exports = { inspectRoute, inventory };
if (require.main === module) main();
