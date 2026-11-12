import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defaults, parseSettings, textFor, settingsForRow, generateBatch, applyRowConfiguration, allocateFusionBatch } from '../src/lib/character-fusion/engine';
import { builtinCatalogue } from '../src/lib/character-fusion/catalogue';
import { BODY_CARDS } from '../src/lib/character-fusion/body-cards';
import { emptyWorkspaceState, newCreationState, preparationFingerprint } from '../src/lib/character-fusion/actions';
import { effectiveFusionSettings, fusionSettingsChanges, applyFusionSettingChanges, configureFusionSettings, parseFusionConfiguration, preparationForManualChange } from '../src/lib/character-fusion/configuration';
import { bindFusionAgentCommands, proposeFusionAgent, validateFusionAgentExecution, fusionAgentScene, FUSION_CONFIGURATION_SYSTEM, FusionAgentError, readFusionAgentControls } from '../src/lib/character-fusion/agent-adapter.server';
import type * as Workspace from '../src/lib/character-fusion/workspace.server';
import type * as Library from '../src/lib/character-fusion/catalogue-repository';
import { mergeWorkspaceRows, mergeWorkspaceState, stateCommands } from '../src/app/tools/character-fusion/workspace-client';

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

  const sourceDoc = await repository.createFusionWorkspace(actor, { opId: 'ux22-source-shadow-create', state: emptyWorkspaceState() });
  const animals = catalogue.terms.filter(term => term.categoryId === 'dimension:source' && term.data?.group === '动物').slice(0, 4);
  assert.equal(animals.length, 4);
  const animalConfiguration = { count: 4, lang: 'both', cards: [{ id: 'dimension:source', use: 'distribute', values: animals.map(term => term.id) }] };
  let sourceCalls = 0;
  const animalProposal = await proposeFusionAgent({ workspace: sourceDoc.workspace, message: '小动物母体各不相同', binding: { contract: 'configure' }, seed: 2220,
    complete: async messages => {
      sourceCalls++;
      if (sourceCalls === 2) assert.match(String(messages[messages.length - 1].content), /不能另建母体选择卡/);
      return JSON.stringify({ reply: '同步母体', commands: [{ type: 'configure', configuration: sourceCalls === 1
        ? { ...animalConfiguration, inlineCards: [{ title: '小动物母体', titleEn: 'Small Animal Base', use: 'distribute', terms: [{ nameZh: '睡鼠', nameEn: 'Dormouse', descriptionZh: '以睡鼠为母体', descriptionEn: 'Use a dormouse as the base' }] }] }
        : animalConfiguration }] });
    }, read: async () => ({}), validateCommands: commands => validateFusionAgentExecution(commands, sourceDoc.workspace, catalogue),
  });
  assert.equal(sourceCalls, 2); assert.equal((await repository.getWorkspace(actor, sourceDoc.workspace.id)).rowsPage.total, 0);
  assert.doesNotThrow(() => bindFusionAgentCommands([{ type: 'configure', configuration: { inlineCards: [{ title: '母体表面纹理', titleEn: 'Source surface texture', terms: [{ nameZh: '柔软绒毛', nameEn: 'Soft fur', descriptionZh: '柔软绒毛表面', descriptionEn: 'A surface of soft fur' }] }] } }], sourceDoc.workspace, 2220, { contract: 'configure' }));
  const animalSettings = await repository.executeWorkspaceOperation(actor, sourceDoc.workspace.id, { opId: 'ux22-source-shadow-configure', baseVersion: 1,
    commands: bindFusionAgentCommands(animalProposal.proposal.commands, sourceDoc.workspace, 2220, { contract: 'configure' }) });
  assert.equal(animalSettings.rowsPage.total, 0);
  const animalRows = await repository.executeWorkspaceOperation(actor, sourceDoc.workspace.id, { opId: 'ux22-source-shadow-click', baseVersion: animalSettings.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2220 }] });
  assert.equal(animalRows.rowsPage.total, 4); assert.deepEqual(new Set(animalRows.workspace.rows.map(row => row.source.name)), new Set(animals.map(term => term.nameZh)));
  for (const row of animalRows.workspace.rows) {
    assert.match(row.catalogueSnapshot!.body.zh, new RegExp(row.source.name));
    assert(!row.catalogueSnapshot!.body.zh.includes('睡鼠')); assert(!row.catalogueSnapshot!.body.en.includes('dormouse'));
  }
  checks.push('UX22母体单一来源：小动物附加母体卡同轮拒绝并纠正到原生目录，聊天0新增→点击4个实际母体，不出现另一睡鼠描述；正常表面纹理卡仍允许');

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
  // Read the durable compact row, exactly as a later assistant HTTP request does.
  const compactPage = await repository.getWorkspace(actor, doc.workspace.id, { rowId: target.id });
  const compactTarget = compactPage.workspace.rows.find(row => row.id === target.id)!;
  assert(compactTarget.catalogueSnapshot?.settingsRef); assert.equal(compactTarget.catalogueSnapshot.settings, undefined);
  const agentPage = await repository.getWorkspace(actor, doc.workspace.id, { rowId: target.id }, { resolveSelectedRow: true });
  const agentTarget = agentPage.workspace.rows.find(row => row.id === target.id)!;
  assert(agentTarget.catalogueSnapshot?.settings);
  const hydratedPlan = bindFusionAgentCommands([{ type: 'configure', configuration: { requirements: { zh: '蒸汽朋克，保其它明确要求', en: 'Steampunk, retaining the other explicit requirements', enabled: true } } }], agentPage.workspace, 2251,
    { contract: 'configure', target: { rowId: agentTarget.id, version: agentTarget.version } });
  assert.doesNotThrow(() => validateFusionAgentExecution(hydratedPlan, agentPage.workspace, catalogue, '只改这张画风'));
  const selectedByNumber = await repository.getWorkspace(actor, doc.workspace.id, { displayNo: agentTarget.displayNo }, { resolveSelectedRow: true });
  assert(selectedByNumber.workspace.rows.find(row => row.id === target.id)?.catalogueSnapshot?.settings);
  assert.deepEqual((await repository.getWorkspace(actor, doc.workspace.id, { rowId: target.id })).workspace, compactPage.workspace);
  checks.push('UX22单条HTTP接线：耐久settingsRef默认紧凑返回，助手显式读目标或序号在同一权限事务解析原配置，真实configure预检通过且只读不改原行/全局');
  checks.push('UX22单条待应用：配置0结果改动且下批settings不变，点击仅更新绑定行，撤销恢复正文不复活旧version草稿，刷新与旧应用均安全');

  const wordDoc = await repository.createFusionWorkspace(actor, { opId: 'ux22-inline-create', state: { ...emptyWorkspaceState(), settings: { ...defaults(), count: 4, lang: 'both' } } });
  const wordConfiguration = { inlineCards: [{ title: '工程临时光纹', titleEn: 'Engineering temporary light pattern', multi: true, terms: [{ nameZh: '潮息光纹', nameEn: 'Tidal breathing light pattern', descriptionZh: '肩背光纹随呼吸缓缓明暗变化。', descriptionEn: 'Shoulder and back light patterns brighten and dim slowly with breathing. ' }] }] };
  const wordConfigured = await repository.executeWorkspaceOperation(actor, wordDoc.workspace.id, { opId: 'ux22-inline-config', baseVersion: 1, commands: [{ type: 'configure', configuration: wordConfiguration }] });
  assert.equal(wordConfigured.rowsPage.total, 0); const inline = wordConfigured.workspace.state.settings.cards.find(card => card.catalogueCategoryId)!;
  assert(inline.tags[0].termId); assert(!(await library.readFusionCatalogue(actor)).catalogue.terms.some(term => term.id === inline.tags[0].termId));
  const wordRows = await repository.executeWorkspaceOperation(actor, wordDoc.workspace.id, { opId: 'ux22-inline-click', baseVersion: wordConfigured.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 2207 }] });
  for (const row of wordRows.workspace.rows) { assert(row.catalogueSnapshot!.selections[inline.id].includes(inline.tags[0].termId!)); assert.match(row.catalogueSnapshot!.body.zh, /肩背光纹随呼吸/); assert.match(row.catalogueSnapshot!.body.en, /brighten and dim slowly/); assert(!/breathing\.\s*\./.test(row.catalogueSnapshot!.body.en)); }
  const fullWordDefinitions = readFusionAgentControls(wordConfigured.workspace, { kind: 'constraints', categoryId: inline.id, field: 'definitions', limit: 1 });
  assert('items' in fullWordDefinitions);
  assert.deepEqual(fullWordDefinitions.items, [{ nameZh: inline.tags[0].label, nameEn: inline.tags[0].en, descriptionZh: inline.tags[0].descriptionZh, descriptionEn: inline.tags[0].descriptionEn }]);
  assert.equal(fullWordDefinitions.complete, true);
  const wordScene = fusionAgentScene(wordConfigured.workspace);
  assert.deepEqual(wordScene.settings.customCards.find(card => card.id === inline.id)?.definitionsRead, { kind: 'constraints', categoryId: inline.id, field: 'definitions', limit: 5 });
  const { prepareFusionAgentContinuation, previewFusionAgentContinuation, confirmFusionAgentContinuation } = await import('../src/lib/character-fusion/agent-continuation.server');
  assert.equal((await repository.queryWorkspaceOperation(actor, wordDoc.workspace.id, 'ux22-inline-save-source')).status, 'unknown');
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

