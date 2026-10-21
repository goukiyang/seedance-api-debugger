import assert from 'node:assert/strict';
import type { PricingAdminChanges, PricingAdminPreview, PricingAdminRow, PricingAdminSimulation } from '../src/lib/pricing/admin-contract';
import type { PricingEnhanceGroup } from '../src/lib/pricing/pricing-authoring-contract';
import { consumePricingAdminDraft, defaultPricingAdminView, filterPricingAdminRows, hasPricingAdminChanges, parsePricingAdminWorkspace,
  patchPricingAdminRow, pricingAdminEnhanceGroup, pricingAdminPreviewForSource, pricingAdminPreviewKey, pricingAdminScenarioDifference, pricingAdminStorageKey, stagePricingAdminMemberExit, stagePricingAdminUnify, validPricingEnhanceGroup } from '../src/lib/pricing/admin-client-state';
import { stageGptImageReference, stageVideoPricingReferences, videoPricingReferenceStatus } from '../src/lib/pricing/presets';
import { allPricingFilters, pricingActiveFilters, pricingDisplayName, pricingDisplayRounding, pricingDisplayScope, projectPricingDisplay } from '../src/lib/pricing/admin-display';
import { multiplyDecimal } from '../src/lib/pricing/math';

function row(id: string, patch: Partial<PricingAdminRow> = {}): PricingAdminRow {
  return { id, identity: { kind: 'image', channelId: 'fixture-channel', modelId: 'fixture-image', billingMode: 'fixed', unit: 'image', specifications: {} },
    label: id, providerLabel: 'Fixture', isDefault: true, appliesTo: [], enabled: true, availability: 'ready', unavailableReason: null,
    basisKind: 'site_base_cny', mode: 'custom', baseCny: '0.10', source: null, exchangeRate: null, currentPointsPerCny: '6', currentUnitCredits: '0.6',
    legacyRounding: null, legacyPointsPerUsd: null, relativeMultiplier: '1', differencePercent: '0', hasDifference: false,
    confirmation: 'confirmed', canAdopt: true, adoptionReason: null, updatedAt: null, authoringRateMode: 'custom', ...patch };
}

