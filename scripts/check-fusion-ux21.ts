import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { CORE, defaults, textFor } from '../src/lib/character-fusion/engine';
import { builtinCatalogue } from '../src/lib/character-fusion/catalogue';
import { emptyWorkspaceState, newCreationState, type FusionCommand } from '../src/lib/character-fusion/actions';
import { FusionAgentError, bindFusionAgentCommands, fusionAgentCataloguePage, fusionAgentScene, fusionCatalogueGenerationRequested, needsFusionAgentScopeChoice, proposeFusionAgent, validateFusionAgentExecution } from '../src/lib/character-fusion/agent-adapter.server';
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

  const s08 = '新增一个我自己的类别“生体发光特征”，加词条“星潮光囊”，英文 Star-tide light sac，含义是肩背上有半透明囊体，内部蓝绿光点像潮汐缓慢流动；这是外观特征，不是装备或职业。先给我可编辑预览，确认后入我的词库，并用这个词条追加4套研究搭档，每套都要真正带这个特征，保留现有方案。';
  assert.equal(fusionCatalogueGenerationRequested(s08), true);
  for (const message of ['新增词条，只保存到词库，不要生成。', '先讨论这个新词是否能生成4套。', '请给新词预览，先别抽卡。']) assert.equal(fusionCatalogueGenerationRequested(message), false, message);
  assert.equal(fusionCatalogueGenerationRequested('先给我预览，确认后使用这个词生成4套。'), true);
  const categoryId = randomUUID(), termId = randomUUID();
  const drafts = [{ kind: 'category', data: { id: categoryId, nameZh: '生体发光特征', nameEn: 'Bioluminescent features', descriptionZh: '生物身体的发光外观', descriptionEn: 'Bioluminescent body features', group: 'extra', multi: true, randomMax: 1, generationKind: 'trait' } },
    { kind: 'term', data: { id: termId, categoryId, nameZh: '星潮光囊', nameEn: 'Star-tide light sac', descriptionZh: '肩背半透明囊体，内部蓝绿光点像潮汐缓慢流动', descriptionEn: 'Translucent shoulder and back sacs with blue-green points of light flowing slowly like tides' } }];
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
  checks.push('UX21确认后生成原意：空计划和未引用新词均有界纠错、确认前零库写、确认后stable ID进每条、重复确认不双生、仅保存不抽卡');

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
