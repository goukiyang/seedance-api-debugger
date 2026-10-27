const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const consumers = new Set([
  'src/lib/video/task-finalizer.ts', 'src/server/video-tasks/standard-create.ts', 'src/server/video-tasks/ip-create.ts',
  'src/app/api/tasks/enhance-video/create/route.ts', 'src/lib/tasks/seedance-draft-upgrade.ts',
  'src/lib/canvas-roles/execution.ts', 'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/batches.ts',
  'src/lib/image-studio/billing.ts', 'src/lib/tools/toolflow-runtime.ts', 'src/app/api/ip/tasks/[id]/cancel/route.ts',
]);
const failures = [];
// Existing non-task grants, explicit administrator adjustments and account
// lifecycle writes retain their owners; this batch does not alter permissions.
const nonTaskWriters = new Set([
  'src/lib/auth/feishu.ts', 'src/lib/auth/registration/create-user.ts',
  'src/lib/credits/periodic.ts', 'src/lib/credits/requests.ts',
  'src/app/api/admin/credits/adjust/route.ts', 'src/app/api/admin/credits/bulk-grant/route.ts',
  'src/app/api/admin/users/merge/route.ts', 'src/app/api/admin/users/route.ts',
  'src/app/api/projects/[id]/budget/route.ts',
]);
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.posix.join(dir, item.name);
    if (item.isDirectory()) { walk(file); continue; }
    if (!/\.tsx?$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    if (consumers.has(file) || file.startsWith('src/lib/billing/') || ['src/lib/video/task-state.ts','src/lib/video/submission.ts','src/lib/video/reconciler.ts'].includes(file)) {
      for (const error of tree.parseDiagnostics) failures.push(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
    }
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const expr = node.expression.getText(tree);
        if (!file.startsWith('src/lib/billing/') && !nonTaskWriters.has(file) && /\.(creditLedger|creditAccount|creditBucket|projectBudgetLedger|projectBudgetAccount)\.(create|update|updateMany|upsert|delete|deleteMany)$/.test(expr)) failures.push(`${file}: direct task money write ${expr}`);
        if (file !== 'src/lib/video/task-state.ts' && /\.videoTask\.(create|update|updateMany|upsert)$/.test(expr)) {
          const args = node.arguments[0];
          if (args && ts.isObjectLiteralExpression(args)) {
            const data = args.properties.find(prop => prop.name?.getText(tree) === 'data');
            if (data && ts.isPropertyAssignment(data) && ts.isObjectLiteralExpression(data.initializer)
              && data.initializer.properties.some(prop => prop.name?.getText(tree) === 'local_status')) failures.push(`${file}: direct video status write`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
walk('src');
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log('PASS AUD3 syntax, task money writers and video state writers');
