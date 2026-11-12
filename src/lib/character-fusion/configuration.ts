import { CONFIG, CORE, COUNTS, parseSettings, type FusionSettings } from './engine';
import { TRAITS, concreteOptions, emptyCatalogue, emptyTrait, type DynamicTraitState } from './catalogue';
import { BODY_CARDS } from './body-cards';
import { parseCardDraft, cardValues, type FusionCard } from './cards';
import { builtinCategoryId, type FusionCatalogue } from './catalogue-model';
import type { FusionFieldChange, FusionGenerationPlan, FusionPreparation } from './domain';

export type FusionCardUse = 'each' | 'random' | 'distribute' | 'off';
export type FusionCardChoice = { id: string; use: FusionCardUse; values?: string[]; exclude?: string[]; allow?: string[]; replacePool?: boolean };
export type FusionInlineChoice = { cardId?: string; title: string; titleEn: string; multi?: boolean; use?: Exclude<FusionCardUse, 'off'>;
  terms: Array<{ nameZh: string; nameEn: string; descriptionZh: string; descriptionEn: string }> };
export type FusionConfiguration = { scope?: 'document' | 'batch'; cards?: FusionCardChoice[]; inlineCards?: FusionInlineChoice[];
  count?: number; lang?: FusionSettings['lang']; role?: FusionSettings['role']; strict?: boolean; requirements?: { zh?: string; en?: string; enabled?: boolean } };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const strings = (value: unknown) => Array.isArray(value) && value.length <= 160 && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 300) && new Set(value).size === value.length;

/** One input parser for the model and the normal actions endpoint. */
export function parseFusionConfiguration(value: unknown): FusionConfiguration {
  if (!record(value) || value.scope !== undefined && !['document', 'batch'].includes(String(value.scope))
    || value.count !== undefined && !COUNTS.includes(Number(value.count)) || value.count !== undefined && typeof value.count !== 'number'
    || value.lang !== undefined && !['zh', 'en', 'both'].includes(String(value.lang)) || value.strict !== undefined && typeof value.strict !== 'boolean'
    || value.role !== undefined && !['', '主角', '配角', '伙伴', '反派', 'Boss', '路人'].includes(String(value.role))) throw new Error('配置只支持当前数量、语言、定位与作用范围，请按注册格式重新配置。');
  if (value.requirements !== undefined) {
    const requirement = value.requirements;
    if (!record(requirement) || requirement.enabled !== undefined && typeof requirement.enabled !== 'boolean'
      || requirement.zh !== undefined && (typeof requirement.zh !== 'string' || requirement.zh.length > 6000 || typeof requirement.en !== 'string' || requirement.en.length > 10000 || /[\u3400-\u9fff]/.test(requirement.en))
      || requirement.en !== undefined && requirement.zh === undefined) throw new Error('视觉要求须给语义一致的zh/en；仅开关时只给enabled。');
  }
  if (value.cards !== undefined && (!Array.isArray(value.cards) || value.cards.length > 24 || value.cards.some(card => !record(card) || typeof card.id !== 'string' || card.id.length > 180
    || !['each', 'random', 'distribute', 'off'].includes(String(card.use)) || ['values', 'exclude', 'allow'].some(field => card[field] !== undefined && !strings(card[field]))
    || card.replacePool !== undefined && typeof card.replacePool !== 'boolean'))) throw new Error('卡片配置须使用真实id和each/random/distribute/off，选项只能用已读中文或稳定词条ID。');
  if (value.inlineCards !== undefined) {
    if (!Array.isArray(value.inlineCards) || value.inlineCards.length > 8) throw new Error('一次最多新增8张本创作卡片。');
    for (const [index, card] of Object.entries(value.inlineCards)) {
      if (!record(card)) throw new Error(`inlineCards[${index}]须为新词卡片对象。`);
      if (card.cardId !== undefined && (typeof card.cardId !== 'string' || !/^card-[a-zA-Z0-9-]{1,80}$/.test(card.cardId))) throw new Error(`inlineCards[${index}].cardId无效：新建卡片请省略cardId；仅编辑controls中已有的本创作card-*卡片才填真实id。原生dimension:*和属性用cards配置现有选项，不能作inlineCards.cardId。`);
      if (!Array.isArray(card.terms) || !card.terms.length || card.terms.length > 40 || card.use !== undefined && !['each', 'random', 'distribute'].includes(String(card.use))) throw new Error('新词卡片须有中英文名称、1–40个词条及完整中英文含义。');
      parseCardDraft({ title: card.title, titleEn: card.titleEn, multi: card.multi, tags: card.terms.map(term => {
        if (!record(term) || typeof term.descriptionZh !== 'string' || !term.descriptionZh.trim() || typeof term.descriptionEn !== 'string' || !term.descriptionEn.trim()) throw new Error('新词须保留完整中英文含义，不只给名称。');
        return { label: term.nameZh, en: term.nameEn, descriptionZh: term.descriptionZh, descriptionEn: term.descriptionEn };
      }) });
    }
  }
  return clone(value) as FusionConfiguration;
}

