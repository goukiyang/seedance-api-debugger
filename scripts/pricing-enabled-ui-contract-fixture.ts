import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PricingAdminChanges, PricingAdminRow } from '../src/lib/pricing/admin-contract';
import {
  canEnablePricingAdminRow, consumePricingAdminDraft, defaultPricingAdminView,
  isSimplePricingAdminMoneyDraft, parsePricingAdminWorkspace, patchPricingAdminRow,
  pricingAdminEnabled, pricingAdminPreviewKey, restorePricingAdminMoneyRow,
  stagePricingAdminEnabled, stagePricingAdminMemberExit, submittedPricingAdminDraft,
} from '../src/lib/pricing/admin-client-state';

const sourceReference = 'UI fixture';
const base = { amount: '0.20', currency: 'CNY' as const, unit: 'image' as const,
  source: { type: 'admin_defined' as const, reference: sourceReference, note: '' } };
function row(patch: Partial<PricingAdminRow> = {}): PricingAdminRow {
  return { id: 'image', identity: { kind: 'image', channelId: 'channel', modelId: 'fixture', billingMode: 'fixed', unit: 'image', specifications: {} },
    label: 'Fixture', providerLabel: 'Fixture', isDefault: true, appliesTo: [], enabled: true, availability: 'ready', unavailableReason: null,
    basisKind: 'site_base_cny', mode: 'custom', baseCny: '0.10', source: null, exchangeRate: null, currentPointsPerCny: '10', currentUnitCredits: '1',
    legacyRounding: null, legacyPointsPerUsd: null, relativeMultiplier: '1', differencePercent: '0', hasDifference: false,
    confirmation: 'confirmed', canAdopt: true, adoptionReason: null, updatedAt: null, ...patch };
}

