import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { planStudioDefinitionRebase } from '../src/lib/image-studio/definition-rebase';

const root = realpathSync(process.cwd());
const destination = path.resolve(process.argv[2] || '');
assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
const labels = { prompt: 'Prompt', groups: 'Groups', count: 'Count' };
const original = { prompt: 'saved', groups: ['one'], count: 1 };
const mine = { prompt: 'edited', groups: ['one'], count: 1 };
const before = JSON.stringify([original, mine]);
const noContentChange = planStudioDefinitionRebase(original, mine, { ...original }, labels);
assert.deepEqual(noContentChange.fields, []);
assert.deepEqual(noContentChange.apply(true), mine);
const nonOverlapping = planStudioDefinitionRebase(original, mine, { ...original, groups: ['two'], count: 2 }, labels);
assert.equal(nonOverlapping.fields.some(field => field.conflict), false);
assert.deepEqual(nonOverlapping.apply(true), { prompt: 'edited', groups: ['two'], count: 2 });
const simultaneous = planStudioDefinitionRebase(original, mine, { prompt: 'remote', groups: [], count: 2 }, labels);
assert.deepEqual(simultaneous.fields.filter(field => field.conflict).map(field => field.key), ['prompt']);
assert.deepEqual(simultaneous.apply(true), { prompt: 'edited', groups: [], count: 2 });
assert.deepEqual(simultaneous.apply(false), { prompt: 'remote', groups: [], count: 2 });
const explicitEmpty = planStudioDefinitionRebase(original, { ...mine, prompt: '' }, { ...original, prompt: 'remote' }, labels);
assert.equal(explicitEmpty.apply(true).prompt, '');
assert.equal(explicitEmpty.apply(false).prompt, 'remote');
const sameEdit = planStudioDefinitionRebase(original, mine, { ...mine }, labels);
assert.equal(sameEdit.fields.some(field => field.conflict), false);
const missingBaseline = planStudioDefinitionRebase(null, mine, { ...original, count: 2 }, labels);
assert.equal(missingBaseline.fields.every(field => field.conflict), true);
assert.deepEqual(missingBaseline.apply(true), mine);
assert.deepEqual(missingBaseline.apply(false), { ...original, count: 2 });
assert.equal(JSON.stringify([original, mine]), before);
const sources = ['scripts/studio-definition-rebase-engineering.ts', 'src/lib/image-studio/definition-rebase.ts'];
writeFileSync(destination, JSON.stringify({ schema: 'studio-definition-rebase-engineering.v1', synthetic: true, completed: true,
  checks: ['workspace_only_change_retains_local_draft', 'non_overlapping_latest_changes_merge',
    'conflicting_fields_require_explicit_choice', 'empty_and_removed_values_are_preserved',
    'identical_concurrent_edits_are_not_conflicts', 'missing_baseline_requires_explicit_choice', 'planning_does_not_mutate_inputs'],
  sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
  applicationDatabaseOpened: false, forbiddenCalls: 0, paidRequests: 0, browserRuns: 0,
  scope: 'Pure definition merge contract only; no browser, HTTP or functional acceptance' }), { mode: 0o600, flag: 'wx' });
console.log('STUDIO_DEFINITION_REBASE_ENGINEERING_RECEIPT=' + destination);
