const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function inspect(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['NextResponse', 'Response'].includes(node.expression.expression.getText(tree)) && node.expression.name.text === 'json') {
      const options = node.arguments[1];
      const status = options && ts.isObjectLiteralExpression(options) && options.properties.find(property =>
        ts.isPropertyAssignment(property) && property.name.getText(tree) === 'status');
      if (status && ts.isNumericLiteral(status.initializer) && Number(status.initializer.text) >= 500 && node.arguments[0]) {
        function inspectPayload(value) {
          if (ts.isPropertyAccessExpression(value) && value.name.text === 'message'
            && /^(error|err|e)$/.test(value.expression.getText(tree))) {
            const safeClasses = new Set(['ContextVersionError', 'H3ConfigurationError']);
            const isKnown = condition => ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
              && condition.left.getText(tree) === value.expression.getText(tree) && safeClasses.has(condition.right.getText(tree));
            let known = false;
            for (let parent = value.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent) {
              if (ts.isConditionalExpression(parent) && isKnown(parent.condition) && parent.whenTrue.pos <= value.pos && value.end <= parent.whenTrue.end
                || ts.isIfStatement(parent) && isKnown(parent.expression) && parent.thenStatement.pos <= value.pos && value.end <= parent.thenStatement.end) known = true;
            }
            if (!known) findings.push(`${file}:${tree.getLineAndCharacterOfPosition(value.pos).line + 1}: raw exception in server-error response`);
          }
          ts.forEachChild(value, inspectPayload);
        }
        inspectPayload(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}
module.exports = { inspect };
if (require.main === module) {
  const files = fs.readdirSync('src/app/api', { recursive: true }).filter(file => file.endsWith('/route.ts'));
  const findings = files.flatMap(file => {
    const full = path.join('src/app/api', file);
    return inspect(full, fs.readFileSync(full, 'utf8'));
  });
  for (const finding of findings) console.error(finding);
  console.log(`${findings.length ? 'FAIL' : 'PASS'} API server-error response contracts`);
  process.exitCode = findings.length ? 1 : 0;
}
