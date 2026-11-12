import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { CORE, allocateFusionBatch, defaults, textFor } from '../src/lib/character-fusion/engine';
import { TRAITS, builtinCatalogue, hydrateCatalogueSettings, parseCatalogue } from '../src/lib/character-fusion/catalogue';
import { applyFusionCommands, emptyWorkspaceState, newCreationState, type FusionCommand } from '../src/lib/character-fusion/actions';
import { BODY_CARDS } from '../src/lib/character-fusion/body-cards';
import { FusionAgentError, bindFusionAgentCommands, fusionAgentCataloguePage, fusionAgentScene, fusionCatalogueGenerationRequested, needsFusionAgentScopeChoice, proposeFusionAgent, readFusionAgentControls, validateFusionAgentExecution } from '../src/lib/character-fusion/agent-adapter.server';
import type * as Workspace from '../src/lib/character-fusion/workspace.server';
import type * as Library from '../src/lib/character-fusion/catalogue-repository';

/** Original-language counterexamples use simulated proposals and the real isolated engine/repository. */
export async function checkFusionUx21(input: { actor: { id: string }; repository: typeof Workspace; library: typeof Library }) {
  const { prepareFusionAgentContinuation, confirmFusionAgentContinuation, previewFusionAgentContinuation, parseFusionAgentContinuation } = await import('../src/lib/character-fusion/agent-continuation.server');
  const { actor, repository } = input, checks: string[] = [], catalogue = builtinCatalogue();
  const singleMessage = '只把这张的画风改成蒸汽朋克，保留它的母体、瘦高长臂、反派定位和其它内容，别改其它方案及下一批要求。';
  for (const message of [singleMessage, '仅调整当前方案，下一批要求保持不变。', '只让这张探索不同方向，不是再来一批。', "Only change this card's style; do not change the next batch."]) assert.equal(needsFusionAgentScopeChoice(message), false, message);
  for (const message of ['再来一批', '再来不同方向', '追加4套', '只改这张，同时追加一批', '不改这张，再来一批', 'another batch please']) assert.equal(needsFusionAgentScopeChoice(message), true, message);
  const s07 = '做4套中文治愈水彩风的小动物非战斗伙伴，用在安静探索游戏里，体型小巧，温柔好奇；不要职业、不要道具和武器，也不要强调战斗机制。只在小动物母体中变化。';
  const document = await repository.createFusionWorkspace(actor, { opId: 'ux21-core-create', state: { ...emptyWorkspaceState(), settings: { ...defaults(), count: 4 } } });
  const sourceOnly = [{ type: 'patchSettings', changes: [{ path: ['bossDimensions'], value: ['source'] }] }, { type: 'generate', mode: 'append' }];
  const invalidPool = [{ type: 'patchSettings', changes: [{ path: ['rules', 'source'], value: document.workspace.state.settings.rules.source.map(tag => ({ ...tag, status: 'exclude' })) }] }, { type: 'generate', mode: 'append' }];
  const fixed = (values: string[]) => ({ enabled: true, locked: true, values, excluded: [], must: [] });
  const valid = [{ type: 'patchSettings', changes: [
    { path: ['requirementsEnabled'], value: true }, { path: ['requirements'], value: '治愈水彩风的小动物非战斗伙伴；安静探索游戏；不要道具和武器，不强调战斗机制。' },
    { path: ['requirementsEn'], value: 'Gentle watercolor animal companions for a quiet exploration game; no combat, props or weapons, with no emphasized combat mechanism.' },
    { path: ['lang'], value: 'zh' }, { path: ['boss', 'source'], value: '动物' }, { path: ['bossLocks', 'source'], value: true },
    ...[['occupation', ['无职业设定']], ['equipmentPolicy', ['无道具']], ['mechanismPrinciple', ['不强调机制']], ['stature', ['瘦小']], ['primaryPersonality', ['温柔']], ['temperament', ['好奇']]].map(([id, values]) => ({ path: ['catalogue', 'traits', id], value: fixed(values as string[]) })),
  ] }, { type: 'generate', mode: 'append' }];
  let rounds = 0;
  const recovered = await proposeFusionAgent({ workspace: document.workspace, message: s07, seed: 2101,
    complete: async messages => { rounds++; if (rounds > 1) assert.match(String(messages[messages.length - 1].content), /proposalError/); return JSON.stringify({ reply: '保原意修正合法设置', commands: rounds === 1 ? sourceOnly : rounds === 2 ? invalidPool : valid }); },
    read: async () => { throw new Error('本例使用现有原生选项，无需查询'); },
    validateCommands: commands => validateFusionAgentExecution(commands, document.workspace, catalogue, s07),
  });
  assert.equal(recovered.iterations, 3); assert.equal((await repository.getWorkspace(actor, document.workspace.id)).rowsPage.total, 0);
  const applied = await repository.executeWorkspaceOperation(actor, document.workspace.id, { opId: 'ux21-core-recovered', baseVersion: 1, commands: bindFusionAgentCommands(recovered.proposal.commands, document.workspace, 2101, { message: s07 }) });
  assert.equal(applied.rowsPage.total, 4); assert(CORE.every(core => applied.workspace.state.settings.bossDimensions.includes(core.id)));
  for (const row of applied.workspace.rows) { assert.equal(row.category.source, '动物'); assert.equal(row.design?.equipment, false); assert.equal(row.design?.traits.occupation?.[0].zh, '无职业设定'); assert.match(textFor(row, applied.workspace.state.settings), /水彩/); }
  const rejectedDocument = await repository.createFusionWorkspace(actor, { opId: 'ux21-rejected-create' });
  const reservation = await repository.reserveAssistantOperation(actor, rejectedDocument.workspace.id, { opId: 'ux21-rejected-turn', baseVersion: 1, message: s07, model: 'engineering-fixed' });
  let rejection: unknown, attempts = 0;
  try { await proposeFusionAgent({ workspace: rejectedDocument.workspace, message: s07, complete: async () => { attempts++; return JSON.stringify({ reply: '非法删除core', commands: sourceOnly }); }, read: async () => ({}), validateCommands: commands => validateFusionAgentExecution(commands, rejectedDocument.workspace, catalogue, s07) }); }
  catch (error) { rejection = error; }
  assert(rejection instanceof FusionAgentError); assert.equal(attempts, 6);
  const rejected = await repository.finishAssistantOperation(actor, rejectedDocument.workspace.id, 'ux21-rejected-turn', { intentFingerprint: reservation.intentFingerprint, status: 'rejected', message: rejection.message });
  assert.equal(rejected.status, 'rejected'); assert('workspace' in rejected); assert.equal(rejected.workspace.version, 1); assert.equal(rejected.rowsPage.total, 0);
  assert.equal((await repository.queryWorkspaceOperation(actor, rejectedDocument.workspace.id, 'ux21-rejected-turn')).status, 'rejected');
  checks.push('UX21原句作用域与非法提案：单卡否定下批不误问、真实追加仍保护、core及纯引擎错误六步内纠错、耐久拒绝零写入');

  for (const message of [s07, '生成4条中文伙伴方案。', '追加4套新的探索伙伴。', '制作八套角色方案。']) assert.equal(fusionCatalogueGenerationRequested(message), true, message);
  for (const message of ['先讨论做4套小伙伴是否合适。', '仅改设置：做4套中文小伙伴的参数。', '把生成数量设置为4套。', '做4套小动物，但先不要生成。', '不要追加4套，只改水彩风。']) assert.equal(fusionCatalogueGenerationRequested(message), false, message);
  const completeDocument = await repository.createFusionWorkspace(actor, { opId: 'ux21-required-generation-create', state: { ...emptyWorkspaceState(), settings: { ...defaults(), count: 4 } } });
  let completeRounds = 0;
  const completedGeneration = await proposeFusionAgent({ workspace: completeDocument.workspace, message: s07, seed: 2110,
    complete: async messages => { completeRounds++; if (completeRounds > 1) assert.match(String(messages[messages.length - 1].content), /补generate/); return JSON.stringify({ reply: '调整创作条件', commands: completeRounds === 1 ? valid.filter(command => command.type !== 'generate') : completeRounds === 2 ? [] : valid }); },
    read: async () => ({}), validateCommands: commands => validateFusionAgentExecution(commands, completeDocument.workspace, catalogue, s07),
  });
  assert.equal(completedGeneration.iterations, 3); assert.equal((await repository.getWorkspace(actor, completeDocument.workspace.id)).workspace.version, 1);
  const completeApplied = await repository.executeWorkspaceOperation(actor, completeDocument.workspace.id, { opId: 'ux21-required-generation-apply', baseVersion: 1, commands: bindFusionAgentCommands(completedGeneration.proposal.commands, completeDocument.workspace, 2110, { message: s07 }) });
  assert.equal(completeApplied.effects?.addedIds.length, 4); assert.equal(completeApplied.effects?.batches.length, 1); assert.equal(completeApplied.rowsPage.total, 4);
  for (const message of ['仅改设置：做4套中文小伙伴的参数。', '先讨论做4套是否合适。', '做4套，但先不要生成。', '先预览要求，确认后生成4套。']) {
    const settingsOnly = await proposeFusionAgent({ workspace: completeApplied.workspace, message, complete: async () => JSON.stringify({ reply: '仅保设置或讨论', commands: [{ type: 'context', summary: '尚未生成' }] }), read: async () => ({}) });
    assert.equal(settingsOnly.iterations, 1); assert(!settingsOnly.proposal.commands.some(command => (command as { type: string }).type === 'generate'));
  }
  const singleTarget = completeApplied.workspace.rows[0];
  const singleAdjustment = await proposeFusionAgent({ workspace: completeApplied.workspace, message: '只修改这张，沿用做4套那轮的水彩风设置。', binding: { target: { rowId: singleTarget.id, version: singleTarget.version } },
    complete: async () => JSON.stringify({ reply: '仅改此条', commands: [{ type: 'patchRow', rowId: singleTarget.id, patch: { requirements: singleTarget.design!.requirements } }] }), read: async () => ({}) });
  assert.equal(singleAdjustment.iterations, 1); assert.equal((singleAdjustment.proposal.commands[0] as { type: string }).type, 'patchRow');
  checks.push('UX21明确生成完整性：做N套/追加仅改设置或空提案必须纠错并实际落四条；讨论、仅设置、否定、单条及待确认不提前生成');

  const s08 = '新增一个我自己的类别“生体发光特征”，加词条“星潮光囊”，英文 Star-tide light sac，含义是肩背上有半透明囊体，内部蓝绿光点像潮汐缓慢流动；这是外观特征，不是装备或职业。先给我可编辑预览，确认后入我的词库，并用这个词条追加4套研究搭档，每套都要真正带这个特征，保留现有方案。';
  assert.equal(fusionCatalogueGenerationRequested(s08), true);
  for (const message of ['新增词条，只保存到词库，不要生成。', '先讨论这个新词是否能生成4套。', '请给新词预览，先别抽卡。']) assert.equal(fusionCatalogueGenerationRequested(message), false, message);
  assert.equal(fusionCatalogueGenerationRequested('先给我预览，确认后使用这个词生成4套。'), true);
  const categoryId = randomUUID(), termId = randomUUID();
  const drafts = [{ kind: 'category', data: { id: categoryId, nameZh: '生体发光特征', nameEn: 'Bioluminescent features', descriptionZh: '生物身体的发光外观', descriptionEn: 'Bioluminescent body features', group: 'extra', multi: true, randomMax: 1, generationKind: 'trait' } },
    { kind: 'term', data: { id: termId, categoryId, nameZh: '星潮光囊', nameEn: 'Star-tide light sac', descriptionZh: '肩背半透明囊体，内部蓝绿光点像潮汐缓慢流动。', descriptionEn: 'Translucent shoulder and back sacs with blue-green points of light flowing slowly like tides. ' } }];
  const pending = [{ type: 'generate', mode: 'append', plan: { formatVersion: 1, scope: 'batch', count: 4, overlay: [{ path: ['catalogue', 'dynamic', 'selections', categoryId], value: fixed([termId]) }] } }];
  let draftRounds = 0;
  const pendingResult = await proposeFusionAgent({ workspace: applied.workspace, message: s08, complete: async () => { draftRounds++; return JSON.stringify({ reply: '先预览，确认后追加', drafts, commands: draftRounds === 1 ? [] : draftRounds === 2 ? [{ type: 'generate', mode: 'append' }] : pending }); }, read: async () => ({}) });
  assert.equal(pendingResult.iterations, 3);
  const sourceId = 'ux21-draft-generation-source';
  const reserved = await repository.reserveAssistantOperation(actor, document.workspace.id, { opId: sourceId, baseVersion: applied.workspace.version, message: s08, model: 'engineering-fixed' });
  const deferred = await prepareFusionAgentContinuation(actor, applied.workspace, { sourceOpId: sourceId, intentFingerprint: reserved.intentFingerprint, drafts: pendingResult.proposal.drafts, commands: bindFusionAgentCommands(pendingResult.proposal.commands, applied.workspace, 2102, { message: s08 }), message: s08, reply: pendingResult.proposal.reply, model: 'engineering-fixed' });
  assert.equal(parseFusionAgentContinuation(deferred.continuation).mode, 'generate'); assert.equal((await repository.getWorkspace(actor, document.workspace.id)).rowsPage.total, 4);
  assert(!(await input.library.readFusionCatalogue(actor)).catalogue.terms.some(term => term.id === termId));
  const preview = await previewFusionAgentContinuation(actor, document.workspace.id, sourceId); assert(preview.preview);
  const confirmed = await confirmFusionAgentContinuation(actor, document.workspace.id, sourceId, { previewVersion: preview.preview.version });
  assert.equal(confirmed.generationStatus, 'committed'); assert('workspace' in confirmed); assert.equal(confirmed.rowsPage?.total, 8);
  assert('rowChanges' in confirmed); assert.equal(confirmed.rowChanges?.upsert.length, 4);
  assert(confirmed.rowChanges!.upsert.every(row => row.catalogueSnapshot?.selections[categoryId]?.includes(termId) && row.catalogueSnapshot.body.zh.includes('肩背半透明囊体')));
  for (const row of confirmed.rowChanges!.upsert) { assert(row.catalogueSnapshot!.body.zh.includes('缓慢流动。')); assert(!row.catalogueSnapshot!.body.zh.includes('缓慢流动。。')); assert(row.catalogueSnapshot!.body.en.includes('like tides.')); assert(!/like tides\.\s*\./.test(row.catalogueSnapshot!.body.en)); }
  const repeated = await confirmFusionAgentContinuation(actor, document.workspace.id, sourceId, {}); assert('rowsPage' in repeated); assert.equal(repeated.rowsPage?.total, 8);
  const saveOnly = await proposeFusionAgent({ workspace: confirmed.workspace, message: '只保存新词到词库，不要生成。', complete: async () => JSON.stringify({ reply: '仅待入库', drafts }), read: async () => ({}) });
  assert.deepEqual(saveOnly.proposal.commands, []); assert.equal(saveOnly.iterations, 1);
  let saveRounds = 0;
  const guardedSave = await proposeFusionAgent({ workspace: confirmed.workspace, message: '只保存新词到词库，不要生成。', complete: async () => { saveRounds++; return JSON.stringify({ reply: '仅待入库', drafts, commands: saveRounds === 1 ? pending : [] }); }, read: async () => ({}) });
  assert.equal(guardedSave.iterations, 2); assert.deepEqual(guardedSave.proposal.commands, []);
  const cancelledSource = 'ux21-draft-cancel-source';
  const cancelReservation = await repository.reserveAssistantOperation(actor, document.workspace.id, { opId: cancelledSource, baseVersion: confirmed.workspace.version, message: '只保存，先预览', model: 'engineering-fixed' });
  const cancelPreview = await prepareFusionAgentContinuation(actor, confirmed.workspace, { sourceOpId: cancelledSource, intentFingerprint: cancelReservation.intentFingerprint, drafts, commands: [], message: '只保存，先预览', reply: '等待预览', model: 'engineering-fixed' });
  const cancelled = await repository.cancelAssistantOperation(actor, document.workspace.id, cancelledSource);
  assert.equal(cancelled.status, 'cancelled'); assert('error' in cancelled); assert.match(cancelled.error || '', /未入库或生成/);
  assert.equal((await input.library.queryCatalogueOperation(actor, parseFusionAgentContinuation(cancelPreview.continuation).catalogueOpId)).status, 'unknown');
  checks.push('UX21确认后生成原意：空计划和未引用新词均有界纠错、确认前零库写、确认后stable ID进每条且中英句末不重补标点、重复确认不双生、仅保存不抽卡');

  const research = '做4套双语硬科幻工业研究搭档，每套是两位独立站立的角色，不要粘成一个身体。方体轮廓、肩胯等宽、适中肌肉，研究探索用途，母体和研究岗位不同。';
  const researchDocument = await repository.createFusionWorkspace(actor, { opId: 'ux21-research-create', state: { ...emptyWorkspaceState(), settings: { ...defaults(), count: 4, lang: 'both' } } });
  const jobs = ['研究员', '修理匠', '医生', '领航员'];
  const jobTerms = catalogue.terms.filter(term => term.categoryId === 'occupation' && jobs.includes(term.nameZh)); assert.equal(jobTerms.length, 4);
  const common = [{ path: ['requirementsEnabled'], value: true }, { path: ['requirements'], value: '硬科幻工业研究搭档，每套两位独立站立、身体不粘连；研究探索用途。' }, { path: ['requirementsEn'], value: 'Hard science fiction industrial research partners; two independently standing figures with separate bodies, for scientific research and exploration.' }, { path: ['catalogue', 'traits', 'activity'], value: fixed(['科研', '探索']) }];
  let researchRounds = 0;
  const researchResult = await proposeFusionAgent({ workspace: researchDocument.workspace, message: research, seed: 2103,
    complete: async () => {
      researchRounds++;
      if (researchRounds === 1) return JSON.stringify({ reply: '查不同合法岗位', reads: [{ kind: 'catalogue', categoryId: 'occupation', limit: 20 }] });
      return JSON.stringify({ reply: '分配不同研究岗位', commands: [{ type: 'patchSettings', changes: [...common, { path: ['catalogue', 'traits', 'occupation'], value: researchRounds === 2 ? fixed(['研究员']) : { enabled: true, locked: false, values: [], excluded: [], must: [] } }] }, { type: 'generate', mode: 'append', ...(researchRounds > 2 ? { plan: { formatVersion: 1, scope: 'batch', onceMust: { occupation: jobTerms.map(term => term.id) } } } : {}) }] });
    }, read: async () => fusionAgentCataloguePage({ catalogue: { ...catalogue, terms: jobTerms }, total: 4, nextCursor: null }, { categoryId: 'occupation' }),
    validateCommands: commands => validateFusionAgentExecution(commands, researchDocument.workspace, catalogue, research),
  });
  assert.equal(researchResult.iterations, 3);
  const researchApplied = await repository.executeWorkspaceOperation(actor, researchDocument.workspace.id, { opId: 'ux21-research-different', baseVersion: 1, commands: bindFusionAgentCommands(researchResult.proposal.commands, researchDocument.workspace, 2103, { message: research }) });
  const actualJobs = researchApplied.workspace.rows.map(row => row.design!.traits.occupation.map(value => value.zh).join('、'));
  assert.equal(new Set(actualJobs).size, 4); assert(researchApplied.workspace.rows.every(row => row.design?.traits.activity.some(value => value.zh === '科研')));
  const definitions = emptyWorkspaceState(); definitions.settings.rules.source.push({ label: '旧自定义定义', en: 'legacy definition', status: 'must' });
  const fresh = newCreationState(definitions, 'fresh'), freshScene = fusionAgentScene({ ...document.workspace, state: fresh });
  assert(fresh.settings.rules.source.find(tag => tag.label === '旧自定义定义')?.definitionOnly);
  assert.equal(freshScene.settings.rules.source.filter(tag => tag.status === 'exclude').length, 1);
  assert.equal(freshScene.settings.rules.source.find(tag => tag.status === 'exclude')?.label, '职业');
  checks.push('UX21实际岗位差异：同锁研究员被拒并以既有onceMust分配四个合法岗位，科研用途保留；未加入旧定义不计基础职业排除');

  const nativeUnjoined = { ...defaults(), count: 4 }, nativeBefore = structuredClone(nativeUnjoined);
  assert.throws(() => allocateFusionBatch(nativeUnjoined, 2120, { onceMust: { occupation: jobTerms.map(term => term.id) } }), error => error instanceof Error && error.message.includes('onceMust["occupation"]') && error.message.includes('["catalogue","traits","occupation"]'));
  assert.deepEqual(nativeUnjoined, nativeBefore);
  const poolIds = jobTerms.map(term => term.id), excludedJob = catalogue.terms.find(term => term.categoryId === 'occupation' && !poolIds.includes(term.id))!;
  const unjoinedState = emptyWorkspaceState(); unjoinedState.settings.count = 4; unjoinedState.settings.lang = 'both';
  unjoinedState.settings.catalogue!.dynamic = { formatVersion: 1, snapshot: catalogue, selections: { occupation: { enabled: false, locked: false, values: [], excluded: [excludedJob.id], must: [], candidates: poolIds } } };
  const hardSelection = structuredClone(unjoinedState.settings.catalogue!.dynamic!.selections.occupation);
  assert.throws(() => allocateFusionBatch(unjoinedState.settings, 2120, { onceMust: { trait: poolIds } }), error => error instanceof Error && error.message.includes('onceMust["trait"]') && error.message.includes('真实categoryId为"occupation"') && error.message.includes('["catalogue","dynamic","selections","occupation"]'));
  assert.equal(allocateFusionBatch(unjoinedState.settings, 2120, { onceMust: { unused_category: [] } }).rows.length, 4);
  assert.deepEqual(unjoinedState.settings.catalogue!.dynamic!.selections.occupation, hardSelection);
  const lockedSettings = structuredClone(unjoinedState.settings); Object.assign(lockedSettings.catalogue!.dynamic!.selections.occupation, { enabled: true, locked: true, values: [poolIds[0]] });
  const lockedBefore = structuredClone(lockedSettings);
  assert.throws(() => allocateFusionBatch(lockedSettings, 2120, { onceMust: { occupation: poolIds } }), /固定组合冲突/); assert.deepEqual(lockedSettings, lockedBefore);
  const onceDocument = await repository.createFusionWorkspace(actor, { opId: 'ux21-once-category-create', state: unjoinedState });
  let onceRounds = 0;
  const onceResult = await proposeFusionAgent({ workspace: onceDocument.workspace, message: research, seed: 2120,
    complete: async messages => {
      onceRounds++;
      if (onceRounds === 1) return JSON.stringify({ reply: '读取岗位真实categoryId', reads: [{ kind: 'catalogue', categoryId: 'occupation', limit: 20 }] });
      if (onceRounds === 3) { const error = String(messages[messages.length - 1].content); assert(error.includes('occupation')); assert(error.includes('enabled:true')); assert(error.includes('dynamic')); }
      if (onceRounds === 4) { const error = String(messages[messages.length - 1].content); assert(error.includes('trait')); assert(error.includes('occupation')); }
      return JSON.stringify({ reply: '仅本批启用岗位并分配', commands: [{ type: 'patchSettings', changes: common }, { type: 'generate', mode: 'append', plan: { formatVersion: 1, scope: 'batch', onceMust: { [onceRounds === 3 ? 'trait' : 'occupation']: poolIds }, ...(onceRounds >= 3 ? { overlay: [{ path: ['catalogue', 'dynamic', 'selections', 'occupation', 'enabled'], value: true }] } : {}) } }] });
    }, read: async () => fusionAgentCataloguePage({ catalogue: { ...catalogue, terms: jobTerms }, total: 4, nextCursor: null }, { categoryId: 'occupation' }),
    validateCommands: commands => validateFusionAgentExecution(commands, onceDocument.workspace, catalogue, research),
  });
  assert.equal(onceResult.iterations, 4); assert.equal((await repository.getWorkspace(actor, onceDocument.workspace.id)).workspace.version, 1);
  const onceApplied = await repository.executeWorkspaceOperation(actor, onceDocument.workspace.id, { opId: 'ux21-once-category-apply', baseVersion: 1, commands: bindFusionAgentCommands(onceResult.proposal.commands, onceDocument.workspace, 2120, { message: research }) });
  assert.equal(onceApplied.rowsPage.total, 4); assert.equal(new Set(onceApplied.workspace.rows.map(row => row.design!.traits.occupation.map(value => value.zh).join('、'))).size, 4);
  assert.deepEqual(onceApplied.workspace.state.settings.catalogue?.dynamic?.selections.occupation, hardSelection);
  const onceFrozen = await repository.getWorkspace(actor, onceDocument.workspace.id, { rowId: onceApplied.workspace.rows[0].id }); assert('rowSettings' in onceFrozen);
  assert.deepEqual(onceFrozen.rowSettings.settings.catalogue?.dynamic?.selections.occupation, { ...hardSelection, enabled: true, locked: true, values: onceApplied.workspace.rows[0].catalogueSnapshot!.selections.occupation });
  let unavailableError: unknown;
  try {
    await proposeFusionAgent({ workspace: onceDocument.workspace, message: research,
      complete: async () => JSON.stringify({ reply: '类别尚未加入', commands: [{ type: 'generate', mode: 'append', plan: { formatVersion: 1, scope: 'batch', onceMust: { occupation: poolIds } } }] }), read: async () => ({}),
      validateCommands: commands => validateFusionAgentExecution(commands, onceDocument.workspace, catalogue, research),
    });
  } catch (error) { unavailableError = error; }
  assert(unavailableError instanceof FusionAgentError); assert.match(unavailableError.message, /onceMust/);
  assert.match(unavailableError.userMessage || '', /职业与身份/); assert(!/onceMust|categoryId|catalogue|\[/.test(unavailableError.userMessage || ''));
  const sourceTerm = catalogue.terms.find(term => term.categoryId === 'dimension:source' && term.data?.group === '动物')!;
  const optionalTerm = catalogue.terms.find(term => term.categoryId === 'dimension:signature')!;
  const bodyCard = structuredClone(BODY_CARDS[0]), bodyTerm = catalogue.terms.find(term => term.categoryId === bodyCard.id && term.nameZh === bodyCard.value)!;
  bodyCard.locked = true; bodyCard.tags.find(tag => tag.label !== bodyCard.value)!.status = 'exclude';
  for (const scenario of [
    { name: 'native-source', wrong: 'source', actual: 'dimension:source', term: sourceTerm, diagnostic: '已加入，只纠正', path: undefined },
    { name: 'native-optional', wrong: 'signature', actual: 'dimension:signature', term: optionalTerm, diagnostic: '["bossDimensions"]', path: ['bossDimensions'] },
    { name: 'native-body', wrong: 'body-card', actual: bodyCard.id, term: bodyTerm, diagnostic: '["cards","0","joined"]', path: ['cards', '0', 'joined'] },
  ]) {
    const state = structuredClone(unjoinedState);
    state.settings.bossLocks.source = true;
    state.settings.catalogue!.sourceFusion = { enabled: true, locked: true, values: [sourceTerm.nameZh], excluded: [], must: [] };
    if (scenario.name === 'native-optional') { state.settings.boss.signature = optionalTerm.data!.group!; state.settings.bossLocks.signature = true; state.settings.catalogue!.details.signature = { locked: true, value: optionalTerm.nameZh }; }
    if (scenario.name === 'native-body') state.settings.cards = [structuredClone(bodyCard), structuredClone(BODY_CARDS[1])];
    const before = structuredClone(state.settings), workspace = { ...onceDocument.workspace, id: `ux21-${scenario.name}`, state, rows: [] };
    const validateDiagnostic = (error: unknown) => error instanceof Error && error.message.includes(scenario.diagnostic) && !error.message.includes(`["catalogue","dynamic","selections","${scenario.actual}"]`);
    assert.throws(() => allocateFusionBatch(state.settings, 2121, { onceMust: { [scenario.wrong]: [scenario.term.id] } }), validateDiagnostic);
    if (scenario.path) assert.throws(() => allocateFusionBatch(state.settings, 2121, { onceMust: { [scenario.actual]: [scenario.term.id] } }), validateDiagnostic);
    let nativeRounds = 0;
    const nativeResult = await proposeFusionAgent({ workspace, message: '生成4套伙伴，本批沿用原锁定和候选限制。', seed: 2121,
      complete: async messages => {
        nativeRounds++;
        if (nativeRounds > 1) { const diagnostic = JSON.parse(String(messages[messages.length - 1].content)).proposalError as string; assert(diagnostic.includes(scenario.diagnostic), `${scenario.name} round ${nativeRounds}: ${diagnostic}`); assert(!diagnostic.includes(`["catalogue","dynamic","selections","${scenario.actual}"]`)); }
        return JSON.stringify({ reply: '按原控制只纠正key并加入本批', commands: [{ type: 'generate', mode: 'append', plan: { formatVersion: 1, scope: 'batch', onceMust: { [nativeRounds === 1 ? scenario.wrong : scenario.actual]: [scenario.term.id] }, ...(scenario.path && nativeRounds >= 3 ? { overlay: [{ path: scenario.path, value: scenario.name === 'native-optional' ? [...before.bossDimensions, 'signature'] : true }] } : {}) } }] });
      }, read: async () => { throw new Error('已读快照包含本例词条'); }, validateCommands: commands => validateFusionAgentExecution(commands, workspace, catalogue),
    });
    assert.equal(nativeResult.iterations, scenario.path ? 3 : 2);
    const nativeApplied = applyFusionCommands(workspace, { opId: `ux21-${scenario.name}-apply`, baseVersion: workspace.version, commands: bindFusionAgentCommands(nativeResult.proposal.commands, workspace, 2121) }, catalogue);
    assert.equal(nativeApplied.rows.length, 4); assert.deepEqual(nativeApplied.state.settings, { ...before, catalogue: hydrateCatalogueSettings(before.catalogue!, catalogue, before) }); assert.deepEqual(state.settings, before);
    assert(nativeApplied.rows.some(row => row.catalogueSnapshot?.selections[scenario.actual]?.includes(scenario.term.id)));
    for (const row of nativeApplied.rows) { assert(row.catalogueSnapshot?.settings); assert.deepEqual(row.catalogueSnapshot.settings.catalogue?.dynamic?.selections, before.catalogue?.dynamic?.selections); }
  }
  assert.throws(() => allocateFusionBatch(unjoinedState.settings, 2121, { onceMust: { [bodyCard.id]: [bodyTerm.id] } }), error => error instanceof Error && error.message.includes('查询controls') && !error.message.includes(`["catalogue","dynamic","selections","${bodyCard.id}"]`));
  checks.push('UX21一次必出类别接线：未加入与错key四步纠正；原生已加入/可选维度/身形卡按真实控制纠错不造dynamic，本批不回写且保硬池排除锁，空项不造约束');

  const indexedState = emptyWorkspaceState(); indexedState.settings.count = 4;
  indexedState.settings.cards = [structuredClone(bodyCard), structuredClone(BODY_CARDS[1])];
  indexedState.settings.rules.source.push({ label: '待加入旧定义', en: 'legacy source definition', status: 'exclude', definitionOnly: true });
  const indexedDocument = await repository.createFusionWorkspace(actor, { opId: 'ux21-indexed-create', state: indexedState });
  const indexedBefore = structuredClone(indexedDocument.workspace.state.settings), indexedScene = fusionAgentScene(indexedDocument.workspace);
  const cardPage = readFusionAgentControls(indexedDocument.workspace, { kind: 'controls', categoryId: bodyCard.id }); assert('controls' in cardPage && cardPage.controls);
  const cardControl = cardPage.controls.items.find(control => control.id === bodyCard.id); assert(cardControl && Array.isArray(cardControl.selectionPath));
  const ruleControl = indexedScene.availableRuleDefinitions.items.find(control => control.label === '待加入旧定义')!;
  const cardPath = [...cardControl.selectionPath, 'joined'], rulePath = ruleControl.selectionPath;
  const indexedCommands = bindFusionAgentCommands([{ type: 'patchSettings', changes: [{ path: cardPath, value: true }, { path: rulePath, value: 'default' }] }], indexedDocument.workspace, 2122);
  assert.equal(indexedCommands[0].type, 'patchSettings'); if (indexedCommands[0].type !== 'patchSettings') throw new Error('缺少局部设置');
  assert.deepEqual(indexedCommands[0].changes?.map(change => change.expected), [false, 'exclude']);
  const indexedSaved = await repository.executeWorkspaceOperation(actor, indexedDocument.workspace.id, { opId: 'ux21-indexed-save', baseVersion: indexedDocument.workspace.version, commands: indexedCommands });
  const indexedExpected = structuredClone(indexedBefore); indexedExpected.cards[0].joined = true;
  const ruleIndex = Number(rulePath[2]); indexedExpected.rules.source[ruleIndex].status = 'default'; delete indexedExpected.rules.source[ruleIndex].definitionOnly;
  assert.deepEqual(indexedSaved.workspace.state.settings, indexedExpected); assert.equal(indexedSaved.rowsPage.total, 0);
  assert.deepEqual((await repository.getWorkspace(actor, indexedDocument.workspace.id)).workspace.state.settings, indexedExpected);
  const indexedUndone = await repository.executeWorkspaceOperation(actor, indexedDocument.workspace.id, { opId: 'ux21-indexed-undo', baseVersion: indexedSaved.workspace.version, commands: [{ type: 'undo', operationId: 'ux21-indexed-save' }] });
  assert.deepEqual(indexedUndone.workspace.state.settings, indexedBefore);
  const pendingCard = bindFusionAgentCommands([{ type: 'patchSettings', changes: [{ path: cardPath, value: true }] }], indexedUndone.workspace, 2122);
  const pendingRule = bindFusionAgentCommands([{ type: 'patchSettings', changes: [{ path: rulePath, value: 'default' }] }], indexedUndone.workspace, 2122);
  const reordered = await repository.executeWorkspaceOperation(actor, indexedDocument.workspace.id, { opId: 'ux21-indexed-old-array', baseVersion: indexedUndone.workspace.version, commands: [{ type: 'patchSettings', patch: { cards: [...indexedBefore.cards].reverse() }, expected: { cards: indexedBefore.cards } }] });
  assert.deepEqual(reordered.workspace.state.settings.cards, [...indexedBefore.cards].reverse());
  for (const [index, commands] of Object.entries([pendingCard, pendingRule])) await assert.rejects(() => repository.executeWorkspaceOperation(actor, indexedDocument.workspace.id, { opId: `ux21-indexed-stale-${index}`, baseVersion: indexedUndone.workspace.version, commands }), error => error instanceof Error && 'code' in error && error.code === 'FUSION_CONFLICT');
  await assert.rejects(() => repository.executeWorkspaceOperation(actor, indexedDocument.workspace.id, { opId: 'ux21-indexed-wrong-expected', baseVersion: reordered.workspace.version, commands: [{ type: 'patchSettings', changes: [{ path: rulePath, value: 'default', expected: 'default' }] }] }), error => error instanceof Error && 'code' in error && error.code === 'FUSION_CONFLICT');
  const currentCardPath = ['cards', '1', 'joined'];
  const indexedAgain = await repository.executeWorkspaceOperation(actor, indexedDocument.workspace.id, { opId: 'ux21-indexed-save-again', baseVersion: reordered.workspace.version, commands: bindFusionAgentCommands([{ type: 'patchSettings', changes: [{ path: currentCardPath, value: true }] }], reordered.workspace, 2122) });
  const otherCard = await repository.executeWorkspaceOperation(actor, indexedDocument.workspace.id, { opId: 'ux21-indexed-other-card', baseVersion: indexedAgain.workspace.version, commands: [{ type: 'patchSettings', changes: [{ path: ['cards', '0', 'joined'], value: true, expected: false }] }] });
  await assert.rejects(() => repository.executeWorkspaceOperation(actor, indexedDocument.workspace.id, { opId: 'ux21-indexed-undo-conflict', baseVersion: otherCard.workspace.version, commands: [{ type: 'undo', operationId: 'ux21-indexed-save-again' }] }), error => error instanceof Error && 'code' in error && error.code === 'FUSION_CONFLICT');
  for (const [index, change] of Object.entries([
    { path: ['cards', '-1', 'joined'], value: true }, { path: ['cards', '01', 'joined'], value: true }, { path: ['cards', '2', 'joined'], value: true },
    { path: ['cards', 'length'], value: 1 }, { path: ['rules', 'source', String(indexedBefore.rules.source.length), 'status'], value: 'default' }, { path: ['cards', '0'], value: null },
  ])) await assert.rejects(() => repository.executeWorkspaceOperation(actor, indexedDocument.workspace.id, { opId: `ux21-indexed-invalid-${index}`, baseVersion: otherCard.workspace.version, commands: [{ type: 'patchSettings', changes: [change] }] }), error => error instanceof Error && 'code' in error && error.code === 'FUSION_INVALID');
  await assert.rejects(() => repository.executeWorkspaceOperation({ id: 'ux21-different-owner' }, indexedDocument.workspace.id, { opId: 'ux21-indexed-other-owner', baseVersion: otherCard.workspace.version, commands: [{ type: 'patchSettings', changes: [{ path: currentCardPath, value: false }] }] }));
  const indexedFinal = await repository.getWorkspace(actor, indexedDocument.workspace.id);
  assert.equal(indexedFinal.workspace.version, otherCard.workspace.version); assert.deepEqual(indexedFinal.workspace.state.settings, otherCard.workspace.state.settings); assert.equal(indexedFinal.rowsPage.total, 0);
  checks.push('UX21数组局部写真实SQLite：公开卡片/旧规则路径保存刷新撤销，保其它项顺序锁与中英；旧全数组可写，过期索引/错误CAS/撤销冲突/非法索引/越权均零写入');

  const traitDocument = await repository.createFusionWorkspace(actor, { opId: 'ux21-trait-feedback-create', state: structuredClone(unjoinedState) });
  const traitBefore = structuredClone(traitDocument.workspace.state.settings);
  const invalidOverlay = [
    { path: ['catalogue', 'traits', 'silhouette', 'values'], value: ['方形'] },
    { path: ['catalogue', 'traits', 'build'], value: { enabled: 'yes', locked: true, values: ['适中'], excluded: [], must: [] } },
    { path: ['catalogue', 'traits', 'shapeHint'], value: fixed(['方体']) },
    { path: ['catalogue', 'traits', 'shoulderHips'], value: fixed(['equal-width']) },
  ];
  const validOverlay = [['silhouette', '方形'], ['build', '适中'], ['shoulderHips', '肩胯等宽']].map(([id, value]) => ({ path: ['catalogue', 'traits', id], value: fixed([value]) }));
  let traitRounds = 0, traitDiagnostic = '';
  const traitMessage = '仅本批生成4套角色，主体轮廓和肌肉量按已选内容，保留旧组合。';
  const traitResult = await proposeFusionAgent({ workspace: traitDocument.workspace, message: traitMessage, seed: 2123,
    complete: async messages => {
      traitRounds++;
      if (traitRounds === 1) return JSON.stringify({ reply: '查合法选项', reads: [{ kind: 'catalogue', categoryId: 'occupation', limit: 2 }] });
      if (traitRounds === 3) {
        traitDiagnostic = JSON.parse(String(messages[messages.length - 1].content)).proposalError;
        const detail = JSON.parse(traitDiagnostic.slice(traitDiagnostic.indexOf('{'), traitDiagnostic.lastIndexOf('}') + 1));
        assert.deepEqual(detail.invalidTraits.map((item: { path: string[] }) => item.path[2]), ['silhouette', 'build', 'shapeHint', 'shoulderHips']);
        assert(detail.invalidTraits[0].fields.some((field: string) => field.includes('enabled'))); assert(detail.invalidTraits[0].fields.some((field: string) => field.includes('locked')));
        assert.deepEqual(detail.invalidTraits[1].options, TRAITS.find(trait => trait.id === 'build')!.options.map(option => option.zh));
        assert(detail.validTraitIds.some((id: string) => id.startsWith('shoulderHips('))); assert.deepEqual(detail.shape, { enabled: true, locked: false, values: [], excluded: [], must: [] });
      }
      return JSON.stringify({ reply: '按具体诊断修复本批属性', commands: [{ type: 'generate', mode: 'append', plan: { formatVersion: 1, scope: 'batch', overlay: traitRounds === 2 ? invalidOverlay : validOverlay } }] });
    },
    read: async () => fusionAgentCataloguePage({ catalogue: { ...catalogue, terms: jobTerms.slice(0, 2).map(term => ({ ...term, descriptionZh: '中'.repeat(2000), descriptionEn: 'e'.repeat(2000) })) }, total: 2, nextCursor: null }, { categoryId: 'occupation' }),
    validateCommands: commands => validateFusionAgentExecution(commands, traitDocument.workspace, catalogue, traitMessage),
  });
  assert.equal(traitResult.iterations, 3); assert(traitDiagnostic.includes('未配置的属性')); assert.equal((await repository.getWorkspace(actor, traitDocument.workspace.id)).workspace.version, 1);
  const traitApplied = await repository.executeWorkspaceOperation(actor, traitDocument.workspace.id, { opId: 'ux21-trait-feedback-apply', baseVersion: 1, commands: bindFusionAgentCommands(traitResult.proposal.commands, traitDocument.workspace, 2123) });
  assert.equal(traitApplied.rowsPage.total, 4); assert.deepEqual(traitApplied.workspace.state.settings.catalogue?.traits, traitBefore.catalogue?.traits); assert.deepEqual(traitApplied.workspace.state.settings.catalogue?.dynamic?.selections, traitBefore.catalogue?.dynamic?.selections);
  for (const row of traitApplied.workspace.rows) for (const change of validOverlay) assert(row.design?.traits[change.path[2]].some(value => value.zh === change.value.values[0]));
  let humanTraitError: unknown;
  try { validateFusionAgentExecution(bindFusionAgentCommands([{ type: 'generate', mode: 'append', plan: { formatVersion: 1, scope: 'batch', overlay: invalidOverlay } }], traitDocument.workspace, 2123), traitDocument.workspace, catalogue); } catch (error) { humanTraitError = error; }
  assert(humanTraitError instanceof FusionAgentError); assert.match(humanTraitError.userMessage || '', /属性设置/); assert(!/catalogue|shapeHint|enabled|locked|\{/.test(humanTraitError.userMessage || ''));
  assert.deepEqual(traitDocument.workspace.state.settings, traitBefore);
  try { parseCatalogue({ details: {}, traits: Object.fromEntries(TRAITS.map(trait => [trait.id, { values: [] }])) }); assert.fail('不完整属性须拒绝'); } catch (error) {
    assert(error instanceof Error && 'proposalError' in error && typeof error.proposalError === 'string'); assert(error.proposalError.length <= 6000); assert(JSON.parse(error.proposalError).remaining > 0);
  }
  checks.push('UX21属性反馈闭环：一次列全缺布尔/缺数组/未知ID/非法中文值与真实选项，长目录后同轮纠正实际四条，本批不回写且人话分离/诊断有界');

  const assistantFile = ts.createSourceFile('route.ts', await readFile('src/app/api/character-fusion/assistant/route.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let plannerComplete: ts.ArrowFunction | undefined;
  const findPlanner = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(assistantFile) === 'proposeFusionAgent' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
    const property = node.arguments[0].properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(assistantFile) === 'complete');
    if (property && ts.isPropertyAssignment(property) && ts.isArrowFunction(property.initializer)) plannerComplete = property.initializer;
  } ts.forEachChild(node, findPlanner); };
  findPlanner(assistantFile); assert(plannerComplete);
  const muskFile = ts.createSourceFile('musk.ts', await readFile('src/lib/integrations/musk.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const muskErrorClass = muskFile.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'MuskApiError'); assert(muskErrorClass);
  const sdkErrorEnvironment = { exports: {} as { MuskApiError?: typeof import('../src/lib/integrations/musk').MuskApiError } };
  runInNewContext(ts.transpileModule(muskErrorClass.getText(muskFile), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, sdkErrorEnvironment);
  assert(sdkErrorEnvironment.exports.MuskApiError); const MuskApiError = sdkErrorEnvironment.exports.MuskApiError;
  type CompletionParams = Parameters<typeof import('../src/lib/integrations/musk').createMuskChatCompletion>[0];
  const plannerHarness = (options: { validationMs?: number; callMs?: number; fail?: boolean; cancelled?: boolean; alwaysRead?: boolean } = {}) => {
    let now = 0, settingsReads = 0, planning = true;
    const controller = new AbortController(), calls: CompletionParams[] = [], logs: Array<Record<string, unknown>> = [];
    const latest = { enabled: true, base_url: 'https://example.invalid', default_model: 'kept-model', api_key: 'PRIVATE_TEST_KEY', allowed_models: ['kept-model'] };
    const environment = { module: { exports: undefined as unknown }, selectedModel: 'kept-model', started: 0, modelStep: 0, opId: 'ux21-planner-budget', request: { signal: controller.signal },
      Date: { now: () => now }, Math, JSON, FusionAgentError, MuskApiError,
      console: { info: (label: string, raw: string) => { assert.equal(label, '[character-fusion-planner-step]'); logs.push(JSON.parse(raw)); } },
      assertPlanning: async () => { controller.signal.throwIfAborted(); if (!planning) throw new FusionAgentError('原回合已取消', 409, 'fusion_agent_cancelled'); },
      getMuskApiSettings: async () => { settingsReads++; now += options.validationMs ?? 1800; if (options.cancelled) planning = false; return latest; },
      isMuskApiReady: (settings: CompletionParams['settings']) => settings === latest,
      resolveMuskChatModels: async (settings: CompletionParams['settings']) => { assert.equal(settings, latest); return ['kept-model']; },
      assertSupplementaryModelEnabled: async (kind: string, model: string) => { assert.equal(kind, 'text'); assert.equal(model, 'kept-model'); },
      createMuskChatCompletion: async (params: CompletionParams) => {
        calls.push(params); assert.equal(settingsReads, calls.length); assert.equal(params.settings, latest); assert.equal(params.model, 'kept-model');
        assert.equal(params.signal, controller.signal); assert.equal(params.jsonMode, false); assert.equal(params.temperature, .4);
        const elapsedMs = options.callMs ?? 35000; assert(elapsedMs <= params.timeoutMs!); now += elapsedMs;
        const diagnostics = { model: 'kept-model', requestChars: 999, requestBytes: 999, timeoutMs: params.timeoutMs!, phase: options.fail ? 'reading_body' as const : 'completed' as const,
          elapsedMs, headersMs: elapsedMs / 2, bodyMs: elapsedMs / 2, httpStatus: options.fail ? 502 : 200, upstreamRequestId: 'PRIVATE_UPSTREAM_ID' };
        if (options.fail) throw new MuskApiError('PRIVATE_UPSTREAM_BODY', 502, 'engineering_failure', diagnostics);
        return { content: JSON.stringify(calls.length < 6 || options.alwaysRead ? { reply: '继续查控制', reads: [{ kind: 'controls', categoryId: 'occupation', limit: 1 }] } : { reply: '保持讨论', commands: [{ type: 'context', summary: '保持讨论' }] }), diagnostics };
      },
    };
    runInNewContext(ts.transpileModule(`module.exports = ${plannerComplete!.getText(assistantFile)}`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, environment);
    return { complete: environment.module.exports as Parameters<typeof proposeFusionAgent>[0]['complete'], controller, calls, logs };
  };
  const budgetWorkspace = { ...document.workspace, state: emptyWorkspaceState(), rows: [] }, budget = plannerHarness();
  const budgetResult = await proposeFusionAgent({ workspace: budgetWorkspace, message: '仅讨论现有组合', complete: budget.complete, read: async read => readFusionAgentControls(budgetWorkspace, read as { kind: 'controls'; categoryId: string; limit: number }) });
  assert.equal(budgetResult.iterations, 6); assert.equal(budgetResult.limitReached, false); assert.equal(budget.calls.length, 6);
  assert.equal(budget.calls[0].timeoutMs, 90000); assert.equal(budget.calls[5].timeoutMs, 54200);
  assert(Number(budget.logs[5].totalElapsedMs) > 90000 && Number(budget.logs[5].totalElapsedMs) < 240000);
  for (const [index, log] of Object.entries(budget.logs)) { assert.equal(log.step, Number(index) + 1); assert.equal(log.phase, 'completed'); assert.equal(log.httpStatus, 200);
    assert.deepEqual(Object.keys(log).sort(), ['opId', 'step', 'phase', 'elapsedMs', 'totalElapsedMs', 'timeoutMs', 'httpStatus', 'headersMs', 'bodyMs'].sort()); }
  const limitedBudget = plannerHarness({ alwaysRead: true });
  const limitedResult = await proposeFusionAgent({ workspace: budgetWorkspace, message: '仅讨论现有组合', complete: limitedBudget.complete, read: async () => ({ controls: [] }) });
  assert.equal(limitedResult.limitReached, true); assert.equal(limitedBudget.calls.length, 6); assert.deepEqual(limitedResult.proposal.commands, []);
  const exhaustedBudget = plannerHarness({ validationMs: 239001 });
  await assert.rejects(() => exhaustedBudget.complete([]), error => error instanceof FusionAgentError && error.code === 'fusion_agent_timeout');
  assert.equal(exhaustedBudget.calls.length, 0); assert.equal(exhaustedBudget.logs[0].phase, 'budget_exhausted'); assert.equal(exhaustedBudget.logs[0].timeoutMs, 999);
  const lastBudget = plannerHarness({ validationMs: 239000, callMs: 500 }); await lastBudget.complete([]); assert.equal(lastBudget.calls[0].timeoutMs, 1000);
  const cancelledBudget = plannerHarness({ cancelled: true });
  await assert.rejects(() => cancelledBudget.complete([]), error => error instanceof FusionAgentError && error.code === 'fusion_agent_cancelled'); assert.equal(cancelledBudget.calls.length, 0);
  const abortedBudget = plannerHarness(); abortedBudget.controller.abort(); await assert.rejects(() => abortedBudget.complete([])); assert.equal(abortedBudget.calls.length, 0);
  const failedBudget = plannerHarness({ fail: true }); await assert.rejects(() => failedBudget.complete([]), error => error instanceof MuskApiError);
  assert.equal(failedBudget.logs[0].phase, 'reading_body'); assert.equal(failedBudget.logs[0].httpStatus, 502); assert.equal(failedBudget.logs[0].elapsedMs, 35000);
  assert(!/PRIVATE_|保持讨论|继续查控制|kept-model/.test(JSON.stringify([...budget.logs, ...failedBudget.logs, ...exhaustedBudget.logs])));
  checks.push('UX21模型整轮时间预算：实际route回调跨90秒完成六步、单次至多90秒/总240秒且最新校验计时，余量不足1秒不调用、取消零调用、SDK阶段耗时HTTP日志仅白名单');

  // Execute the actual layout effect against measured DOM doubles; no browser or visual claim.
  const studioFile = ts.createSourceFile('studio.tsx', await readFile('src/app/tools/character-fusion/studio.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let positioningEffect: ts.ArrowFunction | undefined;
  const findEffect = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(studioFile) === 'useEffect' && node.arguments[0] && ts.isArrowFunction(node.arguments[0]) && node.arguments[0].body.getText(studioFile).includes('--character-fusion-feedback-bottom')) positioningEffect = node.arguments[0]; ts.forEachChild(node, findEffect); };
  findEffect(studioFile); assert(positioningEffect);
  let chatTop = 650, contentWidth = 390, disconnected = false;
  const styles = new Map<string, string>(), observers: Array<() => void> = [], listeners = new Map<string, () => void>();
  const chat = { getBoundingClientRect: () => ({ top: chatTop }) };
  const workbench = { style: { setProperty: () => {} }, parentElement: {}, getBoundingClientRect: () => ({ top: 500, width: contentWidth }), querySelector: () => chat };
  const environment = { module: { exports: undefined as unknown }, workbenchRef: { current: workbench }, active: true, view: 'workspace',
    document: { documentElement: { style: { setProperty: (key: string, value: string) => styles.set(key, value), removeProperty: (key: string) => styles.delete(key) } } },
    window: { innerHeight: 844, addEventListener: (key: string, callback: () => void) => listeners.set(`window:${key}`, callback), removeEventListener: (key: string) => listeners.delete(`window:${key}`), visualViewport: { height: 844, addEventListener: (key: string, callback: () => void) => listeners.set(`viewport:${key}`, callback), removeEventListener: (key: string) => listeners.delete(`viewport:${key}`) } },
    ResizeObserver: class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() { disconnected = true; } },
  };
  runInNewContext(ts.transpileModule(`module.exports = ${positioningEffect.getText(studioFile)}`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, environment);
  assert.equal(typeof environment.module.exports, 'function'); const cleanup = (environment.module.exports as () => () => void)();
  const feedbackBottom = () => Number.parseFloat(styles.get('--character-fusion-feedback-bottom') || '24');
  assert(844 - feedbackBottom() < chatTop); const previousBottom = feedbackBottom();
  chatTop = 590; observers[0](); assert(feedbackBottom() > previousBottom); assert(844 - feedbackBottom() < chatTop);
  contentWidth = 1400; observers[0](); assert.equal(styles.has('--character-fusion-feedback-bottom'), false);
  contentWidth = 390; observers[0](); assert(styles.has('--character-fusion-feedback-bottom')); cleanup();
  assert.equal(styles.has('--character-fusion-feedback-bottom'), false); assert.equal(listeners.size, 0); assert.equal(disconnected, true);
  const widgetFile = ts.createSourceFile('FeedbackWidget.tsx', await readFile('src/components/FeedbackWidget.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let bottomExpression: ts.Expression | undefined;
  const findBottom = (node: ts.Node) => { if (ts.isPropertyAssignment(node) && node.name.getText(widgetFile) === 'bottom' && node.initializer.getText(widgetFile).includes('--character-fusion-feedback-bottom')) bottomExpression = node.initializer; ts.forEachChild(node, findBottom); };
  findBottom(widgetFile); assert(bottomExpression);
  for (const pathname of ['/tools/character-fusion', '/projects', '/tools/character-fusion/other']) assert.equal(runInNewContext(bottomExpression.getText(widgetFile), { pathname }), pathname === '/tools/character-fusion' ? 'var(--character-fusion-feedback-bottom, 24px)' : 24);
  checks.push('UX21窄屏反馈定位工程：实际布局effect随聊天高度避让、宽屏/卸载清理、仅融合路径消费且其它路径保24px默认');
  return checks;
}
