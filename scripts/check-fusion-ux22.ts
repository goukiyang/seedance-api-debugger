import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defaults, textFor, settingsForRow, generateBatch, applyRowConfiguration } from '../src/lib/character-fusion/engine';
import { builtinCatalogue } from '../src/lib/character-fusion/catalogue';
import { BODY_CARDS } from '../src/lib/character-fusion/body-cards';
import { emptyWorkspaceState, newCreationState, preparationFingerprint } from '../src/lib/character-fusion/actions';
import { effectiveFusionSettings, fusionSettingsChanges, applyFusionSettingChanges, configureFusionSettings, preparationForManualChange } from '../src/lib/character-fusion/configuration';
import { bindFusionAgentCommands, proposeFusionAgent, validateFusionAgentExecution } from '../src/lib/character-fusion/agent-adapter.server';
import type * as Workspace from '../src/lib/character-fusion/workspace.server';
import type * as Library from '../src/lib/character-fusion/catalogue-repository';

/** Isolated SQLite and deterministic in-memory proposal cases; no network or browser acceptance. */
export async function checkFusionUx22(input: { actor: { id: string }; repository: typeof Workspace; library: typeof Library }) {
  const { actor, repository, library } = input, catalogue = builtinCatalogue(), checks: string[] = [];
  const fixed = (values: string[]) => ({ enabled: true, locked: true, values, excluded: [] as string[], must: [] as string[] });
  const state = emptyWorkspaceState(); state.settings.count = 4; state.settings.lang = 'both';
  state.settings.catalogue!.traits.exaggeration = fixed(['巨掌', '巨脚']);
  state.settings.catalogue!.traits.occupation = { enabled: false, locked: false, values: [], excluded: ['商人'], must: [] };
  state.settings.cards = [{ id: 'card-ux22-legacy', title: '附加轮廓', titleEn: 'Additional outline', multi: true, joined: false, locked: false, value: '尖角',
    tags: [{ label: '尖角', en: 'pointed horns', status: 'default' }, { label: '软耳', en: 'soft ears', status: 'default' }, { label: '长尾', en: 'a long tail', status: 'exclude' }] }];
  const doc = await repository.createFusionWorkspace(actor, { opId: 'ux22-config-create', state });
  const jobs = catalogue.terms.filter(term => term.categoryId === 'occupation').slice(0, 4).map(term => term.id);
  const configuration = { count: 4, lang: 'both', cards: [{ id: 'occupation', use: 'distribute', values: jobs }] };
  const threeJobs = bindFusionAgentCommands([{ type: 'configure', configuration: { count: 4, cards: [{ id: 'occupation', use: 'random', values: jobs.slice(0, 3) }] } }, { type: 'configure', configuration: { cards: [{ id: 'occupation', use: 'distribute', values: jobs.slice(0, 3) }] } }], doc.workspace, 2200, { contract: 'configure' });
  assert.doesNotThrow(() => validateFusionAgentExecution(threeJobs, doc.workspace, catalogue, '做4套，职业尽量不同'));
  assert.throws(() => validateFusionAgentExecution(threeJobs, doc.workspace, catalogue, '做4套，职业各不相同'), /实际岗位重复/);
  let calls = 0;
  const proposal = await proposeFusionAgent({ workspace: doc.workspace, message: '做4套双语伙伴，岗位不同', binding: { contract: 'configure' }, seed: 2201,
    complete: async messages => { calls++; if (calls === 2) assert.match(String(messages[messages.length - 1].content), /聊天只配可见卡片/); return JSON.stringify({ reply: '同步卡片', commands: calls === 1 ? [{ type: 'generate', mode: 'append' }] : [{ type: 'configure', configuration }] }); },
    read: async () => ({}), validateCommands: commands => validateFusionAgentExecution(commands, doc.workspace, catalogue, '岗位不同'),
  });
  assert.equal(proposal.iterations, 2); assert.equal((await repository.getWorkspace(actor, doc.workspace.id)).workspace.version, 1);
  const configured = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-configure', baseVersion: 1, commands: bindFusionAgentCommands(proposal.proposal.commands, doc.workspace, 2201, { contract: 'configure' }) });
  assert.equal(configured.rowsPage.total, 0); assert(configured.operation.reversible);
  assert.deepEqual(configured.workspace.state.settings.catalogue!.traits.exaggeration, state.settings.catalogue!.traits.exaggeration);
  assert.deepEqual(configured.workspace.state.settings.catalogue!.traits.occupation.excluded, ['商人']);
  const first = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-click-first', baseVersion: configured.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2201 }] });
  const second = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-click-second', baseVersion: first.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2202 }] });
  assert.equal(second.rowsPage.total, 8); assert.deepEqual(second.workspace.rows.slice(0, 4), first.workspace.rows);
  for (const rows of [second.workspace.rows.slice(0, 4), second.workspace.rows.slice(4)]) {
    assert.equal(new Set(rows.map(row => row.design!.traits.occupation[0].zh)).size, 4);
    for (const row of rows) { assert.match(row.catalogueSnapshot!.body.zh, /巨掌/); assert.match(row.catalogueSnapshot!.body.zh, /巨脚/); assert.match(row.catalogueSnapshot!.body.en, /oversized palms/); }
  }
  assert.deepEqual(second.workspace.state.settings.catalogue!.traits.occupation.must, configured.workspace.state.settings.catalogue!.traits.occupation.must);
  checks.push('UX22聊天配置与点击生成：服务端拒直接生成、同轮纠正后0新增，两次点击各4条/四岗位分配持续生效；尽量不同保小硬池，明确各异不足拒绝，旧结果及人工锁排除保留');

  const nativeState = emptyWorkspaceState(); nativeState.settings.count = 4;
  nativeState.settings.cards = structuredClone(state.settings.cards);
  const controlsDoc = await repository.createFusionWorkspace(actor, { opId: 'ux22-all-controls-create', state: nativeState });
  const conceptTerm = catalogue.terms.find(term => term.categoryId === 'dimension:concept')!;
  const allControls = await repository.executeWorkspaceOperation(actor, controlsDoc.workspace.id, { opId: 'ux22-all-controls-configure', baseVersion: 1, commands: [{ type: 'configure', configuration: { cards: [
    { id: 'dimension:concept', use: 'each', values: [conceptTerm.id] },
    { id: BODY_CARDS[0].id, use: 'each', values: [BODY_CARDS[0].value] },
    { id: 'card-ux22-legacy', use: 'distribute', values: ['尖角', '软耳'] },
  ] } }] });
  assert.equal(allControls.rowsPage.total, 0);
  const controlsRows = await repository.executeWorkspaceOperation(actor, controlsDoc.workspace.id, { opId: 'ux22-all-controls-click', baseVersion: allControls.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2203 }] });
  assert.equal(controlsRows.rowsPage.total, 4); assert(controlsRows.workspace.rows.every(row => row.concept.name === conceptTerm.nameZh));
  assert(controlsRows.workspace.rows.some(row => row.cards?.some(card => card.id === 'card-ux22-legacy' && card.label.includes('尖角'))));
  assert(controlsRows.workspace.rows.some(row => row.cards?.some(card => card.id === 'card-ux22-legacy' && card.label.includes('软耳'))));
  assert(controlsRows.workspace.rows.every(row => row.cards?.some(card => card.id === BODY_CARDS[0].id && card.label === BODY_CARDS[0].value)));
  const guarded = controlsRows.workspace.state.settings;
  await assert.rejects(() => repository.executeWorkspaceOperation(actor, controlsDoc.workspace.id, { opId: 'ux22-excluded-retained', baseVersion: controlsRows.workspace.version, commands: [{ type: 'configure', configuration: { cards: [{ id: 'card-ux22-legacy', use: 'each', values: ['长尾'] }] } }] }));
  assert.deepEqual((await repository.getWorkspace(actor, controlsDoc.workspace.id)).workspace.state.settings, guarded);
  checks.push('UX22控制类别闭环：原生具体主题、原生身形预设和旧自定义卡都转真实完整设置，分别用/每套都带进结果，原排除不静默清');

  const baseDirection = { zh: '轻盈黏土造型', en: 'Lightweight clay design' };
  const tempDoc = await repository.createFusionWorkspace(actor, { opId: 'ux22-batch-create', state: { ...emptyWorkspaceState(), settings: { ...defaults(), count: 4, requirementsEnabled: true, requirements: baseDirection.zh, requirementsEn: baseDirection.en } } });
  const staged = await repository.executeWorkspaceOperation(actor, tempDoc.workspace.id, { opId: 'ux22-batch-stage', baseVersion: 1, commands: [{ type: 'configure', configuration: { scope: 'batch', requirements: { zh: '仅本批水墨造型', en: 'Ink-wash design for this batch' } } }] });
  assert.equal(staged.rowsPage.total, 0); assert.equal(staged.workspace.state.settings.requirements, baseDirection.zh);
  const displayed = effectiveFusionSettings(staged.workspace.state.settings, staged.workspace.state.preparation!.batch, catalogue); assert.equal(displayed.requirements, '仅本批水墨造型');
  const inherited = newCreationState(staged.workspace.state, 'inherit', catalogue);
  assert.equal(inherited.settings.requirements, displayed.requirements); assert.equal(inherited.preparation, undefined); assert.deepEqual(inherited.messages, []); assert.deepEqual(inherited.selectedIds, []);
  const recipeId = randomUUID();
  const recipeSaved = await repository.executeWorkspaceOperation(actor, tempDoc.workspace.id, { opId: 'ux22-batch-save-recipe', baseVersion: staged.workspace.version, commands: [{ type: 'saveRecipe', id: recipeId, name: '可见本批配方', preparationHash: preparationFingerprint(staged.workspace.state.preparation!.batch) }] });
  assert.deepEqual(recipeSaved.workspace.state.preparation, staged.workspace.state.preparation);
  const { prisma } = await import('../src/lib/prisma');
  const storedRecipe = await prisma.userPreference.findUnique({ where: { user_id_key: { user_id: actor.id, key: `character_fusion_recipe_v1:${recipeId}` } } });
  assert.equal(JSON.parse(storedRecipe!.value_json).settings.requirements, displayed.requirements);
  const wrongVersion = await repository.queryWorkspaceOperation(actor, tempDoc.workspace.id, 'ux22-batch-click'); assert.equal(wrongVersion.status, 'unknown');
  await assert.rejects(() => repository.executeWorkspaceOperation(actor, tempDoc.workspace.id, { opId: 'ux22-batch-missing-hash', baseVersion: recipeSaved.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2204 }] }));
  const batch = await repository.executeWorkspaceOperation(actor, tempDoc.workspace.id, { opId: 'ux22-batch-click', baseVersion: recipeSaved.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2204, preparationHash: preparationFingerprint(staged.workspace.state.preparation!.batch) }] });
  assert(batch.workspace.rows.every(row => row.catalogueSnapshot!.body.zh.includes('仅本批水墨'))); assert.equal(batch.workspace.state.preparation, undefined); assert.equal(batch.workspace.state.settings.requirements, baseDirection.zh);
  const batchReplay = await repository.executeWorkspaceOperation(actor, tempDoc.workspace.id, { opId: 'ux22-batch-click', baseVersion: recipeSaved.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2204, preparationHash: preparationFingerprint(staged.workspace.state.preparation!.batch) }] }); assert.equal(batchReplay.rowsPage.total, 4);
  const batchUndo = await repository.executeWorkspaceOperation(actor, tempDoc.workspace.id, { opId: 'ux22-batch-undo', baseVersion: batch.workspace.version, commands: [{ type: 'undo', operationId: 'ux22-batch-click' }] });
  assert.equal(batchUndo.rowsPage.total, 0); assert.equal(batchUndo.workspace.state.preparation, undefined); assert.equal(batchUndo.workspace.state.settings.requirements, baseDirection.zh);
  const afterUndo = await repository.executeWorkspaceOperation(actor, tempDoc.workspace.id, { opId: 'ux22-batch-after-undo', baseVersion: batchUndo.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2205 }] });
  assert(afterUndo.workspace.rows.every(row => row.catalogueSnapshot!.body.zh.includes(baseDirection.zh) && !row.catalogueSnapshot!.body.zh.includes('仅本批水墨')));
  checks.push('UX22仅本批与复制：卡片effective可见且复制取可见值；点击原号一次消费，撤销生成不复活临时要求，再生成沿长期设置');

  const rowWorkspace = second.workspace, target = rowWorkspace.rows[1], otherRows = rowWorkspace.rows.filter(row => row.id !== target.id), originalBody = target.catalogueSnapshot!.body;
  const rowConfig = bindFusionAgentCommands([{ type: 'configure', configuration: { requirements: { zh: '蒸汽朋克画风，保留其它明确内容', en: 'Steampunk style while retaining the other explicit details' } } }], rowWorkspace, 2206, { contract: 'configure', target: { rowId: target.id, version: target.version } });
  const rowStaged = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-row-stage', baseVersion: rowWorkspace.version, commands: rowConfig });
  assert.deepEqual(rowStaged.workspace.rows, rowWorkspace.rows); assert.deepEqual(rowStaged.workspace.state.settings, rowWorkspace.state.settings);
  const rowClicked = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-row-click', baseVersion: rowStaged.workspace.version, commands: [{ type: 'applyPreparedRow', rowId: target.id, expectedVersion: target.version, seed: 2206 }] });
  assert.deepEqual(rowClicked.workspace.rows.filter(row => row.id !== target.id), otherRows); assert.deepEqual(rowClicked.workspace.state.settings, rowWorkspace.state.settings); assert.equal(rowClicked.workspace.state.preparation?.row, undefined);
  const changedTarget = rowClicked.workspace.rows.find(row => row.id === target.id)!; assert.match(changedTarget.catalogueSnapshot!.body.zh, /蒸汽朋克/); assert.deepEqual(changedTarget.source, target.source);
  for (const key of ['name', 'detail', 'category', 'source', 'concept', 'mechanism', 'personality', 'cards'] as const) assert.deepEqual(changedTarget[key], target[key]);
  assert.deepEqual(changedTarget.design!.sections, target.design!.sections);
  const rowUndo = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-row-undo', baseVersion: rowClicked.workspace.version, commands: [{ type: 'undo', operationId: 'ux22-row-click' }] });
  assert.deepEqual(rowUndo.workspace.rows.find(row => row.id === target.id)!.catalogueSnapshot!.body, originalBody); assert.equal(rowUndo.workspace.state.preparation?.row, undefined);
  const refreshed = await repository.getWorkspace(actor, doc.workspace.id); assert.equal(refreshed.workspace.state.preparation?.row, undefined);
  await assert.rejects(() => repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-row-old-draft', baseVersion: refreshed.workspace.version, commands: [{ type: 'applyPreparedRow', rowId: target.id, expectedVersion: target.version, seed: 2206 }] }));
  const detailSettings = defaults(); detailSettings.count = 4; detailSettings.bossDimensions.push('equipment', 'signature', 'entity', 'physique');
  detailSettings.boss = { ...detailSettings.boss, equipment: '工具机关类', signature: '头部装饰类', entity: '共生伴生类', physique: '角形轮廓类' };
  const detailed = { ...generateBatch(detailSettings, 2241)[0], name: '保留原角色名' };
  const detailedBase = settingsForRow(detailSettings, detailed);
  const changedCardSettings = configureFusionSettings(detailedBase, { cards: [{ id: 'stature', use: 'each', values: ['瘦长'] }] }, catalogue, 'ux22-keep-details');
  const cardAdjusted = applyRowConfiguration(detailed, detailedBase, changedCardSettings, 5555);
  for (const key of ['name', 'detail', 'category', 'source', 'concept', 'mechanism', 'personality'] as const) assert.deepEqual(cardAdjusted[key], detailed[key]);
  assert.equal(cardAdjusted.design!.traits.stature[0].zh, '瘦长');
  const emptyDraft = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-empty-row-stage', baseVersion: refreshed.workspace.version, commands: [{ type: 'prepare', value: { formatVersion: 1, row: { rowId: target.id, version: rowUndo.workspace.rows.find(row => row.id === target.id)!.version, changes: [] } }, expected: null }] });
  await assert.rejects(() => repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-empty-row-apply', baseVersion: emptyDraft.workspace.version, commands: [{ type: 'applyPreparedRow', rowId: target.id, expectedVersion: rowUndo.workspace.rows.find(row => row.id === target.id)!.version, seed: 1234 }] }), /还没有待应用/);
  checks.push('UX22单条待应用：配置0结果改动且下批settings不变，点击仅更新绑定行，撤销恢复正文不复活旧version草稿，刷新与旧应用均安全');

  const wordDoc = await repository.createFusionWorkspace(actor, { opId: 'ux22-inline-create', state: { ...emptyWorkspaceState(), settings: { ...defaults(), count: 4, lang: 'both' } } });
  const wordConfiguration = { inlineCards: [{ title: '工程临时光纹', titleEn: 'Engineering temporary light pattern', multi: true, terms: [{ nameZh: '潮息光纹', nameEn: 'Tidal breathing light pattern', descriptionZh: '肩背光纹随呼吸缓缓明暗变化。', descriptionEn: 'Shoulder and back light patterns brighten and dim slowly with breathing. ' }] }] };
  const wordConfigured = await repository.executeWorkspaceOperation(actor, wordDoc.workspace.id, { opId: 'ux22-inline-config', baseVersion: 1, commands: [{ type: 'configure', configuration: wordConfiguration }] });
  assert.equal(wordConfigured.rowsPage.total, 0); const inline = wordConfigured.workspace.state.settings.cards.find(card => card.catalogueCategoryId)!;
  assert(inline.tags[0].termId); assert(!(await library.readFusionCatalogue(actor)).catalogue.terms.some(term => term.id === inline.tags[0].termId));
  const wordRows = await repository.executeWorkspaceOperation(actor, wordDoc.workspace.id, { opId: 'ux22-inline-click', baseVersion: wordConfigured.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2207 }] });
  for (const row of wordRows.workspace.rows) { assert(row.catalogueSnapshot!.selections[inline.id].includes(inline.tags[0].termId!)); assert.match(row.catalogueSnapshot!.body.zh, /肩背光纹随呼吸/); assert.match(row.catalogueSnapshot!.body.en, /brighten and dim slowly/); assert(!/breathing\.\s*\./.test(row.catalogueSnapshot!.body.en)); }
  const { prepareFusionAgentContinuation, previewFusionAgentContinuation, confirmFusionAgentContinuation } = await import('../src/lib/character-fusion/agent-continuation.server');
  const reserve = await repository.reserveAssistantOperation(actor, wordDoc.workspace.id, { opId: 'ux22-inline-save-source', baseVersion: wordRows.workspace.version, message: '存入个人词库', model: 'inline-card' });
  const draftEntries = [{ kind: 'category', data: { id: inline.catalogueCategoryId, nameZh: inline.title, nameEn: inline.titleEn, descriptionZh: inline.title, descriptionEn: inline.titleEn, group: 'extra', multi: true, generationKind: 'trait' } },
    { kind: 'term', data: { id: inline.tags[0].termId, categoryId: inline.catalogueCategoryId, nameZh: inline.tags[0].label, nameEn: inline.tags[0].en, descriptionZh: inline.tags[0].descriptionZh, descriptionEn: inline.tags[0].descriptionEn } }];
  const wordPending = await prepareFusionAgentContinuation(actor, wordRows.workspace, { sourceOpId: 'ux22-inline-save-source', intentFingerprint: reserve.intentFingerprint, drafts: draftEntries, commands: [], message: '存入个人词库', reply: '仅预览保存，不生成', model: 'inline-card' });
  assert(wordPending.continuation && typeof wordPending.continuation === 'object' && 'mode' in wordPending.continuation); assert.equal(wordPending.continuation.mode, 'save'); const preview = await previewFusionAgentContinuation(actor, wordDoc.workspace.id, 'ux22-inline-save-source'); assert(preview.preview);
  const savedWord = await confirmFusionAgentContinuation(actor, wordDoc.workspace.id, 'ux22-inline-save-source', { previewVersion: preview.preview.version });
  assert('rowsPage' in savedWord); assert.equal(savedWord.rowsPage?.total, 4);
  const savedAgain = await confirmFusionAgentContinuation(actor, wordDoc.workspace.id, 'ux22-inline-save-source', {}); assert('rowsPage' in savedAgain); assert.equal(savedAgain.rowsPage?.total, 4);
  const freshCatalogue = (await library.readFusionCatalogue(actor)).catalogue; assert.equal(freshCatalogue.terms.filter(term => term.id === inline.tags[0].termId).length, 1);
  const freshState = newCreationState(wordRows.workspace.state, 'fresh', freshCatalogue), reuseDoc = await repository.createFusionWorkspace(actor, { opId: 'ux22-formal-reuse-create', state: freshState });
  const reused = await repository.executeWorkspaceOperation(actor, reuseDoc.workspace.id, { opId: 'ux22-formal-reuse-config', baseVersion: 1, commands: [{ type: 'configure', configuration: { cards: [{ id: inline.catalogueCategoryId!, use: 'each', values: [inline.tags[0].termId!] }] } }] });
  assert.equal(reused.rowsPage.total, 0); assert(!reused.workspace.state.settings.cards.some(card => card.catalogueCategoryId === inline.catalogueCategoryId && card.joined));
  const reusedRows = await repository.executeWorkspaceOperation(actor, reuseDoc.workspace.id, { opId: 'ux22-formal-reuse-click', baseVersion: reused.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2208 }] });
  assert(reusedRows.workspace.rows.every(row => row.catalogueSnapshot!.selections[inline.catalogueCategoryId!]?.includes(inline.tags[0].termId!) && textFor(row, { ...reusedRows.workspace.state.settings, lang: 'en' }).includes('brighten and dim slowly')));
  checks.push('UX22临时词闭环：原inline卡片持久含义/稳定ID真实进四条，未先入库；原预览只保存且幂等不生成，刷新后新文档正式词复用不重复显示');

  const current = await repository.getWorkspace(actor, controlsDoc.workspace.id), snapshot = structuredClone(current.workspace.state.settings);
  const localEffective = { ...snapshot, requirementsEnabled: true, requirements: '只这一批剪纸', requirementsEn: 'Paper cut for this batch only' };
  const pending = { formatVersion: 1 as const, batch: { formatVersion: 1 as const, scope: 'batch' as const, overlay: fusionSettingsChanges(snapshot, localEffective) } };
  const planned = await repository.executeWorkspaceOperation(actor, controlsDoc.workspace.id, { opId: 'ux22-manual-stage', baseVersion: current.workspace.version, commands: [{ type: 'prepare', value: pending, expected: current.workspace.state.preparation || null }] });
  const manualNew = { ...localEffective, requirements: '手动后改的本批木刻', requirementsEn: 'Manually revised woodcut for this batch' };
  const manualPending = { ...pending, batch: { ...pending.batch, overlay: fusionSettingsChanges(snapshot, manualNew) } };
  const manualSaved = await repository.executeWorkspaceOperation(actor, controlsDoc.workspace.id, { opId: 'ux22-manual-later', baseVersion: planned.workspace.version, commands: [{ type: 'prepare', value: manualPending, expected: pending }] });
  await assert.rejects(() => repository.executeWorkspaceOperation(actor, controlsDoc.workspace.id, { opId: 'ux22-old-click-reject', baseVersion: planned.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2209, preparationHash: preparationFingerprint(pending.batch) }] }));
  const manualClicked = await repository.executeWorkspaceOperation(actor, controlsDoc.workspace.id, { opId: 'ux22-manual-current-click', baseVersion: manualSaved.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2209, preparationHash: preparationFingerprint(manualPending.batch) }] });
  assert(manualClicked.rowChanges?.upsert.every(row => row.catalogueSnapshot!.body.zh.includes(manualNew.requirements))); assert.equal(manualClicked.workspace.state.settings.requirements, snapshot.requirements);
  const currentRows = manualClicked.workspace.rows, keepIds = [currentRows[0].id];
  const retainCommands = bindFusionAgentCommands([{ type: 'retain', rowIds: keepIds, retained: true }], manualClicked.workspace, 2209, { contract: 'configure' });
  const kept = await repository.executeWorkspaceOperation(actor, controlsDoc.workspace.id, { opId: 'ux22-retain-visible', baseVersion: manualClicked.workspace.version, commands: retainCommands }); assert(kept.workspace.state.retainedIds.includes(keepIds[0]));
  assert.throws(() => bindFusionAgentCommands([{ type: 'patchRow', rowId: currentRows[0].id, patch: { requirements: { zh: '不应直接改', en: 'Must not change directly' } } }], kept.workspace, 2209, { contract: 'configure' }), /本人点击/);
  assert.equal(applyFusionSettingChanges(snapshot, fusionSettingsChanges(snapshot, manualNew), catalogue).requirements, manualNew.requirements);
  const oldCountPlan = { formatVersion: 1 as const, batch: { ...pending.batch, count: 8 } };
  const changedCount = preparationForManualChange(snapshot, { ...localEffective, count: 12 }, oldCountPlan);
  assert.equal(effectiveFusionSettings(snapshot, changedCount!.batch, catalogue).count, 12);
  let invalidCalls = 0;
  await assert.rejects(() => proposeFusionAgent({ workspace: kept.workspace, message: '配置4套', binding: { contract: 'configure' }, complete: async () => { invalidCalls++; return JSON.stringify({ reply: '无效字段', commands: [{ type: 'configure', configuration: { cards: [{ id: 'stature', use: 'bad' }] } }] }); }, read: async () => ({}) }), error => {
    assert.equal(invalidCalls, 6); assert(error instanceof Error && 'userMessage' in error); assert.match(String(error.userMessage), /输入、当前卡片和已有方案都保留/); assert.match(error.message, /each\/random\/distribute/); return true;
  });
  let missingConfiguration = 0;
  const correctedConfiguration = await proposeFusionAgent({ workspace: kept.workspace, message: '做4套水彩伙伴', binding: { contract: 'configure' }, complete: async messages => { missingConfiguration++; if (missingConfiguration === 2) assert.match(String(messages[messages.length - 1].content), /必须用configure同步可见卡片/); return JSON.stringify({ reply: '先配卡片', commands: missingConfiguration === 1 ? [{ type: 'context', summary: '只有说明，尚未配置' }] : [{ type: 'configure', configuration: { count: 4 } }] }); }, read: async () => ({}) });
  assert.equal(correctedConfiguration.iterations, 2);
  checks.push('UX22可见配置并发：手动后改本批条件覆盖同源overlay，旧按钮/hash拒绝且仅当前条件进正文；明确保留真绑定、聊天直接改结果拒绝');
  return checks;
}
