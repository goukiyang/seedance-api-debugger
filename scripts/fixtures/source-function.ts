import assert from 'node:assert/strict';
import ts from 'typescript';

// Inspect the actual function, whether exported directly or passed to apiRoute.
export function sourceFunction(text: string, name: string, file = 'fixture.ts') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declarations: Array<ts.FunctionDeclaration | ts.VariableDeclaration> = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) declarations.push(statement);
    if (ts.isVariableStatement(statement)) declarations.push(...Array.from(statement.declarationList.declarations).filter(item => item.name.getText(source) === name));
  }
  assert.equal(declarations.length, 1, `Expected one ${name} declaration in ${file}`);
  const declaration = declarations[0];
  if (ts.isFunctionDeclaration(declaration)) return declaration.getText(source);
  let expression = declaration.initializer;
  if (expression && ts.isCallExpression(expression)) expression = expression.arguments[1];
  if (expression && ts.isIdentifier(expression)) {
    assert.notEqual(expression.text, name, 'Self-referential function binding');
    return sourceFunction(text, expression.text, file);
  }
  assert(expression && (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)), `Expected an actual ${name} function in ${file}`);
  return expression.getText(source);
}