/** Fix01: actual public native groups and a private terminal rejection, without any model/network call. */
export async function checkFusionUx22Fix01(input: { actor: { id: string }; repository: typeof Workspace; library: typeof Library }) {
  const { actor, repository } = input, catalogue = builtinCatalogue(), checks: string[] = [];
  assert.match(FUSION_CONFIGURATION_SYSTEM, /当前必要core仅为母体\(source\)、跨界概念\(concept\)/);
  assert(!FUSION_CONFIGURATION_SYSTEM.includes('personality是必要core'));
  for (const [dimension, groups] of [['source', ['工业', '动物']], ['concept', ['深海科研', '蒸汽科技']], ['mechanism', ['无外置机关', '展开折叠类']]] as const) {
    for (const use of ['each', 'random', 'distribute'] as const) {
      const state = emptyWorkspaceState(); state.settings.count = 4; state.settings.lang = 'both';
      state.settings.catalogue!.traits.exaggeration = { enabled: true, locked: true, values: ['巨掌', '巨脚'], excluded: [], must: [] };
      const doc = await repository.createFusionWorkspace(actor, { opId: `ux22-fix01-${dimension}-${use}-new`, state });
      const values = use === 'each' ? [groups[0]] : [...groups];
      const configured = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: `ux22-fix01-${dimension}-${use}-config`, baseVersion: 1, commands: [{ type: 'configure', configuration: { cards: [{ id: `dimension:${dimension}`, use, values }] } }] });
      assert.equal(configured.rowsPage.total, 0);
      const selection = configured.workspace.state.settings.catalogue?.dynamic?.selections[`dimension:${dimension}`];
      assert.deepEqual(selection?.must || [], []);
      assert.deepEqual(configured.workspace.state.settings.catalogue!.traits.exaggeration, state.settings.catalogue!.traits.exaggeration);
      const generated = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: `ux22-fix01-${dimension}-${use}-click`, baseVersion: configured.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 1481 }] });
      assert.equal(generated.rowsPage.total, 4);
      assert(generated.workspace.rows.every(row => values.includes(row.category[dimension] as typeof values[number])));
      if (use === 'distribute') for (const group of groups) assert(generated.workspace.rows.some(row => row.category[dimension] === group));
      for (const row of generated.workspace.rows) { assert.match(row.catalogueSnapshot!.body.zh, /巨掌/); assert.match(row.catalogueSnapshot!.body.en, /oversized palms/); }
      assert.deepEqual(generated.workspace.state.settings, configured.workspace.state.settings);
    }
  }
  const constrained = emptyWorkspaceState().settings;
  const sourceTerms = catalogue.terms.filter(term => term.categoryId === 'dimension:source');
  const industrial = sourceTerms.filter(term => term.data?.group === '工业').slice(0, 2), animal = sourceTerms.find(term => term.data?.group === '动物')!;
  const candidates = [...industrial, animal].map(term => term.id), excluded = [industrial[0].id];
  constrained.catalogue!.dynamic = { formatVersion: 1, selections: { 'dimension:source': { enabled: true, locked: false, values: [], must: [], candidates, excluded } }, snapshot: catalogue };
  for (const use of ['each', 'random', 'distribute'] as const) {
    const next = configureFusionSettings(constrained, { cards: [{ id: 'dimension:source', use, values: use === 'each' ? ['工业'] : ['工业', '动物'] }] }, catalogue, 'fix01-hard-pool');
    const selection = next.catalogue!.dynamic!.selections['dimension:source'];
    assert(selection.candidates!.every(id => candidates.includes(id))); assert.deepEqual(selection.excluded, excluded); assert.deepEqual(selection.must, []);
    if (use !== 'each') assert.deepEqual(selection.candidates, candidates);
  }
  assert.throws(() => configureFusionSettings(constrained, { cards: [{ id: 'dimension:source', use: 'random', values: ['植物'] }] }, catalogue, 'fix01-outside-pool'), /原候选池/);
  assert.throws(() => configureFusionSettings(constrained, { cards: [{ id: 'dimension:source', use: 'each', values: ['职业'] }] }, catalogue, 'fix01-excluded-group'), /已被排除/);
  assert.deepEqual(constrained.catalogue!.dynamic.selections['dimension:source'].candidates, candidates);
  const tooManyGroups = configureFusionSettings({ ...defaults(), count: 4 }, { cards: [{ id: 'dimension:source', use: 'distribute', values: ['动物', '植物', '工业', '建筑', '食物'] }] }, catalogue, 'fix01-group-limit');
  assert.throws(() => allocateFusionBatch(tooManyGroups, 1481), /超过|无法/);
  checks.push('UX22原生分组合同：source/concept/mechanism的each/random/distribute真实配置0新增→点击4条，分组必出不变成全部term必出，原硬池/排除与未提多选锁保留');

  const doc = await repository.createFusionWorkspace(actor, { opId: 'ux22-fix01-diagnostic-new' });
  const inline = { title: '硬科幻工业研究', titleEn: 'Industrial research', use: 'each' as const, terms: [{ nameZh: '硬科幻研究', nameEn: 'Hard science research', descriptionZh: '围绕可信工程结构展开研究与探索。', descriptionEn: 'Research and exploration based on credible engineering structures.' }] };
  assert.throws(() => parseFusionConfiguration({ inlineCards: [{ ...inline, cardId: 'dimension:concept' }] }), /inlineCards\[0\]\.cardId.*新建卡片请省略cardId/);
  let inlineCalls = 0;
  const correctedInline = await proposeFusionAgent({ workspace: doc.workspace, message: '准备4套硬科幻伙伴', binding: { contract: 'configure' }, complete: async messages => { inlineCalls++; if (inlineCalls === 2) assert.match(String(messages[messages.length - 1].content), /inlineCards\[0\]\.cardId/); return JSON.stringify({ reply: '配置卡片', commands: [{ type: 'configure', configuration: { inlineCards: [{ ...inline, ...(inlineCalls === 1 ? { cardId: 'dimension:concept' } : {}) }] } }] }); }, read: async () => ({}) });
  assert.equal(correctedInline.iterations, 2);
  const configuredInline = configureFusionSettings(doc.workspace.state.settings, parseFusionConfiguration({ inlineCards: [inline] }), catalogue, 'ux22-fix02-inline');
  const existingInline = configuredInline.cards.find(card => card.title === inline.title)!;
  const editedInline = configureFusionSettings(configuredInline, { inlineCards: [{ ...inline, cardId: existingInline.id, title: '研究外观' }] }, catalogue, 'ux22-fix02-edit');
  assert.equal(editedInline.cards.length, 1); assert.equal(editedInline.cards[0].id, existingInline.id); assert.equal(editedInline.cards[0].title, '研究外观');
  const savedRequirements = doc.workspace.state.settings.requirements;
  assert(savedRequirements.includes('3D')); assert.equal(fusionAgentScene(doc.workspace).settings.requirements, ''); assert.equal(fusionAgentScene(doc.workspace).settings.requirementsEn, '');
  assert.equal(doc.workspace.state.settings.requirements, savedRequirements);
  const enabledScene = fusionAgentScene({ ...doc.workspace, state: { ...doc.workspace.state, settings: { ...doc.workspace.state.settings, requirementsEnabled: true, requirementsEn: 'Preserved original requirement' } } });
  assert.equal(enabledScene.settings.requirements, savedRequirements); assert.equal(enabledScene.settings.requirementsEn, 'Preserved original requirement');
  const batchConfiguration = [{ type: 'configure', configuration: { scope: 'batch', count: 4 } }];
  assert.throws(() => bindFusionAgentCommands(batchConfiguration, doc.workspace, 1482, { contract: 'configure', message: '做4套中文水彩伙伴，本次创作不要道具' }), /scope改为document/);
  assert.throws(() => bindFusionAgentCommands(batchConfiguration, doc.workspace, 1482, { contract: 'configure', message: '不要只用于这一批，以后都按这个来' }), /scope改为document/);
  for (const message of ['剪纸风仅用于这一批', '这一次做4套剪纸风', 'Only for this batch, use paper-cut style']) assert.equal(bindFusionAgentCommands(batchConfiguration, doc.workspace, 1482, { contract: 'configure', message })[0].type, 'configure');
  assert.equal(bindFusionAgentCommands(batchConfiguration, { ...doc.workspace, state: { ...doc.workspace.state, preparation: { formatVersion: 1, batch: { formatVersion: 1, scope: 'batch', overlay: [] } } } }, 1482, { contract: 'configure', message: '再加圆头' })[0].type, 'configure');
  const reserved = await repository.reserveAssistantOperation(actor, doc.workspace.id, { opId: 'ux22-fix01-diagnostic-op', baseVersion: 1, message: '核对非法配置', model: 'isolated-only' });
  let failure: FusionAgentError | undefined;
  try { await proposeFusionAgent({ workspace: doc.workspace, message: '核对非法配置', binding: { contract: 'configure' }, complete: async () => JSON.stringify({ reply: '不应保存的模型reply', commands: [{ type: 'configure', configuration: { cards: [{ id: 'silhouette', use: 'bad-value' }] } }] }), read: async () => ({}) }); }
  catch (error) { assert(error instanceof FusionAgentError); failure = error; }
  assert(failure?.diagnostic); assert.equal(failure.diagnostic.step, 6); assert.match(failure.diagnostic.reason, /each\/random\/distribute/);
  const receipt = await repository.finishAssistantOperation(actor, doc.workspace.id, 'ux22-fix01-diagnostic-op', { intentFingerprint: reserved.intentFingerprint!, status: 'rejected', message: failure.userMessage, diagnostic: failure.diagnostic });
  assert.equal(receipt.status, 'rejected'); assert.equal(receipt.workspace.version, 1); assert.equal(receipt.rowsPage.total, 0);
  const { prisma } = await import('../src/lib/prisma');
  const stored = await prisma.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: 'ux22-fix01-diagnostic-op' } } });
  const result = JSON.parse(stored!.result_json); assert.equal(result.diagnostic.commands[0].configuration.cards[0].use, 'bad-value');
  assert(!JSON.stringify(result.diagnostic).includes('不应保存的模型reply')); assert(!JSON.stringify(receipt).includes('bad-value')); assert(!JSON.stringify(receipt).includes('"diagnostic":'));
  const lookup = await repository.queryWorkspaceOperation(actor, doc.workspace.id, 'ux22-fix01-diagnostic-op'); assert(!JSON.stringify(lookup).includes('bad-value'));
  assert.match(String('error' in lookup && lookup.error), /输入、当前卡片和已有方案都保留/);
  let largeFailure: FusionAgentError | undefined;
  try { await proposeFusionAgent({ workspace: doc.workspace, message: '非法配置', binding: { contract: 'configure' }, complete: async () => JSON.stringify({ reply: '', commands: [{ type: 'configure', configuration: { cards: [{ id: 'x'.repeat(17000), use: 'bad-value' }] } }] }), read: async () => ({}) }); }
  catch (error) { assert(error instanceof FusionAgentError); largeFailure = error; }
  assert.equal(largeFailure?.diagnostic?.commandsOmitted, true); assert.equal(largeFailure?.diagnostic?.commands, undefined);
  checks.push('UX22拒绝私有诊断：六步末次原号保存机器reason/code和有界配置坏值，超限省略；人话与原查询不泄露诊断，文档仍1版0条/0业务写');
  return checks;
}