/** Stable definition identity for one accepted operation, including idempotent retries. */
function configurationId(key: string) {
  const hex = [1, 2, 3, 4].map(salt => { let hash = 2166136261 ^ salt; for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); return (hash >>> 0).toString(16).padStart(8, '0'); }).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function fusionSettingsChanges(before: FusionSettings, after: FusionSettings): FusionFieldChange[] {
  const walk = (a: unknown, b: unknown, path: string[]): FusionFieldChange[] => {
    if (['catalogue.dynamic.snapshot', 'catalogue.dynamic.formatVersion'].includes(path.join('.')) || JSON.stringify(a) === JSON.stringify(b)) return [];
    if (record(b) && (a === undefined || a === null || record(a))) return Array.from(new Set([...Object.keys(record(a) ? a : {}), ...Object.keys(b)])).flatMap(key => walk(record(a) ? a[key] : undefined, b[key], [...path, key]));
    return [{ path, value: b ?? null, expected: a ?? null }];
  };
  return walk(before, after, []);
}
export function applyFusionSettingChanges(settings: FusionSettings, changes: FusionFieldChange[], catalogue?: FusionCatalogue) {
  const next = clone(settings) as unknown as Record<string, unknown>;
  for (const change of changes) {
    let target = next;
    for (const key of change.path.slice(0, -1)) {
      if (Array.isArray(target) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= target.length)) throw new Error('本次卡片索引已失效，请重新读取。');
      if (!record(target[key]) && !Array.isArray(target[key])) target[key] = {}; target = target[key] as Record<string, unknown>;
    }
    const key = change.path[change.path.length - 1];
    if (Array.isArray(target) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= target.length || change.value === null)) throw new Error('本次卡片索引已失效，请重新读取。');
    if (change.value === null || change.value === undefined) delete target[key]; else target[key] = clone(change.value);
  }
  const selected = (next.catalogue as FusionSettings['catalogue'])?.dynamic;
  if (selected && catalogue) {
    const ids = Object.keys(selected.selections), categories = new Map([...(selected.snapshot?.categories || []).map(category => ({ ...category, enabled: false })), ...catalogue.categories].map(category => [category.id, category]));
    const terms = new Map([...(selected.snapshot?.terms || []).map(term => ({ ...term, enabled: false })), ...catalogue.terms].map(term => [term.id, term]));
    selected.formatVersion = 1; selected.snapshot = { version: catalogue.version, categories: ids.flatMap(id => categories.has(id) ? [categories.get(id)!] : []), terms: Array.from(terms.values()).filter(term => ids.includes(term.categoryId)) };
  }
  return parseSettings(next);
}
export function effectiveFusionSettings(settings: FusionSettings, plan?: FusionGenerationPlan, catalogue?: FusionCatalogue) {
  const effective = applyFusionSettingChanges(settings, plan?.overlay || [], catalogue);
  return plan?.count === undefined ? effective : { ...effective, count: plan.count };
}
export function preparationForManualChange(base: FusionSettings, next: FusionSettings, preparation?: FusionPreparation): FusionPreparation | undefined {
  if (!preparation?.batch) return preparation;
  const overlay = fusionSettingsChanges(base, next);
  const { count: _count, ...plan } = preparation.batch;
  const batch = overlay.length ? { ...plan, overlay } : undefined;
  return batch || preparation.row ? { formatVersion: 1, ...(batch ? { batch } : {}), ...(preparation.row ? { row: preparation.row } : {}) } : undefined;
}

