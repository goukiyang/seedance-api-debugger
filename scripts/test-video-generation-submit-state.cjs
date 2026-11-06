const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the actual render-state callback and submit predicate; no browser, DB or provider calls.
const source = fs.readFileSync(path.resolve(__dirname, '../src/components/GenerationComposer.tsx'), 'utf8');
const start = source.indexOf('  const composerStatus = useMemo(() => {');
const a = start + '  const composerStatus = useMemo('.length;
const b = source.indexOf('\n  }, [isSubmitting,', a) + 4;
assert.ok(start >= 0 && b > a, 'Actual composer status callback must be present');
const predicate = source.match(/^  const canValidatePrompt = (.+);$/m)?.[1];
assert.ok(predicate, 'Actual submission predicate must be present');
const code = ts.transpileModule(`globalThis.result = (${source.slice(a, b)})(); globalThis.canValidate = (${predicate});`,
  { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const base = { isSubmitting: false, durationBlocker: null, mentionNotice: null, prompt: 'synthetic valid prompt',
  videoRedesign: true, videoPromptGroups: [], submitBlocker: null, submitBlockerState: null,
  submitDisabledReason: null, submitDisabledReasonExternal: false,
  videoPricing: { quote: { estimatedCost: 239.1 } }, need1080pApproval: false, resolutionApprovalConfirmed: false };
const cases = [
  ['context error must remain visible and blocked', { submitDisabledReason: 'synthetic context denied', submitDisabledReasonExternal: true }, 'synthetic context denied', false],
  ['context pending must remain visible and blocked', { submitDisabledReason: 'synthetic context pending', submitDisabledReasonExternal: true }, 'synthetic context pending', false],
  ['cleared context restores readiness without stale message', {}, null, true],
  ['input blocker stays visible and blocked', { submitBlocker: 'synthetic missing material', submitBlockerState: { tone: 'error' } }, 'synthetic missing material', false],
  ['submission stays blocked during receipt wait', { isSubmitting: true }, 'submit-in-progress', false],
  ['unapproved HD remains blocked', { need1080pApproval: true }, null, false],
  ['legacy path still requires a valid quote', { videoRedesign: false, videoPricing: { quote: null } }, null, false],
];
for (const [name, overrides, expectedMessage, expectedReady] of cases) {
  const scope = { ...base, ...overrides };
  vm.runInNewContext(code, scope);
  if (expectedMessage === 'submit-in-progress') assert.ok(scope.result.message && scope.result.tone === 'progress', name);
  else assert.equal(scope.result.message, expectedMessage, name);
  assert.equal(Boolean(scope.canValidate), expectedReady, name);
  console.log('PASS ' + name);
}
console.log(JSON.stringify({ passed: true, cases: cases.length, actualSource: true, synthetic: true,
  productionWrites: 0, providerCalls: 0, browserRuns: 0 }));