/** Reproduce the replace-session/append-chat failure with real operation receipts. */
export async function checkFusionUx22GenerationMode(input: { actor: { id: string }; repository: typeof Workspace }) {
  const { actor, repository } = input, catalogue = builtinCatalogue(), checks: string[] = [];
  const state = emptyWorkspaceState(); state.settings.count = 4; state.settings.generationMode = 'replace';
  state.settings.requirementsEnabled = true; state.settings.requirements = '水墨造型'; state.settings.requirementsEn = 'Ink-wash character design';
  const doc = await repository.createFusionWorkspace(actor, { opId: 'ux22-mode-create', state });
  const original = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-mode-ink', baseVersion: 1, commands: [{ type: 'generate', mode: 'replace', seed: 148401 }] });
  const oldRows = structuredClone(original.workspace.rows), base = structuredClone(original.workspace.state.settings);
  const message = '追加4套剪纸风，仅用于这一批，不要替换已有方案';
  let calls = 0;
  const proposal = await proposeFusionAgent({ workspace: original.workspace, message, binding: { contract: 'configure', message }, complete: async messages => {
    calls++; if (calls === 2) assert.match(JSON.parse(String(messages[messages.length - 1].content)).proposalError, /generationMode:"append"/);
    return JSON.stringify({ reply: '已同步本批剪纸卡片，等待点击生成', commands: [{ type: 'configure', configuration: { scope: 'batch', ...(calls === 1 ? {} : { generationMode: 'append' }), requirements: { zh: '剪纸造型', en: 'Paper-cut character design' } } }] });
  }, read: async () => ({}) });
  assert.equal(proposal.iterations, 2);
  const commands = bindFusionAgentCommands(proposal.proposal.commands, original.workspace, 148402, { contract: 'configure', message });
  validateFusionAgentExecution(commands, original.workspace, catalogue, message);
  const staged = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-mode-paper-config', baseVersion: original.workspace.version, commands });
  assert.deepEqual(staged.workspace.rows, oldRows); assert.deepEqual(staged.workspace.state.settings, base);
  const visible = effectiveFusionSettings(staged.workspace.state.settings, staged.workspace.state.preparation?.batch, catalogue);
  assert.equal(visible.generationMode, 'append'); assert.equal(fusionAgentScene({ ...staged.workspace, state: { ...staged.workspace.state, settings: visible } }).settings.generationMode, 'append');
  const copied = newCreationState(staged.workspace.state, 'inherit', catalogue), fresh = newCreationState(staged.workspace.state, 'fresh', catalogue);
  assert.deepEqual(copied.settings, visible); assert.equal(copied.preparation, undefined); assert.deepEqual(copied.messages, []); assert.deepEqual(copied.selectedIds, []); assert.deepEqual(copied.retainedIds, []);
  assert.equal(fresh.settings.generationMode, undefined); assert.equal(fresh.preparation, undefined);
  await assert.rejects(() => repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-mode-stale-click', baseVersion: staged.workspace.version, commands: [{ type: 'generate', mode: 'replace', seed: 148402, preparationHash: preparationFingerprint(staged.workspace.state.preparation!.batch) }] }), /生成方式与当前可见设置不一致/);
  const appended = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-mode-paper-click', baseVersion: staged.workspace.version, commands: [{ type: 'generate', mode: visible.generationMode!, seed: 148402, preparationHash: preparationFingerprint(staged.workspace.state.preparation!.batch) }] });
  assert.equal(appended.rowsPage.total, 8); assert.deepEqual(appended.operation.effects!.removedIds, []); assert.equal(appended.operation.effects!.addedIds.length, 4);
  assert.deepEqual(appended.workspace.rows.filter(row => oldRows.some(old => old.id === row.id)), oldRows); assert.deepEqual(appended.workspace.state.settings, base); assert.equal(appended.workspace.state.preparation, undefined);
  const replay = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-mode-paper-click', baseVersion: staged.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 148402, preparationHash: preparationFingerprint(staged.workspace.state.preparation!.batch) }] });
  assert.equal(replay.rowsPage.total, 8);
  const undone = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-mode-paper-undo', baseVersion: appended.workspace.version, commands: [{ type: 'undo', operationId: 'ux22-mode-paper-click' }] });
  assert.deepEqual(undone.workspace.rows.map(row => ({ ...row, version: oldRows.find(old => old.id === row.id)!.version })), oldRows);
  assert.deepEqual(undone.workspace.state.settings, base); assert.equal(undone.workspace.state.preparation, undefined);
  const retainedId = undone.workspace.rows[0].id;
  const retained = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-mode-retain', baseVersion: undone.workspace.version, commands: [{ type: 'selection', retainedIds: [retainedId] }] });
  const replaced = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-mode-replace-click', baseVersion: retained.workspace.version, commands: [{ type: 'generate', mode: 'replace', seed: 148403 }] });
  assert.equal(replaced.rowsPage.total, 5); assert.equal(replaced.operation.effects!.removedIds.length, 3); assert(replaced.workspace.rows.some(row => row.id === retainedId));
  const restored = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'ux22-mode-replace-undo', baseVersion: replaced.workspace.version, commands: [{ type: 'undo', operationId: 'ux22-mode-replace-click' }] });
  assert.equal(restored.rowsPage.total, 4); assert.equal(restored.workspace.state.settings.generationMode, 'replace'); assert.equal(restored.workspace.state.preparation, undefined);
  checks.push('UX22生成方式同源：replace底设→聊天仅本批追加纠错且0新增→点击真实8条/旧4与base不变；原号不双生、复制取可见值、新建追加、撤销不复活临时方式、替换保留项与撤销');

  const legacyState = emptyWorkspaceState(); legacyState.settings.count = 4;
  const legacyJson = JSON.stringify(legacyState.settings); assert.deepEqual(parseSettings(JSON.parse(legacyJson)), legacyState.settings);
  const legacy = await repository.createFusionWorkspace(actor, { opId: 'ux22-mode-legacy-create', state: legacyState });
  assert.equal((await repository.getWorkspace(actor, legacy.workspace.id)).workspace.state.settings.generationMode, undefined);
  const legacyRows = await repository.executeWorkspaceOperation(actor, legacy.workspace.id, { opId: 'ux22-mode-legacy-click', baseVersion: 1, commands: [{ type: 'generate', mode: 'replace', seed: 148404 }] });
  assert.equal(legacyRows.rowsPage.total, 4); assert.equal(legacyRows.workspace.state.settings.generationMode, undefined);
  const appendConfiguration = { generationMode: 'append' as const };
  const configured = await repository.executeWorkspaceOperation(actor, legacy.workspace.id, { opId: 'ux22-mode-document', baseVersion: legacyRows.workspace.version, commands: [{ type: 'configure', configuration: appendConfiguration }] });
  assert.equal(configured.workspace.state.settings.generationMode, 'append');
  const local = { ...configured.workspace.state, settings: { ...configured.workspace.state.settings, generationMode: 'replace' as const } };
  const manual = await repository.executeWorkspaceOperation(actor, legacy.workspace.id, { opId: 'ux22-mode-manual', baseVersion: configured.workspace.version, commands: stateCommands(configured.workspace.state, local) });
  assert.equal(manual.workspace.state.settings.generationMode, 'replace'); assert.deepEqual(manual.workspace.state.identity, configured.workspace.state.identity);
  await assert.rejects(() => repository.executeWorkspaceOperation(actor, legacy.workspace.id, { opId: 'ux22-mode-stale-setting', baseVersion: configured.workspace.version, commands: [{ type: 'patchSettings', changes: [{ path: ['generationMode'], value: 'append', expected: 'append' }] }] }), /另一个操作|冲突|已更新/);
  assert.equal((await repository.getWorkspace(actor, legacy.workspace.id)).workspace.state.settings.generationMode, 'replace');
  const oldReplay = await repository.executeWorkspaceOperation(actor, legacy.workspace.id, { opId: 'ux22-mode-legacy-click', baseVersion: 1, commands: [{ type: 'generate', mode: 'replace', seed: 148404 }] }); assert.equal(oldReplay.rowsPage.total, 4);
  assert.throws(() => parseFusionConfiguration({ generationMode: 'overwrite' }), /生成方式/);
  await assert.rejects(() => repository.executeWorkspaceOperation(actor, legacy.workspace.id, { opId: 'ux22-mode-row-invalid', baseVersion: manual.workspace.version, commands: [{ type: 'configure', target: { rowId: manual.workspace.rows[0].id, version: manual.workspace.rows[0].version }, configuration: appendConfiguration }] }), /生成方式请清除单条目标/);
  for (const text of ['不要替换已有方案，只追加4套', 'Append 4 proposals', '追加剪纸仅本批']) assert.throws(() => bindFusionAgentCommands([{ type: 'configure', configuration: {} }], manual.workspace, 148405, { contract: 'configure', message: text }), /generationMode:"append"/);
  for (const text of ['替换未保留方案', '不要追加一批，替换现有方案', 'Replace the current batch']) assert.throws(() => bindFusionAgentCommands([{ type: 'configure', configuration: {} }], manual.workspace, 148405, { contract: 'configure', message: text }), /generationMode:"replace"/);
  for (const text of ['不要替换已有方案', '只替换当前卡片的画风', '给临时卡片追加一个词条', '讨论追加4套是否合适', '撤销刚才追加4套']) assert.doesNotThrow(() => bindFusionAgentCommands([{ type: 'configure', configuration: {} }], manual.workspace, 148405, { contract: 'configure', message: text }));
  checks.push('UX22生成方式兼容：旧JSON/只读不回填、旧replace原号可读；document与手动设置共用局部CAS，非法值/单条方式拒绝，明确追加替换与否定/讨论/改卡片反例');

  const cached = appended.workspace.rows, authoritative = replaced.workspace.rows;
  const complete = { ...replaced, workspace: { ...replaced.workspace, rows: authoritative }, rowChanges: undefined, rowsPage: { total: 5, nextCursor: null } };
  assert.deepEqual(mergeWorkspaceRows(cached, complete), authoritative);
  assert.deepEqual(mergeWorkspaceRows(cached, { ...complete, workspace: { ...complete.workspace, rows: [] }, rowsPage: { total: 0, nextCursor: null } }), []);
  const orderReceipt = { ...replaced, workspace: { ...replaced.workspace, rows: authoritative.slice(0, 2) }, rowChanges: { upsert: authoritative, removedIds: [], order: authoritative.map(row => row.id) }, rowsPage: { total: 5, nextCursor: 'more' } };
  assert.deepEqual(mergeWorkspaceRows(cached, orderReceipt), authoritative);
  assert.deepEqual(mergeWorkspaceRows(cached, { ...orderReceipt, rowChanges: { upsert: [], removedIds: [], order: [] } }), []);
  const first = { ...complete, workspace: { ...complete.workspace, rows: authoritative.slice(0, 2) }, rowsPage: { total: 5, nextCursor: 'more' } };
  assert.deepEqual(mergeWorkspaceRows(cached, first, false, false, appended.workspace.version), authoritative.slice(0, 2));
  assert.deepEqual(mergeWorkspaceRows(cached, { ...first, rowChanges: { upsert: [], removedIds: [] } }, false, false, appended.workspace.version), authoritative.slice(0, 2));
  const last = { ...complete, workspace: { ...complete.workspace, rows: authoritative.slice(2) } };
  assert.deepEqual(mergeWorkspaceRows(authoritative.slice(0, 2), last, false, true, replaced.workspace.version), authoritative);
  assert.deepEqual(mergeWorkspaceRows(authoritative, { ...first, workspace: { ...first.workspace, version: replaced.workspace.version - 1 } }, false, false, replaced.workspace.version), authoritative);
  assert.deepEqual(mergeWorkspaceRows(cached, first, true), authoritative.slice(0, 2));
  const localDraft = { ...replaced.workspace.state, idea: '请求开始后仍在编辑的草稿' };
  assert.equal(mergeWorkspaceState(replaced.workspace.state, localDraft, complete.workspace.state).idea, localDraft.idea);
  checks.push('UX22服务器结果集合：真实替换回执/完整GET/空页/完整order清幽灵行，新版本首屏重建缓存、分页累加与旧版本拒绝，文档切换独立且草稿不被结果集合覆盖');
  return checks;
}
