import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PricingAdminAction, PricingAdminChanges, PricingAdminRow, PricingAdminSaveInput } from '../src/lib/pricing/admin-contract';
import {
  consumePricingAdminDraft, defaultPricingAdminView, filterPricingAdminRows,
  parsePricingAdminPending, parsePricingAdminWorkspace, patchPricingAdminRow,
  pricingAdminPreviewKey, pricingAdminStorageKey, submittedPricingAdminDraft, validPricingAdminRate,
  type PricingAdminPending,
} from '../src/lib/pricing/admin-client-state';

const actor = 'fixture-admin-a';
function row(id: string, patch: Partial<PricingAdminRow> = {}): PricingAdminRow {
  return {
    id, identity: { kind: 'image', channelId: 'channel-a', modelId: `fixture-${id}`, billingMode: 'fixed', unit: 'image', specifications: { resolution: '2K' } },
    label: `Fixture ${id}`, providerLabel: 'Fixture provider', isDefault: false, appliesTo: ['template'], enabled: true, availability: 'ready',
    unavailableReason: null, basisKind: 'site_base_cny', mode: 'legacy_fixed', baseCny: null, source: null, exchangeRate: null,
    currentPointsPerCny: null, currentUnitCredits: '5', legacyRounding: 'fixed_unit', legacyPointsPerUsd: null,
    relativeMultiplier: null, differencePercent: null, hasDifference: false, confirmation: 'unconfirmed', canAdopt: false,
    adoptionReason: 'Fixture needs source', updatedAt: null, ...patch,
  };
}