export function runPricingEnabledUiContractFixture() {
  const original = row(), empty: PricingAdminChanges = { rows: [] };
  assert.equal(pricingAdminEnabled(original), true);
  assert.equal(pricingAdminEnabled(row({ mode: 'unset' })), false);
  assert.equal(pricingAdminEnabled(row({ pricingEnabled: false })), false);
  assert.equal(pricingAdminEnabled(row({ mode: 'unset', pricingEnabled: true })), true);
  assert.equal(pricingAdminEnabled(row({ enabled: false })), true, 'Supplier availability is not pricing enablement');

  const legacyFixed = row({ mode: 'legacy_fixed', pricingEnabled: false, baseCny: null });
  const legacyActual = row({ mode: 'legacy_actual', pricingEnabled: false, baseCny: null, currentUnitCredits: null,
    identity: { ...original.identity, billingMode: 'actual' } });
  const free = row({ mode: 'free', pricingEnabled: false, baseCny: null, currentUnitCredits: null });
  for (const entry of [legacyFixed, legacyActual, free]) {
    assert.equal(canEnablePricingAdminRow(entry), true, 'Closing a valid legacy/free rate must not strand it');
    assert.equal(stagePricingAdminEnabled(empty, entry, true).rows[0].pricingEnabled, true);
  }
  const unset = row({ mode: 'unset', baseCny: null, currentUnitCredits: null });
  assert.equal(canEnablePricingAdminRow(unset), false);
  for (const amount of ['', '0', '-1', 'NaN', '1000001', '0.123456789']) {
    assert.equal(canEnablePricingAdminRow(unset, { id: unset.id, base: { ...base, amount } }), false);
  }
  assert.equal(canEnablePricingAdminRow(unset, { id: unset.id, base }), true, 'A valid price can be saved together with enabling');
  assert.equal(canEnablePricingAdminRow(original, { id: original.id, base: { ...base, amount: '' } }), false);
  for (const availability of ['disabled', 'unconfigured'] as const) {
    const unavailable = row({ availability, pricingEnabled: false });
    assert.equal(canEnablePricingAdminRow(unavailable), false);
    assert.equal(canEnablePricingAdminRow(unavailable, { id: unavailable.id, base }), false, 'New base cannot bypass an unavailable supplier');
    assert.deepEqual(stagePricingAdminEnabled(empty, row({ availability }), false).rows,
      [{ id: original.id, pricingEnabled: false }], 'An on rate can still be closed while unavailable');
  }
  assert.equal(canEnablePricingAdminRow(row({ enabled: false, pricingEnabled: false })), false);
  assert.equal(canEnablePricingAdminRow(row({ enabled: false }), { id: original.id, base }), false);
  const needsReview = row({ availability: 'needs_review', pricingEnabled: false });
  assert.equal(canEnablePricingAdminRow(needsReview), false);
  assert.equal(canEnablePricingAdminRow(needsReview, { id: needsReview.id, customPointsPerCny: '10' }), false);
  assert.equal(canEnablePricingAdminRow(needsReview, { id: needsReview.id, base: { ...base, amount: '' } }), false);
  assert.equal(canEnablePricingAdminRow(needsReview, { id: needsReview.id, base }), true, 'Same-draft valid base permits source reconfirmation');
  assert.equal(canEnablePricingAdminRow({ ...needsReview, enabled: false }, { id: needsReview.id, base }), false);

  const off = stagePricingAdminEnabled(empty, original, false);
  assert.deepEqual(off.rows, [{ id: original.id, pricingEnabled: false }]);
  assert.equal(isSimplePricingAdminMoneyDraft(off, sourceReference), true, 'Pure toggle uses normal preview/save');
  const withPrice = patchPricingAdminRow(off, original.id, { base, authoringRateMode: 'follow_global' });
  assert.equal(withPrice.rows[0].pricingEnabled, false);
  assert.equal(isSimplePricingAdminMoneyDraft(withPrice, sourceReference), true);
  assert.equal(isSimplePricingAdminMoneyDraft({ rows: [{ id: original.id, customPointsPerCny: '10', pricingEnabled: false }] }, sourceReference), false);
  const restoredPrice = restorePricingAdminMoneyRow(withPrice, original.id);
  assert.deepEqual(restoredPrice, off, 'Reverting amount keeps only the independent switch draft');
  const restoredToggle = stagePricingAdminEnabled(withPrice, original, true);
  assert.equal(restoredToggle.rows[0].pricingEnabled, undefined);
  assert.deepEqual(restoredToggle.rows[0].base, base, 'Reverting toggle retains money draft');
  assert.deepEqual(stagePricingAdminEnabled(off, original, true), empty);
  const pricedFirst = patchPricingAdminRow(empty, original.id, { base });
  assert.deepEqual(stagePricingAdminEnabled(pricedFirst, original, false).rows[0].base, base);
  const unavailable = row({ enabled: false, availability: 'disabled' });
  stagePricingAdminEnabled(empty, unavailable, false);
  assert.equal(unavailable.enabled, false);
  assert.equal(unavailable.availability, 'disabled');

  const exited = stagePricingAdminMemberExit(withPrice, original.id);
  assert.deepEqual(exited.rows, [{ id: original.id, authoringRateMode: 'custom', pricingEnabled: false }]);
  assert.deepEqual(consumePricingAdminDraft(withPrice, off), {
    rows: [{ id: original.id, base, baseRelation: null, authoringRateMode: 'follow_global' }],
  }, 'A toggle receipt consumes only its submitted field');
  assert.deepEqual(consumePricingAdminDraft({ rows: [{ id: original.id, pricingEnabled: true }] }, off).rows,
    [{ id: original.id, pricingEnabled: true }], 'Late receipts preserve a later toggle');
  assert.deepEqual(submittedPricingAdminDraft(withPrice, { kind: 'save', changes: withPrice }), withPrice);
  assert.equal(submittedPricingAdminDraft(withPrice, { kind: 'unify', basisKind: 'site_base_cny', ruleIds: [original.id] }).rows[0].pricingEnabled,
    undefined, 'Unify must not consume a separate toggle draft');

  const workspace = (changes: unknown) => JSON.stringify({ schema: 1, actorId: 'actor',
    draft: { revision: 'revision', changes }, view: defaultPricingAdminView });
  for (const changes of [off, withPrice, { rows: [{ id: original.id, pricingEnabled: true }] }]) {
    assert.deepEqual(parsePricingAdminWorkspace(workspace(changes), 'actor')?.draft.changes, changes);
  }
  assert.equal(parsePricingAdminWorkspace(workspace(off), 'other'), null);
  assert.equal(parsePricingAdminWorkspace(workspace({ rows: [{ id: original.id, pricingEnabled: 'false' }] }), 'actor'), null);
  const input = { expectedRevision: 'revision', catalogFingerprint: 'catalog', action: { kind: 'save' as const, changes: off } };
  assert.notEqual(pricingAdminPreviewKey(input), pricingAdminPreviewKey({ ...input, action: { kind: 'save', changes: empty } }));

  const client = readFileSync('src/app/admin/pricing/AdminPricingClient.tsx', 'utf8');
  const css = readFileSync('src/app/admin/pricing/pricing.module.css', 'utf8');
  assert.match(client, /role="switch" aria-checked=\{enabled\}/);
  assert.equal(client.split('renderPricingSwitch(row, change)').length - 1, 2, 'Compact and recovery UI both expose the switch');
  assert.match(client, /pending \|\| saving \|\| conflict/);
  assert.match(client, /stagePricingAdminEnabled\(changes, row, !enabled\)/);
  assert.match(client, /!enabled && !canEnablePricingAdminRow\(row, change\)/);
  assert.match(client, /row.unavailableReason \|\| '当前通道不可用'/);
  assert.match(client, /来源待确认/);
  assert.match(client, /restorePricingAdminMoneyRow\(changes, row.id\)/);
  assert.match(client, /!pricingEnabled \? <>\s*<strong>已关闭/);
  assert.match(client, /pricingAdminEnabled\(change.before\) !== pricingAdminEnabled\(change.after\)/);
  assert.match(css, /pricingSwitch\[aria-checked=true\]::before/);
  return { contracts: 'toggle/money merge, revert, legacy, receipt, workspace, preview and UI wiring', network: false, database: false, browser: false };
}

if (require.main === module) console.log(JSON.stringify(runPricingEnabledUiContractFixture()));