/** Translate visible card intent into the original complete settings, retaining all untouched constraints. */
export function configureFusionSettings(settings: FusionSettings, configuration: FusionConfiguration, catalogue: FusionCatalogue, operationId: string): FusionSettings {
  const next = clone(settings); next.catalogue ||= emptyCatalogue();
  if (configuration.count !== undefined) next.count = configuration.count;
  if (configuration.lang !== undefined) next.lang = configuration.lang;
  if (configuration.role !== undefined) next.role = configuration.role;
  if (configuration.strict !== undefined) next.diversity = configuration.strict ? 'strict' : 'prefer';
  if (configuration.requirements) {
    if (configuration.requirements.zh !== undefined) { next.requirements = configuration.requirements.zh; next.requirementsEn = configuration.requirements.en!; next.requirementsEnabled = configuration.requirements.enabled !== false; }
    else if (configuration.requirements.enabled !== undefined) next.requirementsEnabled = configuration.requirements.enabled;
  }
  for (const [index, draft] of Object.entries(configuration.inlineCards || [])) {
    let card = draft.cardId ? next.cards.find(card => card.id === draft.cardId) : next.cards.find(card => card.title === draft.title && card.catalogueCategoryId);
    if (draft.cardId && !card) throw new Error(`本创作卡片${draft.cardId}不存在，请读取controls后用真实id。`);
    const identity = `${operationId}:inline:${index}:${draft.title}`;
    const categoryId = card?.catalogueCategoryId || configurationId(identity);
    const providedTags = draft.terms.map(term => ({ label: term.nameZh, en: term.nameEn, descriptionZh: term.descriptionZh, descriptionEn: term.descriptionEn,
      termId: card?.tags.find(tag => tag.label === term.nameZh)?.termId || configurationId(`${categoryId}:${term.nameZh}`), status: card?.tags.find(tag => tag.label === term.nameZh)?.status || 'default' as const }));
    const tags = [...(card?.tags.filter(tag => !providedTags.some(provided => provided.label === tag.label)) || []), ...providedTags];
    const parsed = parseCardDraft({ ...draft, multi: draft.multi ?? card?.multi, catalogueCategoryId: categoryId, tags });
    const selectedLabels = Array.from(new Set([...(card?.locked && card.multi ? cardValues(card) : []), ...providedTags.map(tag => tag.label)]));
    card = { ...card, ...parsed, id: card?.id || `card-inline-${categoryId}`, joined: true, value: selectedLabels[0], locked: draft.use !== 'random' && draft.use !== 'distribute', values: parsed.multi ? selectedLabels : undefined };
    if (draft.use === 'distribute') card.tags = card.tags.map(tag => providedTags.some(provided => provided.label === tag.label) ? { ...tag, status: 'must' } : tag);
    if (!card.multi && card.locked && selectedLabels.length > 1) throw new Error(`${card.title}是互斥单选，不能每套同时带多个选项；请用random或distribute。`);
    next.cards = next.cards.some(old => old.id === card!.id) ? next.cards.map(old => old.id === card!.id ? card! : old) : [...next.cards, card];
  }
  for (const choice of configuration.cards || []) {
    const category = catalogue.categories.find(category => category.id === choice.id && category.enabled);
    let card = next.cards.find(card => card.id === choice.id);
    const preset = BODY_CARDS.find(card => card.id === choice.id);
    if (!card && preset) { card = clone(preset); next.cards.push(card); }
    if (card) {
      const labels = (values: string[]) => values.map(value => { const tag = card!.tags.find(tag => tag.label === value || tag.termId === value); if (!tag) throw new Error(`${card!.title}没有选项${value}，请读取controls的真实选项。`); return tag.label; });
      if (choice.use === 'off') { card.joined = false; continue; }
      const selected = choice.values === undefined ? choice.use === 'distribute' ? card.tags.filter(tag => tag.status === 'must').map(tag => tag.label) : card.locked ? cardValues(card) : [] : labels(choice.values);
      const excluded = new Set(card.tags.filter(tag => tag.status === 'exclude').map(tag => tag.label));
      for (const label of labels(choice.exclude || [])) excluded.add(label);
      for (const label of labels(choice.allow || [])) excluded.delete(label);
      if (selected.some(label => excluded.has(label))) throw new Error(`${card.title}所选项已被排除；仅在用户明确恢复时用allow移除对应排除。`);
      if (card.candidates && !choice.replacePool && selected.some(label => !card!.candidates!.includes(label))) throw new Error(`${card.title}所选项超出原候选池；保留原池，用户明确改范围后才用replacePool。`);
      card.joined = true; card.locked = choice.use === 'each';
      if (card.locked) { if (!selected.length) throw new Error(`${card.title}每套都带须选至少一项。`); card.value = selected[0]; if (card.multi) card.values = selected; else if (selected.length > 1) throw new Error(`${card.title}是单选，请用random或distribute。`); }
      if (choice.use === 'distribute' && !selected.length) throw new Error(`${card.title}分别用须给出本批至少各用一次的选项。`);
      if (choice.values !== undefined && choice.use !== 'each') card.candidates = selected;
      card.tags = card.tags.map(tag => ({ ...tag, status: excluded.has(tag.label) ? 'exclude' : choice.use === 'distribute' && selected.includes(tag.label) ? 'must' : 'default' }));
      continue;
    }
    const trait = TRAITS.find(trait => trait.id === choice.id), dimension = CONFIG.find(dimension => builtinCategoryId(dimension.id) === choice.id);
    if (!category) throw new Error(`卡片${choice.id}不存在或不可用，请读controls/catalogue的真实id，不用自造属性；原维度使用dimension:前缀。`);
    if (choice.use === 'off' && dimension && CORE.some(core => core.id === dimension.id)) throw new Error(`${dimension.title}是必要基础维度，请保留；用视觉要求表达非战斗或不强调机制。`);
    const oldDynamic = next.catalogue.dynamic?.selections[choice.id];
    if (choice.use === 'off' && dimension) { next.bossDimensions = next.bossDimensions.filter(id => id !== dimension.id); if (oldDynamic) oldDynamic.enabled = false; continue; }
    const terms = catalogue.terms.filter(term => term.categoryId === category.id && term.enabled);
    const selectedTerms = (values: string[]) => values.map(value => { const term = terms.find(term => term.id === value || term.nameZh === value || term.legacyValue === value); if (!term) throw new Error(`${category.nameZh}选项${value}未核实，请查该类别的真实termId或中文选项。`); return term; });
    // dimensionOptions exposes original groups, independently of concrete catalogue terms.
    if (dimension && choice.values?.length && choice.values.every(value => next.rules[dimension.id].some(tag => tag.label === value))) {
      const id = dimension.id, groups = choice.values;
      if (choice.use === 'each' && groups.length !== 1) throw new Error(`${dimension.title}每套只能使用一个原分组；多个分组请用random或distribute。`);
      const groupAllows = (choice.allow || []).filter(value => next.rules[id].some(tag => tag.label === value));
      const groupExcludes = (choice.exclude || []).filter(value => next.rules[id].some(tag => tag.label === value));
      next.rules[id] = next.rules[id].map(tag => ({ ...tag, status: groupExcludes.includes(tag.label) || tag.status === 'exclude' && !groupAllows.includes(tag.label) ? 'exclude' : choice.use === 'distribute' && groups.includes(tag.label) ? 'must' : 'default' }));
      if (groups.some(group => next.rules[id].some(tag => tag.label === group && tag.status === 'exclude'))) throw new Error(`${dimension.title}所选分组已被排除；仅在用户明确恢复时用allow恢复该分组。`);
      const excluded = Array.from(new Set([...(oldDynamic?.excluded || []), ...selectedTerms((choice.exclude || []).filter(value => !groupExcludes.includes(value))).map(term => term.id)]))
        .filter(termId => !selectedTerms((choice.allow || []).filter(value => !groupAllows.includes(value))).some(term => term.id === termId));
      const detail = next.catalogue.details[id];
      const originalPool = oldDynamic?.candidates && !choice.replacePool ? oldDynamic.candidates.flatMap(termId => terms.filter(term => term.id === termId)) : terms;
      const candidates = originalPool.filter(term => groups.includes(term.data?.group || '')
        && (choice.replacePool || (!oldDynamic?.candidates || oldDynamic.candidates.includes(term.id)) && (!oldDynamic?.locked || oldDynamic.values.includes(term.id))
          && (!next.bossLocks[id] || term.data?.group === next.boss[id]) && (!detail?.locked || (term.legacyValue || term.nameZh) === detail.value)));
      const pool = candidates.filter(term => !excluded.includes(term.id));
      if (groups.some(group => !pool.some(term => term.data?.group === group))) throw new Error(`${dimension.title}所选分组在原候选池、锁定或排除后没有可用词条；请保留原限制，明确改范围后才用replacePool。`);
      next.bossDimensions = Array.from(new Set([...next.bossDimensions, id])); next.bossLocks[id] = choice.use === 'each';
      if (choice.use === 'each') next.boss[id] = groups[0];
      if (choice.replacePool) delete next.catalogue.details[id];
      if (choice.use !== 'each' || oldDynamic || excluded.length) {
        // Keep groups as groups. The allocator chooses this batch's concrete representatives.
        delete next.catalogue.details[id];
        const dynamic = next.catalogue.dynamic;
        const categories = new Map((dynamic?.snapshot.categories || []).map(category => [category.id, category])); categories.set(category.id, category);
        const snapshotTerms = new Map((dynamic?.snapshot.terms || []).map(term => [term.id, term])); for (const term of terms) snapshotTerms.set(term.id, term);
        next.catalogue.dynamic = { formatVersion: 1, selections: { ...dynamic?.selections, [category.id]: { ...(oldDynamic || emptyTrait()), enabled: true, locked: false,
          excluded, candidates: candidates.map(term => term.id), must: [...(oldDynamic?.must || [])] } }, snapshot: { version: catalogue.version, categories: Array.from(categories.values()), terms: Array.from(snapshotTerms.values()) } };
      }
      continue;
    }
    const selected = choice.values === undefined ? undefined : selectedTerms(choice.values);
    if (trait && !oldDynamic && !(choice.use === 'random' && choice.values !== undefined)) {
      const state = next.catalogue.traits[trait.id] || emptyTrait();
      if (choice.use === 'off') { next.catalogue.traits[trait.id] = { ...state, enabled: false }; continue; }
      const labels = selected?.map(term => term.legacyValue || term.nameZh) || (choice.use === 'distribute' ? state.must : state.values);
      const excluded = Array.from(new Set([...state.excluded, ...selectedTerms(choice.exclude || []).map(term => term.legacyValue || term.nameZh)])).filter(label => !selectedTerms(choice.allow || []).some(term => (term.legacyValue || term.nameZh) === label));
      if (labels.some(label => excluded.includes(label))) throw new Error(`${trait.title}选项已被排除，请保留排除或按用户明确要求用allow恢复。`);
      if (choice.use !== 'random' && !labels.length) throw new Error(`${trait.title}须选择合法中文值或termId；读取controls可见完整options。`);
      next.catalogue.traits[trait.id] = { ...state, enabled: true, locked: choice.use === 'each', values: choice.use === 'each' ? labels : [], excluded,
        must: choice.use === 'distribute' ? labels : choice.use === 'each' ? state.must.filter(value => labels.includes(value)) : [] };
      continue;
    }
    if (dimension && !oldDynamic && (!selected?.length || choice.use === 'each' && selected.length === 1) && !choice.exclude?.length && !choice.allow?.length) {
      if (choice.use === 'off') { next.bossDimensions = next.bossDimensions.filter(id => id !== dimension.id); continue; }
      next.bossDimensions = Array.from(new Set([...next.bossDimensions, dimension.id])); next.bossLocks[dimension.id] = choice.use === 'each';
      if (choice.use === 'distribute') throw new Error(`${dimension.title}分别用须给实际词条列表，程序会沿该类别完整配置。`);
      if (selected?.length) {
        const term = selected[0]; next.boss[dimension.id] = term.data!.group!;
        if (concreteOptions(dimension.id, term.data!.group!).some(option => option.zh === term.nameZh)) next.catalogue.details[dimension.id] = { value: term.nameZh, locked: true };
      } else delete next.catalogue.details[dimension.id];
      continue;
    }
    const oldNative = trait ? next.catalogue.traits[trait.id] : undefined;
    const termIds = (labels: string[]) => selectedTerms(labels).map(term => term.id);
    const state: DynamicTraitState = oldDynamic ? clone(oldDynamic) : oldNative ? { ...clone(oldNative), values: termIds(oldNative.values), excluded: termIds(oldNative.excluded), must: termIds(oldNative.must) } : { ...emptyTrait() };
    if (dimension && !oldDynamic) {
      state.candidates = terms.filter(term => next.rules[dimension.id].some(tag => tag.label === term.data?.group && tag.status !== 'exclude' && !tag.definitionOnly) && (!next.bossLocks[dimension.id] || term.data?.group === next.boss[dimension.id]) && (!next.catalogue!.details[dimension.id]?.locked || term.nameZh === next.catalogue!.details[dimension.id]!.value)).map(term => term.id);
    }
    const values = selected?.map(term => term.id) || (choice.use === 'distribute' ? state.must : state.values);
    if (state.candidates && !choice.replacePool && values.some(id => !state.candidates!.includes(id))) throw new Error(`${category.nameZh}所选项超出原候选池或锁定范围；保原限制，用户明确改范围后才用replacePool。`);
    state.excluded = Array.from(new Set([...state.excluded, ...termIds(choice.exclude || [])])).filter(id => !termIds(choice.allow || []).includes(id));
    if (values.some(id => state.excluded.includes(id))) throw new Error(`${category.nameZh}所选项已被排除，请按明确意图用allow恢复，不能静默清除。`);
    state.enabled = choice.use !== 'off'; state.locked = choice.use === 'each';
    if (choice.use !== 'off' && choice.use !== 'random' && !values.length) throw new Error(`${category.nameZh}须给已读目录的选项列表。`);
    if (state.locked) { state.values = values; state.must = state.must.filter(id => values.includes(id)); }
    else if (choice.use === 'distribute') { state.must = values; state.values = []; }
    else if (choice.use === 'random') state.must = [];
    if (selected && choice.use !== 'each' || choice.replacePool) state.candidates = values;
    if (dimension && choice.replacePool) { next.bossLocks[dimension.id] = false; delete next.catalogue.details[dimension.id]; }
    const dynamic = next.catalogue.dynamic;
    const categories = new Map((dynamic?.snapshot.categories || []).map(category => [category.id, category])); categories.set(category.id, category);
    const snapshotTerms = new Map((dynamic?.snapshot.terms || []).map(term => [term.id, term])); for (const term of terms) snapshotTerms.set(term.id, term);
    next.catalogue.dynamic = { formatVersion: 1, selections: { ...dynamic?.selections, [category.id]: state }, snapshot: { version: catalogue.version, categories: Array.from(categories.values()), terms: Array.from(snapshotTerms.values()) } };
    if (dimension && state.enabled) next.bossDimensions = Array.from(new Set([...next.bossDimensions, dimension.id]));
    next.cards = next.cards.map(card => card.catalogueCategoryId === category.id ? { ...card, joined: false } : card);
  }
  return parseSettings(next);
}

export function cardUseLabel(locked: boolean, must: number) { return locked ? '每套都带' : must > 0 ? '这批分别用' : '从中随机'; }
