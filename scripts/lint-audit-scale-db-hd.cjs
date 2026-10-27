const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const deps = createRequire(path.join(process.env.AUD_LINT_MODULES || path.resolve('node_modules'), 'package.json'));
const { Linter } = deps('eslint');
const linter = new Linter();
linter.defineParser('typescript', deps('@typescript-eslint/parser'));
linter.defineRule('typescript/no-unused-vars', deps('@typescript-eslint/eslint-plugin').rules['no-unused-vars']);
const files = ['src/lib/database/client.ts', 'src/lib/database/observations.ts', 'src/lib/database/alerts.ts',
  'src/lib/database/readonly-hd.ts', 'src/lib/database/readonly-mount.ts', 'src/lib/database/process-mode.ts', 'src/lib/database/location.ts',
  'src/lib/media/hd-read-repository.ts', 'src/lib/media/hd-prisma-read.ts', 'src/lib/media/hd-discovery.ts', 'scripts/process-hd-derivatives.ts',
  'src/lib/prisma.ts', 'src/lib/db.ts', 'src/lib/feedback/notification.ts', 'src/lib/media/hd-readonly-db.ts',
  'src/lib/media/hd-owner.ts', 'src/lib/media/hd-scheduler.ts', 'src/lib/media/hd-derivatives.ts', 'scripts/verify-audit-scale-db-hd-server.ts',
  'scripts/verify-audit-strict-readonly-linux.ts', 'scripts/test-hd-stability.ts'];
let errors = 0;
for (const file of files) {
  const messages = linter.verify(fs.readFileSync(file, 'utf8'), { parser: 'typescript',
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' }, env: { node: true, es2022: true },
    rules: { 'no-unreachable': 'error', 'no-dupe-keys': 'error', 'no-dupe-args': 'error', 'valid-typeof': 'error',
      'typescript/no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }] } }, { filename: file });
  for (const message of messages) {
    errors += message.severity === 2 ? 1 : 0;
    console.log(`${file}:${message.line} ${message.severity === 2 ? 'ERROR' : 'WARN'} ${message.ruleId} ${message.message}`);
  }
}
console.log(`focused lint: ${files.length} files, ${errors} errors (not full Next lint/typecheck)`);
process.exitCode = errors ? 1 : 0;