// These are isolated in-memory examples, not page defaults or production writes.
export function runPricingAdminUiContractFixture() {
  const rows = Array.from({ length: 61 }, (_, index) => row(`r${index}`, { isDefault: index % 2 === 0, hasDifference: index === 60 }));
  assert.deepEqual(filterPricingAdminRows(rows, { difference: 'different' }).map(item => item.id), ['r60'], 'Filtering precedes paging');
  assert.equal(filterPricingAdminRows(rows, { defaultsOnly: true }).length, 31);
  assert.equal(filterPricingAdminRows(rows, { search: '2K' }).length, 61);
  assert.equal(filterPricingAdminRows(rows, { search: 'r60' }).length, 1);
  assert.equal(filterPricingAdminRows(rows, { channelId: 'other' }).length, 0);
  assert.equal(filterPricingAdminRows(rows, { kind: 'video' }).length, 0);
  assert.equal(filterPricingAdminRows(rows, { difference: 'unconfirmed' }).length, 61);
  assert.equal(rows[0].baseCny, null, 'No fictional base on first read');
  assert.equal(defaultPricingAdminView.referenceId, '', 'No automatic reference');

  for (const value of ['0.1', '1', '15.5', '10000.0']) assert.equal(validPricingAdminRate(value), true, value);
  for (const value of ['', '0', '-1', '+1', '1e1', '0.01', '1.01', '10000.1', 'Infinity', 'NaN', '1,000', ' 1 ', '01']) assert.equal(validPricingAdminRate(value), false, value);

  const source = { amount: '0.15', currency: 'CNY' as const, unit: 'image' as const, source: { type: 'admin_defined' as const, reference: 'Fixture source', note: '' } };
  const submitted: PricingAdminChanges = { standards: { site_base_cny: '10.0' }, rows: [{ id: 'r1', mode: 'custom', customPointsPerCny: '15.0', base: source }] };
  const later: PricingAdminChanges = { standards: { site_base_cny: '12.0' }, rows: [{ id: 'r1', mode: 'custom', customPointsPerCny: '16.0', base: source }, { id: 'r2', mode: 'free' }] };
  const consumed = consumePricingAdminDraft(later, submitted);
  assert.equal(consumed.standards?.site_base_cny, '12.0', 'Later standard survives receipt');
  assert.deepEqual(consumed.rows.find(item => item.id === 'r1'), { id: 'r1', mode: 'custom', customPointsPerCny: '16.0' }, 'Only matching source consumed; changed custom mode retained');
  assert.equal(consumed.rows.find(item => item.id === 'r2')?.mode, 'free', 'Unrelated row survives');
  assert.deepEqual(consumePricingAdminDraft(submitted, submitted), { rows: [] });
  const follow = patchPricingAdminRow(submitted, 'r1', { mode: 'follow' });
  assert.equal(follow.rows[0].customPointsPerCny, undefined, 'Follow must not serialize stale custom rate');
  assert.equal(follow.rows[0].base?.amount, '0.15', 'Changing mode preserves source draft');
  const unify: PricingAdminAction = { kind: 'unify', basisKind: 'site_base_cny', ruleIds: ['r1'] };
  const unifyCapture = submittedPricingAdminDraft(submitted, unify);
  assert.equal(unifyCapture.rows[0].base, undefined, 'Unify does not consume unrelated source drafts');
  assert.equal(consumePricingAdminDraft(later, unifyCapture).rows.find(item => item.id === 'r1')?.base?.amount, '0.15');
  assert.deepEqual(submittedPricingAdminDraft(later, { kind: 'restore', revisionId: 'historic', ruleIds: ['r1'] }), { rows: [] }, 'Restore leaves independent drafts untouched');

  const workspace = JSON.stringify({ schema: 1, actorId: actor, draft: { revision: 'rev-a', changes: submitted }, view: {
    ...defaultPricingAdminView, filter: { kind: 'image', search: 'Fixture' }, page: 2, expanded: ['r1'], anchorId: 'r1', anchorOffset: 24,
    dangerConfirmation: true, apiKey: 'not-a-real-key',
  } });
  const restored = parsePricingAdminWorkspace(workspace, actor);
  assert.equal(restored?.draft.revision, 'rev-a', 'Draft revision preserved for explicit conflict review');
  assert.equal(restored?.view.page, 2);
  assert.equal(restored?.view.anchorId, 'r1');
  assert.equal('apiKey' in (restored?.view || {}), false, 'Only allowlisted state restored');
  assert.equal('dangerConfirmation' in (restored?.view || {}), false);
  assert.equal(parsePricingAdminWorkspace(workspace, 'other-admin'), null, 'Actor isolation');
  assert.equal(parsePricingAdminWorkspace('{broken', actor), null);
  assert.equal(parsePricingAdminWorkspace(JSON.stringify({ schema: 2, actorId: actor }), actor), null);
  assert.notEqual(pricingAdminStorageKey(actor, 'workspace'), pricingAdminStorageKey(actor, 'operation'), 'Unknown payload is independently durable');
  assert.notEqual(pricingAdminStorageKey(actor, 'operation'), pricingAdminStorageKey('other-admin', 'operation'));
  const input = { expectedRevision: 'rev-a', catalogFingerprint: 'catalog-a', action: { kind: 'save' as const, changes: submitted } };
  const payload: PricingAdminSaveInput = { ...input, operationId: 'fixture-operation-a', previewToken: 'fixture-token-never-sent' };
  const pending: PricingAdminPending = { actorId: actor, submittedAt: '2026-10-18T00:00:00Z', inputFingerprint: 'fixture-fingerprint', payload, submittedDraft: submittedPricingAdminDraft(submitted, input.action) };
  const durable = JSON.stringify(pending);
  patchPricingAdminRow(later, 'r1', { mode: 'custom', customPointsPerCny: '17.0' });
  assert.equal(JSON.stringify(pending), durable, 'Later edits cannot mutate unknown operation');
  assert.deepEqual(parsePricingAdminPending(durable, actor), pending);
  assert.equal(parsePricingAdminPending(durable, 'other-admin'), null);
  assert.notEqual(pricingAdminPreviewKey(input), pricingAdminPreviewKey({ ...input, catalogFingerprint: 'catalog-b' }));
  assert.notEqual(pricingAdminPreviewKey(input), pricingAdminPreviewKey({ ...input, expectedRevision: 'rev-b' }));
  assert.notEqual(pricingAdminPreviewKey(input), pricingAdminPreviewKey({ ...input, action: unify }));

  const root = resolve(__dirname, '..');
  const client = readFileSync(resolve(root, 'src/app/admin/pricing/AdminPricingClient.tsx'), 'utf8');
  const editor = readFileSync(resolve(root, 'src/app/admin/integrations/ImageApiGroupEditor.tsx'), 'utf8');
  const page = readFileSync(resolve(root, 'src/app/admin/pricing/page.tsx'), 'utf8');
  assert.match(page, /user\.role !== 'admin'/);
  assert.doesNotMatch(page, /redirect\('\/admin\/users'\)/);
  assert.match(client, /x-app-session-user/);
  assert.match(client, /operations\/\$\{encodeURIComponent\(operation\.payload\.operationId\)\}/);
  assert.match(client, /Date\.parse\(preview\.expiresAt\)/);
  assert.match(client, /选择全部符合条件/);
  assert.match(client, /保存结果待确认/);
  assert.doesNotMatch(editor, /modelChange\(model, \{ (billingMode|fixedPoints):/);
  assert.match(editor, /\/admin\/pricing\?/);
  return { assertions: 'state/filter/scope/receipt/storage/entry boundaries', runtime: 'not invoked by worker; lead owns execution' };
}

if (require.main === module) console.log(JSON.stringify(runPricingAdminUiContractFixture()));
