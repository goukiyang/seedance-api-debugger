'use strict';
const fs = require('node:fs'), ts = require('typescript');
const files = ['src/lib/assets/picker-service.ts', 'src/lib/assets/picker-origin.ts', 'src/lib/assets/picker-stream.ts'];
function checkPickerGrowth(read = file => fs.readFileSync(file, 'utf8')) {
  const failures = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source).endsWith('.findMany')) {
        const args = node.arguments[0], take = args && ts.isObjectLiteralExpression(args) && args.properties.find(property => property.name?.getText(source) === 'take');
        if (!take) failures.push(`${file}: unbounded findMany`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (/\.set\(item\.identity|Array\.from\(dedup|removedLibraryResources\(|generationOrigins\(/.test(read(file))) failures.push(`${file}: unbounded whole-catalogue accumulation`);
  }
  const route = read('src/app/api/assets/picker/route.ts');
  if (!route.includes('apiRoute({ access: \'user\'') || !route.includes('apiErrorResponse') || !route.includes('readPicker(user,')) failures.push('picker route must preserve auth/error wrapper and bounded service');
  const stream = read('src/lib/assets/picker-stream.ts');
  if (!stream.includes('selected.length > options.limit + 1') || !stream.includes('readPageCursor(') || !stream.includes('writePageCursor(')) failures.push('bounded retained window and shared signed cursor required');
  const client = read('src/components/ResourceLibraryPicker.tsx');
  if (!client.includes('pickerWithDirectories(params, user?.id')) failures.push('picker consumer must enumerate full finite paged directories before preference validation');
  if (!client.includes("params.set('template_context', templateContextId)")) failures.push('picker consumer must declare its current genuine template alias context');
  return failures;
}
module.exports = { checkPickerGrowth, files };
if (require.main === module) { const failures = checkPickerGrowth(); console.log(JSON.stringify({ scope: 'picker package only', failures })); if (failures.length) process.exitCode = 1; }
