import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';

const decoderOwners = new Set(['src/lib/media/sharp.ts', 'src/lib/media/image-decoder-policy.cjs', 'scripts/test-image-decoder-policy.cjs']);
export function inspectSource(file, source) {
  const findings = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node) {
    const imported = ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text : ts.isCallExpression(node) && node.arguments.length === 1
        && ts.isStringLiteral(node.arguments[0]) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0].text : null;
    if (imported === 'sharp' && !decoderOwners.has(file)) {
      findings.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        rule: 'decoder-single-entry', message: 'Use the shared image decoder with process-wide format restrictions.' });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return findings;
}
function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(file);
    return entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(file) ? [file] : [];
  });
}
export function checkStatic(root) {
  const files = ['src', 'scripts'].flatMap(directory => filesIn(path.join(root, directory)));
  return files.flatMap(file => inspectSource(path.relative(root, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkStatic(process.cwd());
  console.log(JSON.stringify({ schema: 'static-contracts.v1', rules: ['decoder-single-entry'], findings }));
  if (findings.length) process.exitCode = 1;
  for (const script of ['scripts/check-audit-billing.cjs', 'scripts/check-audit-net.cjs', 'scripts/check-api-errors.cjs', 'scripts/check-audit-decode-upload.cjs', 'scripts/check-route-policies.cjs', 'scripts/check-task-dto.cjs', 'scripts/check-audit-scale-db-hd.mjs', 'scripts/check-audit-strict-readonly.cjs', 'scripts/check-album-pagination.cjs', 'scripts/check-task-seedance-pagination.cjs', 'scripts/check-seedance-selector-pagination.cjs', 'scripts/check-picker-growth.cjs', 'scripts/check-governance-pagination.cjs']) {
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
    if (result.error || result.status !== 0) process.exitCode = 1;
  }
}