// In-memory contracts only. The lead includes execution in the complete candidate gate.
export function runPricingAuthoringUiContractFixture() {
  const empty: PricingAdminChanges = { rows: [] };
  assert.equal(hasPricingAdminChanges(empty), false, 'Opening does not create a suggested price draft');
  assert.equal(hasPricingAdminChanges({ rows: [], authoring: { globalPointsPerCny: '10.0' } }), true, 'Zero-member standard is a real setting change');
  const relation = { parentId: 'parent', factor: '1.5' as const };
  const draft: PricingAdminChanges = { authoring: { globalPointsPerCny: '12.0' }, rows: [
    { id: 'a', authoringRateMode: 'custom', mode: 'custom', customPointsPerCny: '6.0', baseRelation: relation },
    { id: 'b', mode: 'custom', customPointsPerCny: '8.0' },
  ] };
  const unified = stagePricingAdminUnify(draft, [row('a'), row('free', { mode: 'free' }), row('disabled', { enabled: false }), row('unknown', { canAdopt: false, baseCny: null })]);
  assert.equal(unified.skipped.length, 3);
  const a = unified.changes.rows.find(item => item.id === 'a')!;
  assert.equal(a.authoringRateMode, 'follow_global');
  assert.equal(a.mode, undefined);
  assert.equal(a.customPointsPerCny, undefined);
  assert.deepEqual(a.baseRelation, relation, 'Point-rate follow does not disconnect base relation');
  assert.deepEqual(unified.changes.rows.find(item => item.id === 'b'), draft.rows[1], 'Unselected draft survives');
  const custom = patchPricingAdminRow(unified.changes, 'a', { customPointsPerCny: '12.0' });
  assert.equal(custom.rows.find(item => item.id === 'a')?.authoringRateMode, 'custom', 'Equal numeric rate remains independently authored');
  assert.deepEqual(custom.rows.find(item => item.id === 'a')?.baseRelation, relation);
  const manualBase = { amount: '0.20', currency: 'CNY' as const, unit: 'second' as const, source: { type: 'admin_defined' as const, reference: 'Fixture manual price', note: '' } };
  const editedBase = patchPricingAdminRow(custom, 'a', { base: manualBase });
  assert.equal(editedBase.rows.find(item => item.id === 'a')?.baseRelation, null, 'Editing base disconnects only base follow');
  const restoredRelation = patchPricingAdminRow(editedBase, 'a', { baseRelation: relation });
  assert.equal(restoredRelation.rows.find(item => item.id === 'a')?.base, undefined, 'Restoring parent follow clears the unsubmitted manual base');
  assert.equal(restoredRelation.rows.find(item => item.id === 'a')?.customPointsPerCny, '12.0', 'Restoring base follow preserves custom point-rate draft');
  assert.deepEqual(restoredRelation.rows.find(item => item.id === 'b'), custom.rows.find(item => item.id === 'b'), 'Other row drafts remain unchanged');
  const rateAfterRestore = patchPricingAdminRow(restoredRelation, 'a', { customPointsPerCny: '13.0' });
  assert.deepEqual(rateAfterRestore.rows.find(item => item.id === 'a')?.baseRelation, relation, 'Subsequent rate edit keeps base follow');
  assert.equal(rateAfterRestore.rows.find(item => item.id === 'a')?.base, undefined);
  assert.equal(pricingAdminScenarioDifference({ deltaCredits: '0.5', differencePercent: '50' }), '差额 +0.5 点（+50%）');
  assert.equal(pricingAdminScenarioDifference({ deltaCredits: '-0.5', differencePercent: '-25' }), '差额 -0.5 点（-25%）');
  assert.equal(pricingAdminScenarioDifference({ deltaCredits: '1', differencePercent: null }), '差额 +1 点', 'Zero-current-price case does not invent a percentage');
  assert.equal(pricingAdminScenarioDifference({ deltaCredits: '0', differencePercent: '0' }), '点价不变');
  assert.equal(pricingAdminScenarioDifference({ deltaCredits: null, differencePercent: null }), null);
  const exitDraft: PricingAdminChanges = { authoring: { globalPointsPerCny: '12.0' }, rows: [
    { id: 'unavailable-member', authoringRateMode: 'custom', mode: 'custom', customPointsPerCny: '9.0', base: manualBase, specifications: { resolution: '2K' }, baseRelation: relation },
    draft.rows[1],
  ] };
  const exit = stagePricingAdminMemberExit(exitDraft, 'unavailable-member');
  assert.deepEqual(exit.rows.find(item => item.id === 'unavailable-member'), { id: 'unavailable-member', authoringRateMode: 'custom' }, 'Unavailable exit is exactly metadata-only even when a previous price draft exists');
  assert.deepEqual(exit.rows.find(item => item.id === 'b'), draft.rows[1], 'Other row draft survives metadata-only exit');
  assert.deepEqual(exit.authoring, exitDraft.authoring, 'Global draft survives member exit');
  assert.equal(exitDraft.rows[0].base, manualBase, 'Exit staging does not mutate the prior draft');
  const normalEdit = patchPricingAdminRow(exit, 'unavailable-member', { customPointsPerCny: '8.0' }).rows.find(item => item.id === 'unavailable-member')!;
  assert.equal(normalEdit.mode, 'custom');
  assert.equal(normalEdit.customPointsPerCny, '8.0', 'Ordinary rate editing remains a price-changing payload, not a metadata-only bypass');
  const scopedScenario: PricingAdminSimulation = {
    sourceRowId: 'source-wide', rowId: 'materialized-2k', specifications: { resolution: '2K', quality: 'high' }, quantity: '1', unit: 'image',
    currentCredits: '0.6', adjustedCredits: '1', authorizedMaximumCredits: null, isExample: false, roundedToZero: false, exactCredits: '1', reason: null,
    deltaCredits: '0.4', differencePercent: '66.66666667', rounding: 'half_up_tenth',
  };
  const scopedChange: PricingAdminPreview['changes'][number] = { id: scopedScenario.rowId, sourceRowId: scopedScenario.sourceRowId,
    specifications: scopedScenario.specifications, label: 'Fixture scoped price', before: row('source-wide'), after: row('materialized-2k', { currentPointsPerCny: '10', currentUnitCredits: '1' }) };
  const scopedPreview: Pick<PricingAdminPreview, 'changes' | 'scenarios' | 'simulation'> = {
    changes: [scopedChange], scenarios: [{ ...scopedScenario, sourceRowId: 'different-source', adjustedCredits: '99' }, scopedScenario], simulation: null,
  };
  const mapped = pricingAdminPreviewForSource(scopedPreview, 'source-wide');
  assert.equal(mapped.change, scopedChange, 'Materialized change maps back to original draft row');
  assert.equal(mapped.scenario, scopedScenario, 'Shared materialized ID cannot substitute another source row scenario');
  assert.deepEqual(mapped.scenario?.specifications, { resolution: '2K', quality: 'high' }, 'Display scope comes from the server result');
  assert.equal(pricingAdminPreviewForSource(scopedPreview, 'materialized-2k').scenario, undefined, 'Materialized ID is not used as the source draft identity');
  assert.equal(pricingAdminPreviewForSource(scopedPreview, 'source-wide', 'wrong-target').scenario, undefined);
  assert.equal(pricingAdminPreviewForSource({ ...scopedPreview, scenarios: [], simulation: scopedScenario }, 'source-wide').scenario, scopedScenario, 'Single simulation uses the same source mapping');
  assert.deepEqual(pricingAdminPreviewForSource(null, 'source-wide'), { change: undefined, scenario: undefined });
  assert.equal(filterPricingAdminRows([row('member', { mode: 'custom', authoringRateMode: 'follow_global' }), row('exception')], { difference: 'custom' }).length, 1);

  const video = (id: string, modelId: string, specifications = { resolution: '480p', referenceVideo: 'none', pricingPurpose: 'standard' }) => row(id, {
    identity: { kind: 'video', channelId: 'seedance', modelId, billingMode: 'fixed', unit: 'second', specifications }, baseCny: null, canAdopt: false,
  });
  const videos = [video('v20', 'dreamina-seedance-2-0-260128'), video('v25', 'dreamina-seedance-2-5-260628'),
    video('ref', 'dreamina-seedance-2-0-260128', { resolution: '720p', referenceVideo: 'present', pricingPurpose: 'standard' }),
    video('draft', 'dreamina-seedance-2-0-260128', { resolution: '720p', referenceVideo: 'none', pricingPurpose: 'draft' })];
  const staged = stageVideoPricingReferences(empty, videos, '6.0');
  assert.equal(staged.authoring?.globalPointsPerCny, undefined, 'Existing global 6 is not replaced by suggestion 10');
  assert.deepEqual(staged.rows.map(item => item.id), ['v20', 'v25']);
  assert.equal(staged.rows[0].evidence?.sampledAt, null, 'Date-only source is not a fabricated exact timestamp');
  assert.match(staged.rows[0].evidence!.reference, /2026-10-18/);
  assert.deepEqual(staged.rows[1].baseRelation, { parentId: 'v20', factor: '1.5' });
  assert.equal(stageVideoPricingReferences(empty, videos).authoring?.globalPointsPerCny, '10.0', 'Suggestion enters only through explicit adoption helper');
  assert.equal(stageVideoPricingReferences(draft, videos, '6.0').authoring?.globalPointsPerCny, '12.0', 'Manual draft global wins');
  assert.equal(stageVideoPricingReferences(empty, videos, '12.0').authoring?.globalPointsPerCny, undefined, 'Existing global 12 is not replaced by suggestion 10');
  assert.equal(stageVideoPricingReferences({ rows: [], authoring: { globalPointsPerCny: '' } }, videos).authoring?.globalPointsPerCny, '', 'Incomplete manual global is not overwritten');
  const manual: PricingAdminChanges = { rows: [{ id: 'v20', mode: 'custom', customPointsPerCny: '9.0' }] };
  assert.deepEqual(stageVideoPricingReferences(manual, videos, '6.0'), manual, 'Existing manual parent does not silently adopt child references');
  assert.equal(stageVideoPricingReferences(empty, [row('configured', { ...videos[0], id: 'configured', baseCny: '0.20' })]), empty);
  assert.equal(stageVideoPricingReferences(empty, [{ ...videos[0], enabled: false }, videos[1]]), empty, 'Unavailable parent cannot create a dangling derived suggestion');

  const medium = row('medium', { isDefault: false, identity: { kind: 'image', channelId: 'medium-channel', modelId: 'gpt-image-2.5-sunburst', billingMode: 'fixed', unit: 'image', specifications: {} }, baseCny: '0.05', currentUnitCredits: '0.5' });
  const original = JSON.stringify(medium);
  const displayed = projectPricingDisplay(medium, { 'gpt-image-2.5-sunburst': { medium: 'medium-channel', max: 'max-channel' } });
  assert.equal(displayed.isDefault, true);
  assert.equal(displayed.identity, medium.identity, 'Display projection cannot change identity or specifications');
  assert.equal(displayed.baseCny, medium.baseCny);
  assert.equal(displayed.currentUnitCredits, medium.currentUnitCredits);
  assert.equal(JSON.stringify(medium), original, 'Source pricing row remains untouched');
  assert.equal(pricingDisplayName(displayed), 'medium · 中等');
  assert.equal(filterPricingAdminRows([displayed], { defaultsOnly: true, search: '中等' }).length, 1);
  assert.match(pricingDisplayScope(displayed), /全部合法规格/);
  assert.match(pricingDisplayRounding(displayed), /0.1/);
  assert.match(pricingDisplayRounding({ ...displayed, mode: 'legacy_fixed', legacyRounding: 'ceil_task' }), /向上取整/);
  assert.equal(pricingDisplayName(projectPricingDisplay(medium)), 'medium');
  const allFilters = { kind: 'image' as const, search: 'missing', channelId: 'other', defaultsOnly: true, difference: 'custom' as const, basisKind: 'supplier_cost_cny' as const };
  assert.equal(pricingActiveFilters(allFilters, [displayed]).length, 6, 'Every persisted hidden filter remains visible and clearable');
  assert.deepEqual(pricingActiveFilters({ ...allFilters, ...allPricingFilters }, [displayed]), []);
  assert.equal(filterPricingAdminRows([displayed], { ...allFilters, ...allPricingFilters }).length, 1);
  assert.match(videoPricingReferenceStatus(videos, empty), /未采用/);
  const adoptedParent = { ...videos[0], baseCny: '0.48229127', authoringEntry: { adoptedRevision: 'fixture-adopted', sourceKind: 'historical_statement' as const, evidence: staged.rows[0].evidence!, baseRelation: null } };
  const adoptedChild = { ...videos[1], baseCny: '0.72343691', authoringEntry: { adoptedRevision: 'fixture-child', sourceKind: 'derived' as const, evidence: null, baseRelation: { parentId: 'v20', factor: '1.5', parentRevision: 'fixture-adopted', exactProduct: '0.723436905' } } };
  assert.equal(videoPricingReferenceStatus([adoptedParent, adoptedChild], empty), '已采用 2 项');
  assert.match(videoPricingReferenceStatus([adoptedParent, videos[1]], staged), /已采用 1\/2 项.*2 项草稿待保存/);
  assert.match(videoPricingReferenceStatus([{ ...adoptedParent, confirmation: 'needs_review' }], empty), /待核实/);

  const gpt = row('gpt', { identity: { kind: 'image', channelId: 'fixture-gpt', modelId: 'gpt-image-2', billingMode: 'fixed', unit: 'image', specifications: {} } });
  assert.equal(stageGptImageReference(empty, gpt, {}, '6.0'), empty, 'Unknown scope cannot adopt');
  const gptScope = { quality: 'high', resolution: '2K', ratio: '1:1' };
  const gptDraft = stageGptImageReference({ rows: [{ id: 'gpt', specifications: gptScope }] }, gpt, gptScope, '6.0');
  assert.equal(gptDraft.rows[0].base?.amount, '0.10');
  assert.equal(gptDraft.authoring?.globalPointsPerCny, undefined);
  assert.deepEqual(gptDraft.rows[0].evidence?.specifications, gptScope);
  assert.equal(stageGptImageReference(empty, { ...gpt, identity: { ...gpt.identity, billingMode: 'actual' } }, gptScope), empty);
  assert.equal(stageGptImageReference(empty, { ...gpt, enabled: false }, gptScope), empty);
  assert.equal(stageGptImageReference(empty, row('unknown-model'), gptScope), empty);
  assert.equal(stageGptImageReference(draft, { ...gpt, id: 'a' }, gptScope), draft, 'Adoption does not overwrite manual price');

  const group: PricingEnhanceGroup = { basePointsPerSecond: { '480p': '5', '720p': '7', '1080p': '10', '2k': '16', '4k': '24' }, professionalMultiplier: '1.5', highFpsMultiplier: '1.2' };
  const enhanceRows = Object.entries(group.basePointsPerSecond).flatMap(([resolution, base]) => ['standard', 'professional'].flatMap(toolVersion => ['lte30', 'gt30'].map(fpsTier => row(`${resolution}:${toolVersion}:${fpsTier}`, {
    identity: { kind: 'enhance', channelId: 'enhance', modelId: 'fixture-enhance', billingMode: 'fixed', unit: 'second', specifications: { resolution, toolVersion, fpsTier } }, mode: 'legacy_fixed',
    currentUnitCredits: multiplyDecimal([base, toolVersion === 'professional' ? '1.5' : '1', fpsTier === 'gt30' ? '1.2' : '1']),
  }))));
  assert.deepEqual(pricingAdminEnhanceGroup(enhanceRows), group);
  assert.equal(pricingAdminEnhanceGroup([...enhanceRows.slice(1), { ...enhanceRows[0], currentUnitCredits: '5.1' }]), null, 'Mixed prices cannot be swallowed into a group');
  assert.equal(pricingAdminEnhanceGroup(enhanceRows.slice(1)), null);
  assert.equal(validPricingEnhanceGroup(group), true);
  assert.equal(validPricingEnhanceGroup({ ...group, professionalMultiplier: '' }), false);

  const submitted: PricingAdminChanges = { authoring: { globalPointsPerCny: '10.0', enhanceGroup: group }, rows: [{ id: 'a', baseRelation: relation }] };
  const laterGroup = { ...group, highFpsMultiplier: '1.3' };
  const remaining = consumePricingAdminDraft({ authoring: { globalPointsPerCny: '12.0', enhanceGroup: laterGroup }, rows: [{ id: 'a', baseRelation: null }] }, submitted);
  assert.equal(remaining.authoring?.globalPointsPerCny, '12.0');
  assert.deepEqual(remaining.authoring?.enhanceGroup, laterGroup);
  assert.equal(remaining.rows[0].baseRelation, null, 'Late receipt keeps later relation removal');
  assert.deepEqual(consumePricingAdminDraft(submitted, submitted), { rows: [] });
  const workspace = JSON.stringify({ schema: 1, actorId: 'admin-a', draft: { revision: 'policy-a', authoringRevision: 'authoring-a', catalogFingerprint: 'catalog-a', changes: submitted }, view: { ...defaultPricingAdminView, filtersOpen: true, changesOpen: true, enhanceDetailsOpen: true } });
  const restored = parsePricingAdminWorkspace(workspace, 'admin-a');
  assert.deepEqual(restored?.draft.changes, submitted);
  assert.equal(restored?.draft.authoringRevision, 'authoring-a');
  assert.equal(restored?.view.enhanceDetailsOpen, true);
  assert.equal(parsePricingAdminWorkspace(workspace, 'admin-b'), null);
  assert.notEqual(pricingAdminStorageKey('admin-a', 'workspace'), pricingAdminStorageKey('admin-b', 'workspace'));
  const input = { expectedRevision: 'policy-a', expectedAuthoringRevision: 'authoring-a', catalogFingerprint: 'catalog-a', action: { kind: 'save' as const, changes: submitted }, scenarios: [{ rowId: 'a', quantity: '5' }] };
  assert.notEqual(pricingAdminPreviewKey(input), pricingAdminPreviewKey({ ...input, expectedAuthoringRevision: 'authoring-b' }));
  assert.notEqual(pricingAdminPreviewKey(input), pricingAdminPreviewKey({ ...input, scenarios: [{ rowId: 'a', quantity: '10' }] }));
  return { assertions: 'explicit suggestions / independent follow dimensions / full draft merge / exact enhancement grouping / dual revision restoration / source-to-materialized mapping / metadata-only unavailable exit', runtime: 'lead-owned candidate gate; not run by worker' };
}

if (require.main === module) console.log(JSON.stringify(runPricingAuthoringUiContractFixture()));
