'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./fixtures/fb2322-video-tx.cjs');
const root = path.resolve(process.env.FB2322_SOURCE_ROOT || path.join(__dirname, '..'));
const errors = fixture.sourceViolations(root);
for (const file of fixture.callers) {
  const selected = fixture.prefix(root, file);
  assert.ok(selected.text.includes('resolveVideoPricingContext'));
  assert.ok(!selected.text.includes('await tx.videoTask.create('), 'prefix ends before real creation');
  new Function(`return ${selected.javascript}`);
}
const secretError = new Error('private snapshot token cookie secret');
assert.equal(fixture.safeError(secretError).message, '[redacted diagnostic message]');
let getterCalled = false;
Object.defineProperty(secretError, 'cause', { get() { getterCalled = true; return 'secret'; } });
fixture.safeError(secretError); assert.equal(getterCalled, false);
if (!errors.length) {
  const file = fixture.callers[0], source = fs.readFileSync(path.join(root, file), 'utf8');
  const mutant = fixture.withoutTransactionDbArgument(file, source);
  assert.ok(fixture.sourceViolations(root, { [file]: mutant }).some(value => value.includes(file)), 'removing tx propagation is detected');
}
console.log(JSON.stringify({ fixture: 'fb2322-source', sourceRoot: root, pureChecks: 'completed',
  actualPrefixBoundaries: 2, dbPropagation: errors.length ? 'RED' : 'GREEN', violations: errors }));
if (errors.length) process.exitCode = 1;
