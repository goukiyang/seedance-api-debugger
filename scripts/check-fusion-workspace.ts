import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { defaults, parseSettings, generateBatch, textFor, csvFor, validateGeneration } from '../src/lib/character-fusion/engine';
import { builtinCatalogue, hydrateCatalogueSettings } from '../src/lib/character-fusion/catalogue';
import type { FusionCatalogue, FusionCategory, FusionTerm } from '../src/lib/character-fusion/catalogue-model';
import { applyFusionCommands, type FusionCommand, type FusionWorkspace } from '../src/lib/character-fusion/actions';
import { bindFusionAgentCommands, fusionAgentCataloguePage, fusionAgentScene, parseFusionAgentProposal, proposeFusionAgent } from '../src/lib/character-fusion/agent-adapter.server';
import { settingsChanges, mergeWorkspaceState } from '../src/app/tools/character-fusion/workspace-client';
import { emptyWorkspaceState } from '../src/lib/character-fusion/actions';

async function main() {
  if (process.env.FUSION_ENGINEERING_ONLY !== '1') throw new Error('请使用 character-fusion-engineering.mjs 隔离入口。');
  const directory = await mkdtemp(path.join(tmpdir(), 'sd2-fusion-engineering-'));
  process.env.DATABASE_URL = `file:${path.join(directory, 'engineering.db')}`;
  const checks: string[] = [];
  let fetchAttempts = 0;
  globalThis.fetch = async () => { fetchAttempts++; throw new Error('工程检查禁止真实网络调用。'); };
  let close: (() => Promise<void>) | undefined;
  try {
    const legacy = defaults();
    assert.deepEqual(parseSettings(JSON.parse(JSON.stringify(legacy))), legacy);
    legacy.catalogue!.traits.exaggeration = { enabled: true, locked: true, values: ['巨掌', '巨脚'], excluded: [], must: [] };
    assert.deepEqual(parseSettings(legacy).catalogue?.traits.exaggeration.values, ['巨掌', '巨脚']);
    const oldRows = generateBatch(legacy, 42);
    assert.equal(oldRows.length, legacy.count);
    assert(textFor(oldRows[0], legacy).includes('巨掌'));
    checks.push('旧格式配方、原多选及固定种子真实提示词引擎');

    const nativeWorkspace: FusionWorkspace = { id: 'engineering-native-scene', name: '原生卡片场景', version: 1,
      archived: false, updatedAt: new Date(0).toISOString(), state: emptyWorkspaceState(), rows: [] };
    const nativeScene = fusionAgentScene(nativeWorkspace);
    assert.equal(nativeScene.settings.customCards.length, 0);
    const sceneCatalogue = builtinCatalogue();
    for (const control of nativeScene.cardControls) if (control.kind === 'dimension' || control.kind === 'trait') assert(sceneCatalogue.categories.some(category => category.id === control.id), `Unknown catalogue reference: ${control.id}`);
    for (const id of ['dimension:source', 'dimension:concept', 'primaryPersonality']) assert(nativeScene.cardControls.some(card => card.id === id && card.joined));
    const exaggerationControl = nativeScene.cardControls.find(card => card.id === 'exaggeration');
    assert(exaggerationControl?.multi && !exaggerationControl.joined);
    assert('options' in exaggerationControl);
    assert.deepEqual(exaggerationControl.options, ['巨头', '巨肩', '巨胸', '巨腹', '巨臂', '巨掌', '巨腿', '巨脚', '无']);
    assert.deepEqual(exaggerationControl.selectionPath, ['catalogue', 'traits', 'exaggeration']);
    const requested = bindFusionAgentCommands([{ type: 'patchSettings', changes: [{ path: ['count'], value: 4 }, { path: ['lang'], value: 'both' }] }, { type: 'generate', mode: 'replace' }], nativeWorkspace, 61);
    const nativeApplied = applyFusionCommands(nativeWorkspace, { opId: 'engineering-native-language', baseVersion: 1, commands: requested }, builtinCatalogue());
    assert.equal(nativeApplied.state.settings.count, 4); assert.equal(nativeApplied.state.settings.lang, 'both'); assert.equal(nativeApplied.rows.length, 4);
    for (const row of nativeApplied.rows) { const prompt = textFor(row, nativeApplied.state.settings); assert.match(prompt, /[a-zA-Z]{4,}/); assert.match(prompt, /[\u4e00-\u9fff]/); }
    const invalidLanguage = bindFusionAgentCommands([{ type: 'patchSettings', changes: [{ path: ['lang'], value: 'zh-en' }] }], nativeWorkspace, 62);
    assert.throws(() => applyFusionCommands(nativeWorkspace, { opId: 'engineering-invalid-language', baseVersion: 1, commands: invalidLanguage }, builtinCatalogue()), /配方设置无效/);
    assert.equal(nativeWorkspace.state.settings.lang, 'zh'); assert.equal(nativeWorkspace.rows.length, 0);
    checks.push('原生已加入卡片场景、属性多选控制路径、4条双语实际生成及错误语言枚举原子拒绝');
    {
    const conceptOptions = nativeScene.dimensionOptions.find(option => option.id === 'concept');
    assert(conceptOptions); assert.equal(conceptOptions.categoryId, 'dimension:concept'); assert(conceptOptions.values.some(value => value === '梦境'));
    const dreamTerm = sceneCatalogue.terms.find(term => term.categoryId === 'dimension:concept' && term.data?.group === '梦境');
    assert(dreamTerm);
    const dreamPage = fusionAgentCataloguePage({ catalogue: { ...sceneCatalogue, terms: [dreamTerm] }, nextCursor: null, total: 1 }, { categoryId: 'dimension:concept' });
    assert.equal(dreamPage.terms[0].group, '梦境');
    const rowWorkspace: FusionWorkspace = { ...nativeWorkspace, state: nativeApplied.state, rows: nativeApplied.rows };
    const target = rowWorkspace.rows[1];
    const localCommands = bindFusionAgentCommands([{ type: 'selection', retainedIds: [rowWorkspace.rows[0].id] }, { type: 'changeRow', rowId: target.id, dimension: 'concept', value: '梦境' }], rowWorkspace, 63);
    const localApplied = applyFusionCommands(rowWorkspace, { opId: 'engineering-theme-group', baseVersion: rowWorkspace.version, commands: localCommands }, sceneCatalogue);
    const changedTarget = localApplied.rows[1];
    assert.equal(changedTarget.category.concept, '梦境'); assert.equal(changedTarget.version, target.version + 1);
    assert.deepEqual(changedTarget.source, target.source); assert.deepEqual(changedTarget.design?.traits, target.design?.traits);
    assert.deepEqual(Object.fromEntries(Object.entries(changedTarget.category).filter(([key]) => key !== 'concept')), Object.fromEntries(Object.entries(target.category).filter(([key]) => key !== 'concept')));
    assert.deepEqual(localApplied.rows.filter(row => row.id !== target.id), rowWorkspace.rows.filter(row => row.id !== target.id));
    assert.deepEqual(localApplied.state.retainedIds, [rowWorkspace.rows[0].id]);
    assert.deepEqual(localApplied.state.settings, rowWorkspace.state.settings);
    checks.push('助手合法维度大类与词条group可见，真实局部换主题保母体属性其它行及全局设置');
    }
    const lookupCatalogue = builtinCatalogue(), projectedCategories: number[] = []; let lookupRounds = 0;
    const lookupResult = await proposeFusionAgent({ workspace: nativeWorkspace, message: '查询巨掌和巨脚',
      complete: async () => ++lookupRounds === 1 ? JSON.stringify({ reply: '先查两个词', reads: [{ kind: 'catalogue', q: '巨掌' }, { kind: 'catalogue', q: '巨脚' }], commands: [], drafts: [] })
        : JSON.stringify({ reply: '已读到两项', reads: [], commands: [], drafts: [] }),
      read: async read => {
        if (read.kind !== 'catalogue') throw new Error('本场景只查询词库');
        const matchingTerms = lookupCatalogue.terms.filter(term => term.nameZh === read.q);
        const page = fusionAgentCataloguePage({ catalogue: { ...lookupCatalogue, terms: matchingTerms }, nextCursor: null, total: matchingTerms.length }, read);
        assert.equal(page.total, 2); assert.equal(page.terms[0].nameZh, read.q);
        assert.deepEqual(page.terms.map(term => term.id), matchingTerms.map(term => term.id));
        assert.deepEqual(page.categories.map(category => category.id).sort(), ['card-body-exaggeration', 'exaggeration']);
        projectedCategories.push(page.categories.length); return page;
      },
    });
    assert.equal(lookupResult.iterations, 2); assert.equal(lookupRounds, 2); assert.deepEqual(projectedCategories, [2, 2]);
    const browse = fusionAgentCataloguePage({ catalogue: { ...lookupCatalogue, terms: lookupCatalogue.terms.slice(0, 20) }, nextCursor: 'engineering-cursor', total: lookupCatalogue.terms.length }, {});
    assert.equal(browse.categories.length, lookupCatalogue.categories.filter(category => category.enabled).length);
    assert.equal(browse.nextCursor, 'engineering-cursor'); assert.equal(browse.total, lookupCatalogue.terms.length); assert.equal(browse.terms.length, 20);
    checks.push('双关键词目录读取不重复全类别、上下文可继续提案，原词条/总数/游标与目录浏览保持');

    {
      let rounds = 0, reads = 0;
      const corrected = await proposeFusionAgent({ workspace: nativeWorkspace, message: '复杂身体与角色要求一起抽卡',
        complete: async messages => {
          rounds++;
          if (rounds === 1) return JSON.stringify({ reply: '先查询全部要求', reads: ['圆润', '矮胖', '壮硕', '大头', '短腿', '胆小', '勇敢', '职业'].map(q => ({ kind: 'catalogue', q, limit: 30 })) });
          if (rounds === 2) {
            assert(messages.some(message => typeof message.content === 'string' && message.content.includes('proposalError')));
            return JSON.stringify({ reply: '拆开查询', reads: [{ kind: 'catalogue', q: '矮胖', limit: 30 }] });
          }
          return JSON.stringify({ reply: '按原要求生成', commands: [{ type: 'generate', mode: 'replace' }] });
        }, read: async () => { reads++; return { terms: [] }; },
      });
      assert.equal(rounds, 3); assert.equal(reads, 1); assert.equal(corrected.iterations, 3);
      assert.deepEqual(corrected.proposal.commands, [{ type: 'generate', mode: 'replace' }]);
      let invalidRounds = 0, invalidReads = 0;
      await assert.rejects(() => proposeFusionAgent({ workspace: nativeWorkspace, message: '保持严格查询上限',
        complete: async () => { invalidRounds++; return JSON.stringify({ reply: '错误分页', reads: [{ kind: 'catalogue', limit: 99 }] }); },
        read: async () => { invalidReads++; return {}; },
      }));
      assert.equal(invalidRounds, 6); assert.equal(invalidReads, 0);
      assert.equal(nativeWorkspace.rows.length, 0);
      checks.push('真实八查询反例可在原六次预算内纠正，非法查询不执行且持续错误有界结束');
    }

    {
      const rowWorkspace: FusionWorkspace = { ...nativeWorkspace, state: nativeApplied.state, rows: nativeApplied.rows };
      const target = rowWorkspace.rows[1], requirements = { zh: '蒸汽朋克画风，黄铜材质。', en: 'Steampunk art direction with brass materials.' };
      const commands = bindFusionAgentCommands([{ type: 'patchRow', rowId: target.id, patch: { requirements } }], rowWorkspace, 65);
      const applied = applyFusionCommands(rowWorkspace, { opId: 'engineering-style-only', baseVersion: rowWorkspace.version, commands }, sceneCatalogue);
      const changed = applied.rows[1];
      assert.equal(changed.version, target.version + 1); assert.deepEqual(changed.design, { ...target.design, requirements });
      assert.deepEqual(changed.source, target.source); assert.deepEqual(changed.category, target.category); assert.deepEqual(changed.personality, target.personality);
      assert.deepEqual(applied.rows.filter(row => row.id !== target.id), rowWorkspace.rows.filter(row => row.id !== target.id));
      assert.deepEqual(applied.state.settings, rowWorkspace.state.settings);
      assert.match(changed.catalogueSnapshot!.body.zh, /蒸汽朋克/); assert.match(changed.catalogueSnapshot!.body.en, /Steampunk/);
      const afterStyle: FusionWorkspace = { ...rowWorkspace, rows: applied.rows };
      const reroll = bindFusionAgentCommands([{ type: 'changeRow', rowId: target.id }], afterStyle, 68);
      const rerolled = applyFusionCommands(afterStyle, { opId: 'engineering-style-reroll', baseVersion: afterStyle.version, commands: reroll }, sceneCatalogue);
      assert.deepEqual(rerolled.rows[1].design?.requirements, requirements);
      assert.deepEqual(rerolled.rows.filter(row => row.id !== target.id), applied.rows.filter(row => row.id !== target.id));
      assert.deepEqual(rerolled.state.settings, applied.state.settings);
      assert.throws(() => bindFusionAgentCommands([{ type: 'patchRow', rowId: target.id, patch: { advanced: true } }], rowWorkspace, 66));
      assert.throws(() => bindFusionAgentCommands([{ type: 'patchRow', rowId: 'outside-document', patch: { requirements } }], rowWorkspace, 67));
      checks.push('助手仅开放单条中英文画风快照修改，保母体身体其它行和全局设置，拒绝越界字段与行');
    }

    const originalCatalogue = builtinCatalogue();
    assert.deepEqual(originalCatalogue, builtinCatalogue());
    const ownerId = 'engineering-owner';
    const category: FusionCategory = { id: randomUUID(), version: 'v1', enabled: true, scope: 'private', ownerId, nameZh: '潮汐学派', nameEn: 'Tidal school', descriptionZh: '潮汐学派', descriptionEn: 'Tidal school', aliases: [], tags: [], sortOrder: 0, group: 'extra', multi: true, randomMax: 2, generationKind: 'trait' };
    const term: FusionTerm = { id: randomUUID(), categoryId: category.id, version: 'v1', enabled: true, scope: 'private', ownerId, nameZh: '海渊学者', nameEn: 'Abyssal scholar', descriptionZh: '身着潮汐纹章的海渊学者', descriptionEn: 'an abyssal scholar wearing a tidal crest', aliases: ['深海学者'], tags: ['学者'], sortOrder: 0 };
    const catalogue: FusionCatalogue = { version: 'engineering-v1', categories: [...originalCatalogue.categories, category], terms: [...originalCatalogue.terms, term] };
    const settings = defaults();
    settings.catalogue!.dynamic = { formatVersion: 1, selections: { [category.id]: { enabled: true, locked: true, values: [term.id], excluded: [], must: [] } }, snapshot: catalogue };
    settings.catalogue = hydrateCatalogueSettings(settings.catalogue!, catalogue);
    assert.equal(validateGeneration(settings), null);
    const rows = generateBatch(parseSettings(settings), 200);
    const frozenText = textFor(rows[0], settings), frozenCsv = csvFor(rows, settings);
    assert(frozenText.includes(term.descriptionZh));
    assert(frozenCsv.includes(category.nameZh));
    assert(frozenCsv.includes(term.nameZh));
    const renamed = structuredClone(catalogue); renamed.categories.find(value => value.id === category.id)!.nameZh = '已改名学派'; renamed.terms.find(value => value.id === term.id)!.nameZh = '已改名词条';
    const nextSettings = { ...settings, catalogue: hydrateCatalogueSettings(settings.catalogue!, renamed) };
    assert.equal(textFor(rows[0], nextSettings), frozenText);
    assert.equal(csvFor(rows, nextSettings), frozenCsv);
    const empty = structuredClone(settings); empty.catalogue!.dynamic!.selections[category.id] = { enabled: true, locked: false, values: [], excluded: [], must: [], candidates: [] };
    assert(validateGeneration(empty));
    const baseState = emptyWorkspaceState(), localState = structuredClone(baseState), remoteState = structuredClone(baseState);
    localState.settings = settings;
    const otherCategory = { ...category, id: randomUUID(), nameZh: '另一个类别' }, otherTerm = { ...term, id: randomUUID(), categoryId: otherCategory.id };
    remoteState.settings.catalogue!.dynamic = { formatVersion: 1, snapshot: { version: 'other', categories: [otherCategory], terms: [otherTerm] }, selections: { [otherCategory.id]: { enabled: true, locked: true, values: [otherTerm.id], excluded: [], must: [] } } };
    const changes = settingsChanges(baseState.settings, localState.settings);
    assert(changes.every(change => !['catalogue.dynamic', 'catalogue.dynamic.snapshot', 'catalogue.dynamic.formatVersion'].includes(change.path.join('.'))));
    const mergedCategories = mergeWorkspaceState(baseState, localState, remoteState);
    assert(mergedCategories.settings.catalogue?.dynamic?.selections[category.id]);
    assert(mergedCategories.settings.catalogue?.dynamic?.selections[otherCategory.id]);
    assert(mergedCategories.settings.catalogue?.dynamic?.snapshot.categories.some(value => value.id === otherCategory.id));
    assert(mergedCategories.settings.catalogue?.dynamic?.snapshot.categories.some(value => value.id === category.id));
    checks.push('稳定ID、普通动态类别真实入正文、空候选、改名后历史正文与CSV冻结');
    for (const kind of ['source', 'concept'] as const) {
      const base = originalCatalogue.terms.find(value => value.categoryId === `dimension:${kind}`)!;
      const special: FusionTerm = { ...structuredClone(base), id: randomUUID(), scope: 'private', ownerId, nameZh: kind === 'source' ? '潮汐水獭' : '潮汐秘仪', nameEn: kind === 'source' ? 'Tidal otter' : 'Tidal ritual', descriptionZh: '独立语义描述', descriptionEn: 'independent semantic description' };
      delete special.legacyValue;
      const specialCatalogue = { ...originalCatalogue, terms: [...originalCatalogue.terms, special] };
      const specialSettings = defaults();
      specialSettings.catalogue!.dynamic = { formatVersion: 1, selections: { [base.categoryId]: { enabled: true, locked: true, values: [special.id], excluded: [], must: [] } }, snapshot: specialCatalogue };
      const specialRow = generateBatch(parseSettings(specialSettings), 88)[0];
      assert.equal(kind === 'source' ? specialRow.source.name : specialRow.concept.name, special.nameZh);
      assert(textFor(specialRow, { ...specialSettings, lang: 'en' }).includes(special.nameEn));
    }
    checks.push('母体与跨界扩展沿原专属处理器进入真实中英结果');

    const prismaCli = path.join(process.cwd(), 'node_modules/prisma/build/index.js');
    const diff = spawnSync(process.execPath, [prismaCli, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { encoding: 'utf8', env: process.env, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(diff.status, 0, diff.stderr);
    const execute = spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--stdin', '--url', process.env.DATABASE_URL], { input: diff.stdout, encoding: 'utf8', env: process.env });
    assert.equal(execute.status, 0, execute.stderr);
    const { prisma } = await import('../src/lib/prisma');
    close = () => prisma.$disconnect();
    // Wait for the existing connection's PRAGMA admission before starting timed transactions.
    await prisma.$connect();
    await prisma.$queryRawUnsafe('SELECT 1');
    const repository = await import('../src/lib/character-fusion/workspace.server');
    const library = await import('../src/lib/character-fusion/catalogue-repository');
    for (const [id, role] of [[ownerId, 'user'], ['engineering-other', 'user'], ['engineering-admin', 'admin']] as const) await prisma.user.create({ data: { id, name: id, username: id, email: `${id}@invalid.test`, password_hash: 'isolated-engineering-only', role } });
    const actor = { id: ownerId }, other = { id: 'engineering-other' }, admin = { id: 'engineering-admin' };
    const created = await repository.createFusionWorkspace(actor, { opId: 'engineering-create', name: '隔离契约文档' });
    assert.equal((await repository.createFusionWorkspace(actor, { opId: 'engineering-create', name: '隔离契约文档' })).workspace.id, created.workspace.id);
    await assert.rejects(() => repository.getWorkspace(other, created.workspace.id));
    const id = created.workspace.id;
    const request = { opId: 'engineering-generate', baseVersion: 1, commands: [{ type: 'generate', mode: 'append', seed: 123 } as FusionCommand] };
    const generated = await repository.executeWorkspaceOperation(actor, id, request);
    const replay = await repository.executeWorkspaceOperation(actor, id, request);
    assert.equal(replay.workspace.version, generated.workspace.version);
    assert.equal(replay.rowsPage.total, legacy.count);
    await assert.rejects(() => repository.executeWorkspaceOperation(actor, id, { ...request, commands: [{ type: 'generate', mode: 'append', seed: 456 }] }));
    assert.equal((await repository.queryWorkspaceOperation(actor, id, request.opId)).status, 'committed');
    const picked = generated.workspace.rows[0].id;
    const selection = await repository.executeWorkspaceOperation(actor, id, { opId: 'engineering-select', baseVersion: generated.workspace.version, commands: [{ type: 'selection', selectedIds: [picked], retainedIds: [picked] }] });
    const context = await repository.executeWorkspaceOperation(actor, id, { opId: 'engineering-context', baseVersion: selection.workspace.version, commands: [{ type: 'context', idea: '原始想法保留', summary: '当前摘要' }] });
    assert.deepEqual(context.workspace.state.retainedIds, [picked]);
    assert.deepEqual(context.workspace.state.selectedIds, [picked]);
    const patch = await repository.executeWorkspaceOperation(actor, id, { opId: 'engineering-patch', baseVersion: context.workspace.version, commands: [{ type: 'patchSettings', changes: [{ path: ['lang'], value: 'en', expected: 'zh' }] }] });
    const merged = await repository.executeWorkspaceOperation(actor, id, { opId: 'engineering-merge', baseVersion: context.workspace.version, commands: [{ type: 'context', summary: '合并后的摘要', expected: { summary: '当前摘要' } }] });
    assert.equal(merged.workspace.state.settings.lang, 'en');
    await assert.rejects(() => repository.executeWorkspaceOperation(actor, id, { opId: 'engineering-conflict', baseVersion: context.workspace.version, commands: [{ type: 'patchSettings', changes: [{ path: ['lang'], value: 'both', expected: 'zh' }] }] }));
    assert.equal((await repository.getWorkspace(actor, id)).workspace.version, merged.workspace.version);
    const undone = await repository.executeWorkspaceOperation(actor, id, { opId: 'engineering-undo', baseVersion: merged.workspace.version, commands: [{ type: 'undo', operationId: 'engineering-merge' }] });
    assert.equal(undone.workspace.state.summary, '当前摘要');
    assert.equal(undone.workspace.state.settings.lang, patch.workspace.state.settings.lang);
    checks.push('真实临时SQLite：本人归属、原号原子回执/幂等、不同载荷拒绝、字段CAS合并、冲突与局部撤销');
    {
      const originalDocument = (await repository.getWorkspace(actor, id)).workspace;
      const freshState = { ...emptyWorkspaceState(), settings: { ...structuredClone(originalDocument.state.settings), count: 4, lang: 'both' as const } };
      freshState.settings.catalogue!.traits.exaggeration = { enabled: true, locked: true, values: ['巨掌', '巨脚'], excluded: [], must: [] };
      const createInput = { opId: 'engineering-inherit-new-document', name: '新的角色融合创作', state: freshState };
      const freshDocument = await repository.createFusionWorkspace(actor, createInput);
      assert.equal(freshDocument.rowsPage.total, 0); assert.deepEqual(freshDocument.workspace.state, freshState);
      const freshResult = await repository.executeWorkspaceOperation(actor, freshDocument.workspace.id, { opId: 'engineering-fresh-document-generate', baseVersion: 1, commands: [{ type: 'generate', mode: 'replace', seed: 523 }] });
      assert.equal(freshResult.rowsPage.total, 4);
      for (const row of freshResult.workspace.rows) { const body = textFor(row, freshResult.workspace.state.settings); assert(body.includes('巨掌') && body.includes('巨脚') && body.includes('oversized palms') && body.includes('oversized feet')); }
      assert.deepEqual((await repository.getWorkspace(actor, id)).workspace, originalDocument);
      assert.deepEqual((await repository.getWorkspace(actor, freshDocument.workspace.id)).workspace, freshResult.workspace);
      assert.equal((await repository.createFusionWorkspace(actor, createInput)).workspace.id, freshDocument.workspace.id);
      await assert.rejects(() => repository.createFusionWorkspace(actor, { ...createInput, state: { ...freshState, settings: { ...freshState.settings, count: 8 } } }));
      checks.push('新文档继承卡片数量语言但无旧结果/对话，真实生成和双向继续隔离，创建原号固定载荷');
    }


    const entries = [{ kind: 'category', data: category }, { kind: 'term', data: term }];
    const preview = await library.manageFusionCatalogue(actor, { action: 'preview', scope: 'private', entries });
    assert(preview.preview?.canImport);
    await assert.rejects(() => library.manageFusionCatalogue(actor, { action: 'preview', scope: 'shared', entries }));
    const imported = await library.manageFusionCatalogue(actor, { action: 'import', scope: 'private', opId: 'engineering-import', previewVersion: preview.preview!.version, entries: preview.preview!.entries.map(entry => entry.entry) });
    assert(imported.changedIds?.includes(term.id));
    assert(!(await library.readFusionCatalogue(other)).catalogue.terms.some(value => value.id === term.id));
    const fresh = (await repository.getWorkspace(actor, id)).workspace;
    const dynamic = await repository.executeWorkspaceOperation(actor, id, { opId: 'engineering-dynamic', baseVersion: fresh.version, commands: [{ type: 'patchSettings', changes: [{ path: ['catalogue', 'dynamic', 'selections', category.id], value: { enabled: true, locked: true, values: [term.id], excluded: [], must: [] }, expected: null }] }, { type: 'generate', mode: 'append', seed: 555 }] });
    assert(dynamic.rowChanges.upsert.some(row => textFor(row, { ...dynamic.workspace.state.settings, lang: 'zh' }).includes(term.descriptionZh)));
    const growthTerms = Array.from({ length: 1000 }, (_, index): FusionTerm => ({ ...term, id: randomUUID(), version: `growth-${index}`, nameZh: `目录增长样本${index}`, nameEn: `Growth fixture ${index}` }));
    await prisma.characterFusionTerm.createMany({ data: growthTerms.map(value => ({ stable_id: value.id, category_id: category.id, scope_key: `user:${ownerId}`, scope: 'private', owner_id: ownerId, version: value.version, enabled: true, definition_json: JSON.stringify(value) })) });
    const growth = await repository.executeWorkspaceOperation(actor, id, { opId: 'engineering-growth', baseVersion: dynamic.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 556 }] });
    const growthOperation = await prisma.characterFusionOperation.findUniqueOrThrow({ where: { owner_id_op_id: { owner_id: ownerId, op_id: 'engineering-growth' } } });
    const growthReceipt = JSON.parse(growthOperation.result_json) as { configurations: Record<string, unknown> };
    assert.equal(Object.keys(growthReceipt.configurations).length, 1);
    assert(growth.rowChanges.upsert.every(row => !row.catalogueSnapshot?.settings && row.catalogueSnapshot?.settingsRef));
    assert(!growthOperation.undo_json?.includes('"settings":'));
    const storedGrowthRows = await prisma.characterFusionResult.findMany({ where: { workspace_id: id, row_id: { in: growth.rowChanges.upsert.map(row => row.id) } } });
    assert(storedGrowthRows.every(row => !row.row_json.includes('"settings":')));
    const resolvedRow = await repository.getWorkspace(actor, id, { rowId: growth.rowChanges.upsert[0].id });
    assert('rowSettings' in resolvedRow && resolvedRow.rowSettings.settings.catalogue?.dynamic?.snapshot.terms.some(value => value.id === growthTerms[999].id));
    checks.push('1000词同类×16条：配置在原操作仅存一份，结果/撤销无整池副本，单条原配置可解析');
    const currentTerm = (await library.readFusionCatalogue(actor)).catalogue.terms.find(value => value.id === term.id)!;
    await assert.rejects(() => library.manageFusionCatalogue(other, { action: 'disable', kind: 'term', id: term.id, scope: 'private', expectedVersion: currentTerm.version, opId: 'engineering-forbidden' }));
    await library.manageFusionCatalogue(actor, { action: 'disable', kind: 'term', id: term.id, scope: 'private', expectedVersion: currentTerm.version, opId: 'engineering-disable' });
    const afterDisable = (await repository.getWorkspace(actor, id)).workspace;
    await assert.rejects(() => repository.executeWorkspaceOperation(actor, id, { opId: 'engineering-disabled-generation', baseVersion: afterDisable.version, commands: [{ type: 'generate', mode: 'append', seed: 666 }] }));
    assert.equal((await repository.getWorkspace(actor, id)).workspace.version, afterDisable.version);
    const target = growth.rowChanges.upsert[0];
    const revised = await repository.executeWorkspaceOperation(actor, id, { opId: 'engineering-local-axis', baseVersion: afterDisable.version, commands: [{ type: 'reviseRow', rowId: target.id, axis: category.id, expectedVersion: target.version, seed: 667 }] });
    const revisedRow = revised.rowChanges.upsert.find(value => value.id === target.id)!;
    assert(!revisedRow.catalogueSnapshot?.selections[category.id].includes(term.id));
    assert.deepEqual(revisedRow.category, target.category);
    assert.deepEqual(revisedRow.source, target.source);
    assert.deepEqual(revisedRow.concept, target.concept);
    assert.deepEqual(revisedRow.design?.requirements, target.design?.requirements);
    const sharedCategory = { ...category, id: randomUUID(), nameZh: '共享学派', nameEn: 'Shared school', scope: 'shared', ownerId: admin.id };
    await library.manageFusionCatalogue(admin, { action: 'upsert', scope: 'shared', opId: 'engineering-shared', entry: { kind: 'category', data: sharedCategory } });
    assert((await library.readFusionCatalogue(other)).catalogue.categories.some(value => value.id === sharedCategory.id));
    checks.push('目录预览/原子入库、私人隔离、管理员共享、稳定引用真实生成与停用拒绝新抽卡');

    const doc = await repository.createFusionWorkspace(actor, { opId: 'engineering-agent-doc', name: '助手契约' });
    const intent = { opId: 'engineering-agent', baseVersion: doc.workspace.version, message: '保留原想法后抽卡', model: 'fixture-model' };
    const reservation = await repository.reserveAssistantOperation(actor, doc.workspace.id, intent);
    assert(reservation.claimed);
    assert.equal((await repository.reserveAssistantOperation(actor, doc.workspace.id, intent)).claimed, false);
    const cancelled = await repository.cancelAssistantOperation(actor, doc.workspace.id, intent.opId);
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(() => repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: intent.opId, baseVersion: doc.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 800 }] }, { assistantFingerprint: reservation.intentFingerprint }));
    assert.equal((await repository.getWorkspace(actor, doc.workspace.id)).rowsPage.total, 0);
    assert.equal((await repository.cancelAssistantOperation(actor, doc.workspace.id, 'engineering-cancel-before-reserve')).status, 'cancelled');
    const late = await repository.reserveAssistantOperation(actor, doc.workspace.id, { ...intent, opId: 'engineering-cancel-before-reserve' });
    assert.equal(late.claimed, false);
    assert.equal(late.status, 'cancelled');
    const second = await repository.reserveAssistantOperation(actor, doc.workspace.id, { ...intent, opId: 'engineering-agent-commit' });
    const applied = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'engineering-agent-commit', baseVersion: doc.workspace.version, commands: [{ type: 'generate', mode: 'append', seed: 900 }] }, { assistantFingerprint: second.intentFingerprint });
    assert.equal((await repository.cancelAssistantOperation(actor, doc.workspace.id, 'engineering-agent-commit')).status, 'committed');
    assert.equal(applied.rowsPage.total, 16);
    const editRead = await repository.getWorkspace(actor, doc.workspace.id, { rowId: applied.workspace.rows[0].id });
    assert('rowSettings' in editRead);
    const editDraft = editRead.rowSettings;
    assert.equal(editDraft.rowId, applied.workspace.rows[0].id);
    assert.equal(editDraft.version, applied.workspace.rows[0].version);
    assert.equal(editDraft.body.zh, textFor(applied.workspace.rows[0], { ...applied.workspace.state.settings, lang: 'zh' }));
    const changedRow = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'engineering-concurrent-row', baseVersion: applied.workspace.version, commands: [{ type: 'patchRow', rowId: applied.workspace.rows[0].id, expectedVersion: applied.workspace.rows[0].version, patch: { advanced: true } }] });
    assert(changedRow.rowChanges.upsert[0].version > editDraft.version);
    const beforeStaleEdit = await repository.getWorkspace(actor, doc.workspace.id);
    await assert.rejects(() => repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'engineering-stale-row-edit', baseVersion: changedRow.workspace.version, commands: [{ type: 'reviseRow', rowId: editDraft.rowId, settings: { ...editDraft.settings, role: '反派' }, expectedVersion: editDraft.version, seed: 902 }] }), (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === 409));
    assert.deepEqual((await repository.getWorkspace(actor, doc.workspace.id)).workspace, beforeStaleEdit.workspace);
    assert.equal((await repository.queryWorkspaceOperation(actor, doc.workspace.id, 'engineering-stale-row-edit')).status, 'unknown');
    const reviewedEdit = await repository.getWorkspace(actor, doc.workspace.id, { rowId: editDraft.rowId });
    assert('rowSettings' in reviewedEdit);
    assert.equal(reviewedEdit.rowSettings.version, changedRow.rowChanges.upsert[0].version);
    assert.equal(editDraft.version, applied.workspace.rows[0].version, 'Reading a comparison does not promote the old draft version');
    const appliedEdit = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'engineering-reviewed-row-edit', baseVersion: changedRow.workspace.version, commands: [{ type: 'reviseRow', rowId: editDraft.rowId, settings: { ...editDraft.settings, role: '反派' }, expectedVersion: reviewedEdit.rowSettings.version, seed: 903 }] });
    assert.equal(appliedEdit.rowChanges.upsert[0].role, '反派');
    checks.push('单条编辑绑定读取版本：并发后旧草稿409不改结果，明确核对新版本后才可应用');
    const staleGenerate = bindFusionAgentCommands([{ type: 'generate', mode: 'replace' }], applied.workspace, 901);
    await assert.rejects(() => repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'engineering-stale-replace', baseVersion: applied.workspace.version, commands: staleGenerate }));
    const recipeId = randomUUID();
    const recipeSave = await repository.executeWorkspaceOperation(actor, doc.workspace.id, { opId: 'engineering-agent-recipe', baseVersion: appliedEdit.workspace.version, commands: [{ type: 'saveRecipe', id: recipeId, name: '助手保存的配方' }] });
    assert.equal(recipeSave.operation.reversible, false);
    assert(await prisma.userPreference.findUnique({ where: { user_id_key: { user_id: ownerId, key: `character_fusion_recipe_v1:${recipeId}` } } }));
    checks.push('持久planning单次领取、显式取消与迟到apply互斥、先取消后迟到reserve、已提交取消回原结果');

    const pagesDoc = await repository.createFusionWorkspace(actor, { opId: 'engineering-page-doc', name: '分页导出契约' });
    const legacyPageRows = Array.from({ length: 201 }, (_, index) => {
      const row = structuredClone(oldRows[index % oldRows.length]);
      delete row.catalogueSnapshot; delete row.design; delete row.cards;
      return { ...row, id: `engineering-history-${index}`, name: `历史结果${index}` };
    });
    const pageImport = await repository.executeWorkspaceOperation(actor, pagesDoc.workspace.id, { opId: 'engineering-page-import', baseVersion: 1, commands: [{ type: 'importDraft', state: emptyWorkspaceState(), rows: legacyPageRows }] });
    const pageIds = pageImport.workspace.rows.map(row => row.id); let cursor = pageImport.rowsPage.nextCursor;
    while (cursor) { const page = await repository.getWorkspace(actor, pagesDoc.workspace.id, { cursor }); assert.equal(page.workspace.version, pageImport.workspace.version); pageIds.push(...page.workspace.rows.map(row => row.id)); cursor = page.rowsPage.nextCursor; }
    assert.equal(pageIds.length, 201); assert.equal(new Set(pageIds).size, 201);
    await repository.executeWorkspaceOperation(actor, pagesDoc.workspace.id, { opId: 'engineering-page-change', baseVersion: pageImport.workspace.version, commands: [{ type: 'context', summary: '读取期间发生真实更新' }] });
    await assert.rejects(() => repository.getWorkspace(actor, pagesDoc.workspace.id, { cursor: pageImport.rowsPage.nextCursor! }));
    checks.push('201条历史分页完整读取、同文档版本绑定、更新后的旧游标明确拒绝');

    assert.throws(() => parseFusionAgentProposal('{"reply":"执行脚本","commands":[{"type":"shell"}]}') && bindFusionAgentCommands([{ type: 'shell' }], applied.workspace, 1));
    let calls = 0;
    const bounded = await proposeFusionAgent({ workspace: doc.workspace, message: '仅查询候选', complete: async () => { calls++; return JSON.stringify({ reply: '继续查询', reads: [{ kind: 'catalogue', limit: 1 }] }); }, read: async () => ({ terms: [], nextCursor: 'more', total: 100 }) });
    assert.equal(calls, 6);
    assert(bounded.limitReached);
    assert.deepEqual(bounded.proposal.commands, []);
    assert.equal(fetchAttempts, 0);
    checks.push('固定模型提案工程模拟：注册动作白名单、六次有界读取、不执行脚本与真实网络');

    const ddl = await readFile('prisma/migrations/20261111120000_character_fusion_workspace/migration.sql', 'utf8');
    assert.equal((ddl.match(/CREATE TABLE/g) || []).length, 5);
    assert(!/(?:^|;)\s*(?:DROP|ALTER|DELETE|UPDATE)\b/im.test(ddl));
    checks.push('五表迁移仅新增，无旧数据改写语句');
    console.log(JSON.stringify({ passed: true, checks, isolation: { temporarySqlite: true, realFetches: fetchAttempts, realGeneration: 0, browserRuns: 0, productionWrites: 0 } }));
  } finally { await close?.(); await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
