import { englishDetail } from './english';
import { parseCardDraft, cardValues, type FusionCard } from './cards';
import { TRAITS, parseCatalogue, concreteOptions, builtinCatalogue, dynamicPool, dynamicPolicy, validateDynamicGeneration, type CatalogueSettings } from './catalogue';
import { builtinCategoryId, builtinTermId, type FusionCategory, type FusionTerm } from './catalogue-model';
import { chooseConcrete, decorateRow, type Design } from './design';
import { BODY_HEAD_RATIO_ID } from './body-cards';
import { choicesConflict, drawChoices, type SelectionPolicy } from './selection';
import type { FusionAllocation } from './domain';
export type { FusionAllocation } from './domain';
import { CONFIG, DEFAULT_REQUIREMENTS, SOURCES, CONCEPTS, MECHANISMS, PERSONALITIES, LEGACY_TAGS, DETAIL_ALTS, EN_LABEL, SOURCE_EN, CONCEPT_EN, PROP_EN } from './vocabulary';

export { CONFIG, DEFAULT_REQUIREMENTS };
export type Dimension = typeof CONFIG[number]['id'];
export type Tag = { label: string; en?: string; status: 'default' | 'must' | 'exclude'; definitionOnly?: true };
export type Categories = Record<Dimension, string>;
export type FusionSettings = {
  rules: Record<Dimension, Tag[]>; requirements: string; count: number; lang: 'zh' | 'en' | 'both';
  boss: Categories; bossLocks: Record<Dimension, boolean>; bossDimensions: Dimension[];
  requirementsEnabled: boolean; requirementsEn: string; cards: FusionCard[]; role: string; catalogue?: CatalogueSettings; diversity?: 'prefer' | 'strict'; generationMode?: 'append' | 'replace';
};
type Source = { name: string; shape: string; anchor: string; root: string; en?: string; shapeEn?: string; anchorEn?: string };
type Concept = { name: string; prop: string; mood: string; suffix: string; en?: string; propEn?: string; moodEn?: string };
export type FusionRowCatalogueSnapshot = { formatVersion: 1; catalogueVersion: string; seed: number; engineVersion: string; categories: FusionCategory[]; terms: FusionTerm[];
  selections: Record<string, string[]>; settings?: FusionSettings; settingsRef?: { operationId: string; configurationId: string }; body: { zh: string; en: string } };
export type FusionRow = {
  id: string; name: string; category: Categories; source: Source; concept: Concept; bridge: string;
  displayNo?: number; originBatchId?: string;
  mechanism: { cn: string; en: string }; personality: { pose: string; en: string };
  detail: Partial<Record<Dimension, string>>; advanced: boolean; isBoss?: boolean;
  design?: Design;
  translations?: Array<{ dimension: Dimension; label: string; en: string }>;
  role?: string; cards?: Array<{ id: string; title: string; titleEn: string; label: string; en: string; descriptionZh?: string; descriptionEn?: string; values?: Array<{ zh: string; en: string; termId?: string; descriptionZh?: string; descriptionEn?: string }>; multi?: boolean }>;
  catalogueSnapshot?: FusionRowCatalogueSnapshot;
};
export const FUSION_ENGINE_VERSION = 'ux22-1';
export const COUNTS = [4, 8, 12, 16, 24, 32];
export const CORE = CONFIG.filter(c => !('optional' in c));
export const ADDONS = CONFIG.filter(c => 'optional' in c);
export const optional = (id: Dimension) => ADDONS.some(c => c.id === id);
export function defaults(): FusionSettings {
  return { rules: Object.fromEntries(CONFIG.map(c => [c.id, c.tags.map(label => ({ label, status: c.id === 'source' && label === '职业' ? 'exclude' : 'default' }))])) as FusionSettings['rules'],
    requirements: DEFAULT_REQUIREMENTS, requirementsEnabled: false, requirementsEn: '', cards: [], role: '', catalogue: { details: {}, traits: { primaryPersonality: { enabled: true, locked: false, values: [], excluded: [], must: [] } } }, count: 16, lang: 'zh',
    boss: { source: '动物', concept: '海洋探索', mechanism: '展开折叠类', personality: '聪明机敏型', equipment: '', signature: '', entity: '', physique: '' },
    bossLocks: Object.fromEntries(CONFIG.map(c => [c.id, false])) as FusionSettings['bossLocks'], bossDimensions: CORE.map(c => c.id), diversity: 'prefer' };
}
/** Preserve unique inline definitions without carrying a previous creation's active choices. */
export function newCreationSettings(settings: FusionSettings): FusionSettings {
  const previous = parseSettings(settings), base = defaults();
  base.count = previous.count; base.lang = previous.lang;
  for (const dimension of CONFIG) {
    const defaultsByLabel = new Map(base.rules[dimension.id].map(tag => [tag.label, tag]));
    base.rules[dimension.id] = [...base.rules[dimension.id].map(tag => ({ ...tag, ...(previous.rules[dimension.id].find(old => old.label === tag.label)?.en ? { en: previous.rules[dimension.id].find(old => old.label === tag.label)!.en } : {}) })),
      ...previous.rules[dimension.id].filter(tag => !defaultsByLabel.has(tag.label)).map(tag => ({ ...tag, status: 'exclude' as const, definitionOnly: true as const }))];
  }
  base.cards = previous.cards.map(card => ({ ...card, tags: card.tags.map(tag => ({ ...tag, status: 'default' as const })), joined: false, locked: false,
    value: card.value, ...(card.multi ? { values: [card.value] } : {}) }));
  if (previous.catalogue?.dynamic) base.catalogue!.dynamic = { ...structuredClone(previous.catalogue.dynamic), selections: Object.fromEntries(Object.entries(previous.catalogue.dynamic.selections).map(([id, state]) => [id,
    { enabled: false, locked: false, values: state.values.slice(0, 1), excluded: [], must: [] }])) };
  return parseSettings(base);
}

/** Validate the single external boundary used by recipe saves and restored drafts. */
export function parseSettings(input: unknown): FusionSettings {
  const s = input as FusionSettings;
  if (!s || typeof s !== 'object' || !COUNTS.includes(s.count) || !['zh', 'en', 'both'].includes(s.lang)
    || typeof s.requirements !== 'string' || s.requirements.length > 6000 || !s.rules || !s.boss || !s.bossLocks
    || !Array.isArray(s.bossDimensions) || s.bossDimensions.length > 8 || new Set(s.bossDimensions).size !== s.bossDimensions.length
    || s.bossDimensions.some(id => !CONFIG.some(c => c.id === id))) throw new Error('配方设置无效，请重新保存。');
  const rules = {} as FusionSettings['rules'];
  const boss = {} as Categories, bossLocks = {} as FusionSettings['bossLocks'];
  for (const c of CONFIG) {
    const tags = s.rules[c.id];
    if (!Array.isArray(tags) || tags.length > 160 || tags.length < 1 || tags.some(t => !t || typeof t.label !== 'string'
      || !t.label.trim() || t.label.length > 30 || !['default', 'must', 'exclude'].includes(t.status) || t.definitionOnly !== undefined && t.definitionOnly !== true)
      || new Set(tags.map(t => t.label.trim())).size !== tags.length
      || typeof s.boss[c.id] !== 'string' || typeof s.bossLocks[c.id] !== 'boolean') throw new Error(`${c.title}规则无效。`);
    if (tags.some(t => t.en !== undefined && (typeof t.en !== 'string' || t.en.length > 180 || /[\u3400-\u9fff]/.test(t.en)))) throw new Error('英文标签无效。');
    rules[c.id] = tags.map(t => ({ label: t.label.trim(), status: t.status, ...(t.en ? { en: t.en.trim() } : {}), ...(t.status === 'exclude' && t.definitionOnly ? { definitionOnly: true as const } : {}) }));
    boss[c.id] = s.boss[c.id]; bossLocks[c.id] = s.bossLocks[c.id];
  }
  if (s.requirementsEnabled !== undefined && typeof s.requirementsEnabled !== 'boolean'
    || s.requirementsEn !== undefined && (typeof s.requirementsEn !== 'string' || s.requirementsEn.length > 10000 || /[\u3400-\u9fff]/.test(s.requirementsEn))
    || s.role !== undefined && !['', '主角', '配角', '伙伴', '反派', 'Boss', '路人'].includes(s.role)
    || s.cards !== undefined && (!Array.isArray(s.cards) || s.cards.length > 16) || s.diversity !== undefined && !['prefer', 'strict'].includes(s.diversity)
    || s.generationMode !== undefined && !['append', 'replace'].includes(s.generationMode)) throw new Error('扩展卡片、生成方式或英文设置无效。');
  const cards = (s.cards || []).map(c => {
    const draft = parseCardDraft(c);
    if (!/^card-[a-zA-Z0-9-]{1,80}$/.test(c.id) || typeof c.joined !== 'boolean' || typeof c.locked !== 'boolean' || !draft.tags.some(t => t.label === c.value)) throw new Error('扩展卡片选择无效。');
    if (c.values !== undefined && (!Array.isArray(c.values) || c.values.length > draft.tags.length || new Set(c.values).size !== c.values.length || c.values.some(value => !draft.tags.some(tag => tag.label === value)) || c.values.some((value, i) => c.values!.slice(i + 1).some(other => choicesConflict({ multi: c.multi === true }, value, other))))) throw new Error('扩展卡片多选无效。');
    if (c.candidates !== undefined && (!Array.isArray(c.candidates) || new Set(c.candidates).size !== c.candidates.length || c.candidates.some(value => !draft.tags.some(tag => tag.label === value)))) throw new Error('扩展卡片候选范围无效。');
    return { ...draft, id: c.id, joined: c.joined, value: c.value, locked: c.locked, ...(c.values !== undefined ? { values: [...c.values] } : {}), ...(c.candidates !== undefined ? { candidates: [...c.candidates] } : {}) };
  });
  if (new Set(cards.map(c => c.id)).size !== cards.length) throw new Error('扩展卡片重复。');
  return reconcile({ rules, boss, bossLocks, bossDimensions: [...s.bossDimensions], requirements: s.requirements, count: s.count, lang: s.lang,
    requirementsEnabled: s.requirementsEnabled === true, requirementsEn: s.requirementsEn || '', role: s.role || '', cards, catalogue: parseCatalogue(s.catalogue), ...(s.diversity ? { diversity: s.diversity } : {}), ...(s.generationMode ? { generationMode: s.generationMode } : {}) });
}
export const allowed = (s: FusionSettings, id: Dimension) => s.rules[id].filter(t => t.status !== 'exclude').map(t => t.label);
export const required = (s: FusionSettings, id: Dimension) => s.rules[id].filter(t => t.status === 'must').map(t => t.label);
export function reconcile(s: FusionSettings): FusionSettings {
  const next = { ...s, boss: { ...s.boss }, bossLocks: { ...s.bossLocks } };
  for (const c of CONFIG) if (!s.bossLocks[c.id] && !allowed(s, c.id).includes(s.boss[c.id]) && !(optional(c.id) && s.boss[c.id] === '')) {
    next.boss[c.id] = optional(c.id) ? '' : allowed(s, c.id)[0] || ''; next.bossLocks[c.id] = false;
  }
  return next;
}
export function seeded(seed: number) {
  let n = seed >>> 0;
  return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; };
}
const pick = <T,>(items: readonly T[], rnd: () => number): T => items[Math.floor(rnd() * items.length)];
const lookup = <T,>(bank: Record<string, T>, label: string): T | undefined => Object.prototype.hasOwnProperty.call(bank, label) ? bank[label] : undefined;
function shuffled<T>(values: readonly T[], rnd: () => number) {
  const next = [...values];
  for (let i = next.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [next[i], next[j]] = [next[j], next[i]]; }
  return next;
}
export function refreshBoss(s: FusionSettings, rnd = Math.random, only?: Dimension): FusionSettings {
  const boss = { ...s.boss };
  for (const id of only ? [only] : s.bossDimensions) {
    if (!s.bossDimensions.includes(id) || s.bossLocks[id]) continue;
    const pool = allowed(s, id).filter(v => v !== boss[id]);
    boss[id] = pool.length ? pick(pool, rnd) : allowed(s, id)[0] || '';
  }
  const catalogue = parseCatalogue(s.catalogue);
  if (!only) for (const t of TRAITS) {
    if (catalogue.dynamic?.selections[t.id]) continue;
    const state = catalogue.traits[t.id]; if (!state?.enabled || state.locked) continue;
    catalogue.traits[t.id] = { ...state, values: drawChoices(t.options.filter(o => !state.excluded.includes(o.zh)).map(o => o.zh), t, rnd) };
  }
  if (!only && catalogue.dynamic) for (const [id, state] of Object.entries(catalogue.dynamic.selections)) {
    if (!state.enabled || state.locked) continue;
    const category = catalogue.dynamic.snapshot.categories.find(category => category.id === id)!;
    const terms = catalogue.dynamic.snapshot.terms.filter(term => term.categoryId === id);
    state.values = drawChoices(dynamicPool(category, state, terms).map(term => term.id), dynamicPolicy(category, terms), rnd);
  }
  for (const [id, detail] of Object.entries(catalogue.details)) if (detail && !detail.locked && (!only || only === id)) {
    const pool = concreteOptions(id, boss[id as Dimension]);
    if (pool.length) catalogue.details[id] = { value: pick(pool, rnd).zh, locked: false };
  }
  return { ...s, boss, catalogue, cards: s.cards.map(c => {
    if (!c.joined || c.locked || only) return c;
    const values = drawChoices(c.tags.filter(t => t.status !== 'exclude' && (c.candidates === undefined || c.candidates.includes(t.label))).map(t => t.label), { multi: Boolean(c.multi) }, rnd);
    return { ...c, value: values[0] || c.value, ...(c.multi ? { values } : {}) };
  }) };
}
export function validateGeneration(s: FusionSettings) {
  const dynamicError = validateDynamicGeneration(s.catalogue, s.count); if (dynamicError) return dynamicError;
  if (s.catalogue?.dynamic) for (const [id, state] of Object.entries(s.catalogue.dynamic.selections)) {
    if (!state.enabled) continue;
    const category = s.catalogue.dynamic.snapshot.categories.find(category => category.id === id)!;
    const dimension = CONFIG.find(dimension => dimension.id === category.generationKind);
    if (!dimension) continue;
    const terms = s.catalogue.dynamic.snapshot.terms.filter(term => term.categoryId === id);
    const active = state.locked ? terms.filter(term => state.values.includes(term.id)) : dynamicPool(category, state, terms);
    if (active.some(term => !allowed(s, dimension.id).includes(term.data!.group!))) return `${category.nameZh}的候选与原类别排除规则冲突，请调整候选范围。`;
    if (s.bossLocks[dimension.id] && active.some(term => term.data!.group !== s.boss[dimension.id])) return `${category.nameZh}与原类别锁定冲突，请先解锁。`;
    if (s.catalogue.details[dimension.id]?.locked) return `${category.nameZh}已使用新词库选择，请先解锁原具体选项。`;
    const propPolicy = s.catalogue.traits.equipmentPolicy, dynamicProps = s.catalogue.dynamic.selections.equipmentPolicy;
    const noProps = propPolicy?.enabled && propPolicy.locked && propPolicy.values.includes('无道具') || dynamicProps?.enabled && dynamicProps.locked && dynamicProps.values.some(id => s.catalogue!.dynamic!.snapshot.terms.some(term => term.id === id && (term.legacyValue || term.nameZh) === '无道具'));
    if (dimension.id === 'equipment' && noProps) return '词库道具选择与固定无道具规则冲突，请保留一种明确设置。';
    const reachable = (state.locked ? terms.filter(term => state.values.includes(term.id)) : dynamicPool(category, state, terms)).map(term => term.data!.group);
    if (required(s, dimension.id).some(group => !reachable.includes(group))) return `${category.nameZh}的原类别必出项在有效候选池中没有可用词条。`;
    const overrides = dimension.id === 'personality' ? ['primaryPersonality'] : dimension.id === 'mechanism' ? ['mechanismPrinciple', 'mechanismMotion'] : dimension.id === 'entity' ? ['bodyCount', 'assembly', 'relationship', 'consciousness'] : dimension.id === 'physique' ? TRAITS.filter(trait => trait.group === 'body').map(trait => trait.id) : [];
    if (overrides.some(id => s.catalogue?.dynamic?.selections[id]?.enabled || !s.catalogue?.dynamic?.selections[id] && s.catalogue?.traits[id]?.enabled)) return `${category.nameZh}与已加入的专属属性重复，请保留一种明确设置。`;
  }
  for (const definition of TRAITS) {
    if (s.catalogue?.dynamic?.selections[definition.id]) continue;
    const state = s.catalogue?.traits[definition.id]; if (!state?.enabled) continue;
    const policy = s.catalogue?.traits.equipmentPolicy;
    if (definition.id.startsWith('equipment') && definition.id !== 'equipmentPolicy' && policy?.enabled && policy.locked && policy.values.includes('无道具')) continue;
    if (!definition.options.some(o => !state.excluded.includes(o.zh))) return `${definition.title}已全部排除。`;
    if (!state.locked && state.must.length > s.count) return `${definition.title}必出项超过本批数量。`;
    if (state.must.some(value => state.excluded.includes(value))) return `${definition.title}的必出项已被排除。`;
    if (state.locked && state.values.some((value, i) => state.values.slice(i + 1).some(other => choicesConflict(definition, value, other)))) return `${definition.title}原选择中有互斥项，内容已保留，请调整后生成。`;
    if (state.locked && (!state.values.length || state.values.some(v => state.excluded.includes(v)) || state.must.some(v => !state.values.includes(v)))) return `${definition.title}固定项与规则冲突。`;
  }
  const fusion = s.catalogue?.sourceFusion;
  if (fusion?.enabled && fusion.locked && (!fusion.values.length || fusion.values.some(value => !allowed(s, 'source').some(group => concreteOptions('source', group).some(option => option.zh === value))))) return '辅助母体的固定选择与母体类别规则冲突，请调整选择或规则。';
  for (const [id, detail] of Object.entries(s.catalogue?.details || {})) if (detail?.locked) {
    const category = CONFIG.find(c => c.id === id)?.tags.find(label => concreteOptions(id, label).some(o => o.zh === detail.value));
    if (!category || !allowed(s, id as Dimension).includes(category) || required(s, id as Dimension).some(v => v !== category)) return `具体选项「${detail.value}」与类别规则冲突，请解锁或调整规则。`;
  }
  for (const c of s.cards.filter(c => c.joined)) {
    const eligible = c.tags.filter(t => t.status !== 'exclude' && (c.candidates === undefined || c.candidates.includes(t.label)));
    if (!eligible.length) return `${c.title}没有可用候选，请调整候选范围或排除。`;
    const must = c.tags.filter(t => t.status === 'must');
    if (!c.locked && must.length > s.count) return `${c.title}的本批必出项超过生成数量。`;
    if (c.locked && cardValues(c).some((value, index) => cardValues(c).slice(index + 1).some(other => choicesConflict({ multi: Boolean(c.multi) }, value, other)))) return `${c.title}的固定组合包含互斥选项，请调整后生成。`;
    if (must.some(tag => !eligible.some(term => term.label === tag.label))) return `${c.title}的分别使用项不在有效候选范围内。`;
    if (c.locked && (!cardValues(c).length || cardValues(c).some(value => !eligible.some(t => t.label === value)) || must.some(t => !cardValues(c).includes(t.label)))) return `${c.title}的固定项与规则冲突，请解锁或调整本批必出项。`;
  }
  for (const c of CONFIG) {
    if (!s.bossDimensions.includes(c.id)) { if (optional(c.id)) continue; return `请将${c.title}加入角色组合。`; }
    if (!optional(c.id) && !allowed(s, c.id).length) return `${c.title}已全部排除，请至少保留一个选项。`;
    const must = required(s, c.id);
    if (must.length > s.count) return `${c.title}的本批必出项超过本轮 ${s.count} 条，请增加数量或减少必出项。`;
    if (s.bossLocks[c.id] && (!allowed(s, c.id).includes(s.boss[c.id]) && !(optional(c.id) && s.boss[c.id] === '') || must.some(label => label !== s.boss[c.id]))) return `${c.title}的固定项与规则冲突，请解锁或调整本批必出项。`;
  }
  return null;
}
export function chooseCategories(s: FusionSettings, rnd: () => number): Categories[] {
  const rows = Array.from({ length: s.count }, () => ({} as Categories));
  for (const c of CONFIG) {
    const dynamic = s.catalogue?.dynamic;
    const dynamicCategory = dynamic?.snapshot.categories.find(category => category.generationKind === c.id && dynamic.selections[category.id]?.enabled);
    if (dynamic && dynamicCategory) {
      const state = dynamic.selections[dynamicCategory.id], terms = dynamic.snapshot.terms.filter(term => term.categoryId === dynamicCategory.id);
      const pool = dynamicPool(dynamicCategory, state, terms), groups = Array.from(new Set(pool.map(term => term.data!.group!)));
      const cycle = shuffled(groups, rnd);
      rows.forEach((row, index) => {
        const requiredId = state.locked ? state.values[0] : state.must[index];
        row[c.id] = requiredId ? terms.find(term => term.id === requiredId)!.data!.group! : c.id === 'source' ? cycle[index % cycle.length] : pick(groups, rnd);
      });
      continue;
    }
    if (optional(c.id) && !s.bossDimensions.includes(c.id)) { rows.forEach(row => { row[c.id] = ''; }); continue; }
    const concrete = s.catalogue?.details[c.id];
    const fixedCategory = concrete?.locked ? c.tags.find(label => concreteOptions(c.id, label).some(o => o.zh === concrete.value)) : undefined;
    if (fixedCategory) { rows.forEach(row => { row[c.id] = fixedCategory; }); continue; }
    if (s.bossLocks[c.id]) { rows.forEach(row => { row[c.id] = s.boss[c.id]; }); continue; }
    const pool = allowed(s, c.id), must = shuffled(required(s, c.id), rnd);
    // Cycle source domains before repeating; required tags retain their own slots.
    const sourceCycle = shuffled(pool.filter(v => !must.includes(v)), rnd);
    const values = Array.from({ length: s.count }, (_, i) => {
      if (i < must.length) return must[i];
      if (c.id === 'source') return sourceCycle[i - must.length] || pool[(i - must.length) % pool.length];
      return pool.length ? pick(pool, rnd) : '';
    });
    shuffled(values, rnd).forEach((value, i) => { rows[i][c.id] = value; });
  }
  return rows;
}
export function makeRow(category: Categories, seed: number, prior?: FusionRow, changed?: Dimension): FusionRow {
  const rnd = seeded(seed);
  const source = prior && changed !== 'source' ? prior.source : pick(lookup<Source[]>(SOURCES, category.source) || [{ name: category.source, shape: `以${category.source}为基础的清晰几何主轮廓`, anchor: `${category.source}最有辨识度的主体特征`, root: category.source.slice(0, 2) }], rnd);
  const concept = prior && changed !== 'concept' ? prior.concept : pick(lookup<Concept[]>(CONCEPTS, category.concept) || [{ name: category.concept + '探索者', prop: category.concept + '主题装置', mood: category.concept + '的鲜明视觉符号', suffix: '探索者' }], rnd);
  const legacy = (id: Dimension) => { const c = CONFIG.find(c => c.id === id)!; const i = (c.tags as readonly string[]).indexOf(category[id]); return i < 0 ? category[id] : (LEGACY_TAGS as Record<string, string[]>)[id][i]; };
  const mechanism = prior && changed !== 'mechanism' ? prior.mechanism : lookup<FusionRow['mechanism']>(MECHANISMS, legacy('mechanism')) || { cn: `采用${category.mechanism}范围内的原创可视化交互，连接结构完整可读`, en: `an original functional system within ${category.mechanism}, with visible connections` };
  const personality = prior && changed !== 'personality' ? prior.personality : lookup<FusionRow['personality']>(PERSONALITIES, legacy('personality')) || { pose: `体现${category.personality}的清晰肢体语言`, en: `a readable pose expressing ${category.personality}` };
  const detail: FusionRow['detail'] = prior ? { ...prior.detail } : {};
  for (const c of ADDONS.filter(c => c.id !== 'mechanism' && c.id !== 'personality')) {
    if (prior && changed !== c.id) continue;
    if (category[c.id]) { const i = (c.tags as readonly string[]).indexOf(category[c.id]); detail[c.id] = i < 0 ? `围绕「${category[c.id]}」延展的具体原创结构` : pick([(LEGACY_TAGS as Record<string, string[]>)[c.id][i], (DETAIL_ALTS as Record<string, string[]>)[c.id][i]], rnd); }
    else delete detail[c.id];
  }
  return { id: prior?.id || `fusion-${seed}-${Math.floor(rnd() * 1e9)}`, name: source.root + concept.suffix, category: { ...category }, source, concept, mechanism, personality, detail,
    bridge: `${source.anchor}演化为「${concept.prop}」的造型核心，${mechanism.cn}。`, advanced: prior?.advanced || false, ...(prior?.isBoss ? { isBoss: true } : {}) };
}
function uniqueName(row: FusionRow, others: FusionRow[]) {
  const names = new Set(others.map(r => r.name)), base = row.name;
  let n = 2; while (names.has(row.name)) row = { ...row, name: `${base} ${n++}` };
  if (row.design && row.name !== base) row = { ...row, design: { ...row.design, sections: row.design.sections.map((p, i) => i === 0 ? { ...p, zh: p.zh.replace(`「${base}」`, `「${row.name}」`) } : p) } };
  return row;
}
type AllocationAxis = { id: string; title: string; kind: string; terms: FusionTerm[]; pool: FusionTerm[]; fixed?: string[]; must: string[]; groups: string[]; policy: SelectionPolicy };
function allocationAxes(s: FusionSettings): AllocationAxis[] {
  const builtin = builtinCatalogue(), dynamic = s.catalogue?.dynamic, axes: AllocationAxis[] = [];
  for (const [id, state] of Object.entries(dynamic?.selections || {})) {
    if (!state.enabled) continue;
    const category = dynamic!.snapshot.categories.find(category => category.id === id)!;
    const terms = dynamic!.snapshot.terms.filter(term => term.categoryId === id);
    axes.push({ id, title: category.nameZh, kind: category.generationKind, terms, pool: dynamicPool(category, state, terms), fixed: state.locked ? [...state.values] : undefined,
      must: [...state.must], groups: CONFIG.some(d => d.id === category.generationKind) ? required(s, category.generationKind as Dimension) : [], policy: dynamicPolicy(category, terms) });
  }
  for (const dimension of CONFIG) {
    if (!s.bossDimensions.includes(dimension.id) || axes.some(axis => axis.kind === dimension.id)) continue;
    const id = builtinCategoryId(dimension.id), terms = builtin.terms.filter(term => term.categoryId === id);
    // Inline legacy rule labels remain usable even when they have no formal catalogue entry.
    for (const tag of s.rules[dimension.id]) if (!terms.some(term => term.data?.group === tag.label)) terms.push({
      id: builtinTermId(id, tag.label), categoryId: id, version: 'inline-1', enabled: true, scope: 'builtin', ownerId: null,
      nameZh: tag.label, nameEn: tag.en || dimension.english.toLowerCase(), descriptionZh: tag.label, descriptionEn: tag.en || dimension.english.toLowerCase(),
      legacyValue: tag.label, aliases: [], tags: [], sortOrder: terms.length, data: { group: tag.label },
    });
    const detail = s.catalogue?.details[dimension.id];
    const pool = terms.filter(term => allowed(s, dimension.id).includes(term.data!.group!) && (!s.bossLocks[dimension.id] || term.data!.group === s.boss[dimension.id]) && (!detail?.locked || (term.legacyValue || term.nameZh) === detail.value));
    axes.push({ id, title: dimension.title, kind: dimension.id, terms, pool, ...(detail?.locked ? { fixed: pool.map(term => term.id) } : {}), must: [], groups: required(s, dimension.id), policy: { multi: false } });
  }
  for (const definition of TRAITS) {
    if (dynamic?.selections[definition.id] || !s.catalogue?.traits[definition.id]?.enabled) continue;
    const state = s.catalogue.traits[definition.id], terms = builtin.terms.filter(term => term.categoryId === definition.id);
    axes.push({ id: definition.id, title: definition.title, kind: 'trait', terms, pool: terms.filter(term => !state.excluded.includes(term.legacyValue || term.nameZh)),
      fixed: state.locked ? state.values.map(value => builtinTermId(definition.id, value)) : undefined, must: state.must.map(value => builtinTermId(definition.id, value)), groups: [],
      policy: { ...definition, exclusive: definition.options.filter(option => choicesConflict({ multi: true, exclusive: definition.exclusive }, option.zh, '__other__')).map(option => builtinTermId(definition.id, option.zh)), incompatible: definition.incompatible?.map(([a, b]) => [builtinTermId(definition.id, a), builtinTermId(definition.id, b)]) } });
  }
  for (const card of s.cards.filter(card => card.joined && !axes.some(axis => axis.id === card.id))) {
    const common = { version: 'inline-1', enabled: true, scope: 'builtin' as const, ownerId: null, aliases: [], tags: [], categoryId: card.id };
    const terms: FusionTerm[] = card.tags.map((tag, sortOrder) => ({ ...common, id: tag.termId || builtinTermId(card.id, tag.label), nameZh: tag.label, nameEn: tag.en, descriptionZh: tag.descriptionZh || tag.label, descriptionEn: tag.descriptionEn || tag.en, legacyValue: tag.label, sortOrder }));
    const termId = (label: string) => terms.find(term => term.nameZh === label)!.id;
    axes.push({ id: card.id, title: card.title, kind: 'card', terms, pool: terms.filter(term => card.tags.find(tag => tag.label === term.nameZh)!.status !== 'exclude' && (card.candidates === undefined || card.candidates.includes(term.nameZh))), fixed: card.locked ? cardValues(card).map(termId) : undefined,
      must: card.tags.filter(tag => tag.status === 'must').map(tag => termId(tag.label)), groups: [], policy: { multi: Boolean(card.multi), exclusive: card.tags.filter(tag => choicesConflict({ multi: true }, tag.label, '__other__')).map(tag => termId(tag.label)) } });
  }
  return axes;
}
function allocationIds(axis: AllocationAxis, values: string[]) {
  return values.map(value => {
    const term = axis.terms.find(term => term.id === value || (term.legacyValue || term.nameZh) === value);
    if (!term || !axis.pool.some(allowed => allowed.id === term.id)) throw new Error(`${axis.title}的本次选择不在有效候选范围内，请调整后生成。`);
    return term.id;
  });
}
/** The source allocator sees hard constraints first; history is a preference that may relax. */
export function allocateFusionBatch(s: FusionSettings, seed: number, options: { onceMust?: Record<string, string[]>; diversity?: 'prefer' | 'strict'; avoidSourceTermIds?: string[] } = {}): FusionAllocation {
  const error = validateGeneration(s); if (error) throw new Error(error);
  const axes = allocationAxes(s), random = seeded(seed), rows: FusionAllocation['rows'] = Array.from({ length: s.count }, () => ({ selections: {} }));
  for (const [id, values] of Object.entries(options.onceMust || {})) if (values.length && !axes.some(axis => axis.id === id)) {
    const builtin = builtinCatalogue(), categories = [...(s.catalogue?.dynamic?.snapshot.categories || []), ...builtin.categories], terms = [...(s.catalogue?.dynamic?.snapshot.terms || []), ...builtin.terms];
    const referenced = Array.from(new Set(values.flatMap(value => { const term = terms.find(term => term.id === value); return term ? [term.categoryId] : []; })));
    const category = categories.find(category => category.id === id) || (referenced.length === 1 ? categories.find(category => category.id === referenced[0]) : undefined);
    const joined = category && axes.some(axis => axis.id === category.id), dynamic = category && s.catalogue?.dynamic?.selections[category.id];
    const dimension = category && !dynamic && CONFIG.find(dimension => builtinCategoryId(dimension.id) === category.id);
    const trait = category && !dynamic && TRAITS.find(trait => trait.id === category.id), cardIndex = category && !dynamic ? s.cards.findIndex(card => card.id === category.id) : -1;
    const path = category && (dynamic || category.scope !== 'builtin') ? ['catalogue', 'dynamic', 'selections', category.id] : trait ? ['catalogue', 'traits', trait.id] : undefined;
    const activation = joined ? '该类别已加入，只纠正onceMust的key，保留现有设置，不另启用或创建动态覆盖。'
      : dimension ? `先在本批plan.overlay的["bossDimensions"]保留原项目并加入${JSON.stringify(dimension.id)}，不改boss或sourceFusion选值。`
      : cardIndex >= 0 ? `先在本批plan.overlay将${JSON.stringify(['cards', String(cardIndex), 'joined'])}设为true，保留原卡其它字段。`
      : path ? `先在本批plan.overlay启用${JSON.stringify(path)}（已有选择仅改enabled:true；未配置才补完整selection），或用户明确持续启用时用patchSettings。`
      : '请查询controls取得当前类别的真实加入方式，不猜动态覆盖路径。';
    const userMessage = category ? joined ? `本批“${category.nameZh}”的类别编号与所选词条不一致。请重新选择对应类别；原结果与输入保留。` : `本批“${category.nameZh}”未加入组合或当前不可用。请先加入该类别，或改选已可用的类别；原结果与输入保留。` : '本批必出项的类别未能确认。请从词库重新选择可用类别；原结果与输入保留。';
    throw Object.assign(new Error(`${userMessage} onceMust[${JSON.stringify(id)}]未匹配当前组合类别。${category ? `${category.nameZh}的真实categoryId为${JSON.stringify(category.id)}；${category.enabled ? activation : '该目录类别已停用，不能用selection.enabled绕过，请重新查询可用类别。'}` : '该key不是当前已知目录categoryId，请查询catalogue/controls原样引用，不用名称或generationKind作key。'}保留已有锁定、候选池与排除；启用不会解除原限制。`), { userMessage });
  }
  let diversity: FusionAllocation['diversity'];
  for (const axis of axes.filter(axis => axis.kind === 'source' || axis.groups.length || options.onceMust?.[axis.id]?.length)) {
    const must = Array.from(new Set([...axis.must, ...allocationIds(axis, options.onceMust?.[axis.id] || [])]));
    if (axis.fixed) {
      if (must.some(id => !axis.fixed!.includes(id))) throw new Error(`${axis.title}的本批要求与固定组合冲突，请先调整锁定。`);
      rows.forEach(row => { row.selections[axis.id] = [...axis.fixed!]; });
      if (axis.kind === 'source') diversity = { availableSourceCount: new Set(axis.fixed).size, repeatedSourceCount: Math.max(0, s.count - new Set(axis.fixed).size), relaxed: s.count > new Set(axis.fixed).size };
    } else {
      if (must.length > s.count) throw new Error(`${axis.title}的本批必出项超过生成数量。`);
      if (must.some(id => !axis.pool.some(term => term.id === id))) throw new Error(`${axis.title}的必出项不在有效候选范围内。`);
      const required = shuffled(must, random), coveredGroups = new Set(required.map(id => axis.terms.find(term => term.id === id)?.data?.group));
      for (const group of shuffled(axis.groups, random)) if (!coveredGroups.has(group)) {
        const term = pick(axis.pool.filter(term => term.data?.group === group), random);
        if (!term) throw new Error(`${axis.title}的必出类别没有可用词条。`);
        required.push(term.id); coveredGroups.add(group);
      }
      if (required.length > s.count) throw new Error(`${axis.title}的本批必出要求无法在${s.count}条内同时满足。`);
      if (!axis.pool.length) {
        if (axis.kind === 'source' && options.diversity !== 'strict' && !required.length) continue;
        throw new Error(`${axis.title}没有可生成的候选。`);
      }
      const used = new Set<string>(), avoided = new Set(options.avoidSourceTermIds || []);
      rows.forEach((row, index) => {
        if (axis.kind !== 'source') { row.selections[axis.id] = drawChoices(axis.pool.map(term => term.id), axis.policy, random, required[index]); return; }
        const preferred = axis.pool.filter(term => !used.has(term.id) && !avoided.has(term.id));
        const unused = axis.pool.filter(term => !used.has(term.id));
        const id = required[index] || pick(preferred.length ? preferred : unused.length ? unused : axis.pool, random).id;
        row.selections[axis.id] = [id]; used.add(id);
      });
      if (axis.kind === 'source') diversity = { availableSourceCount: axis.pool.length, repeatedSourceCount: s.count - used.size, relaxed: used.size < s.count || Array.from(used).some(id => avoided.has(id)) };
    }
    if (axis.kind === 'source' && options.diversity === 'strict' && diversity && diversity.repeatedSourceCount > 0) throw new Error(`本次未生成：当前范围只有${diversity.availableSourceCount}种可用母体，无法生成${s.count}条母体绝不重复的方案。请减少数量或调整候选范围。`);
  }
  return { formatVersion: 1, rows, ...(diversity ? { diversity } : {}) };
}
/** Apply one allocation only to the execution copy; freezeRow receives the unchanged constraints. */
function settingsForAllocation(s: FusionSettings, selections: Record<string, string[]>, axes: AllocationAxis[]): FusionSettings {
  const next = structuredClone(s);
  next.catalogue ||= { details: {}, traits: {} };
  for (const [id, values] of Object.entries(selections)) {
    const axis = axes.find(axis => axis.id === id); if (!axis) throw new Error('本次分配包含未加入或不可用的类别。');
    const selected = allocationIds(axis, values);
    if (!selected.length || axis.fixed && (selected.length !== axis.fixed.length || selected.some(id => !axis.fixed!.includes(id)))
      || selected.some((id, index) => selected.slice(index + 1).some(other => choicesConflict(axis.policy, id, other)))) throw new Error(`${axis.title}的本次分配与固定或互斥规则冲突。`);
    const terms = selected.map(id => axis.terms.find(term => term.id === id)!);
    const state = next.catalogue?.dynamic?.selections[id];
    if (state) { state.locked = true; state.values = selected; continue; }
    if (axis.kind === 'trait') { const state = next.catalogue!.traits[id]; state.locked = true; state.values = terms.map(term => term.legacyValue || term.nameZh); continue; }
    if (axis.kind === 'card') { const card = next.cards.find(card => card.id === id)!; card.locked = true; card.value = terms[0].nameZh; if (card.multi) card.values = terms.map(term => term.nameZh); continue; }
    const dimension = axis.kind as Dimension;
    next.boss[dimension] = terms[0].data!.group!; next.bossLocks[dimension] = true;
    if (concreteOptions(dimension, next.boss[dimension]).some(term => term.zh === terms[0].nameZh)) next.catalogue!.details[dimension] = { value: terms[0].nameZh, locked: true };
  }
  return next;
}
export function generateBatch(s: FusionSettings, seed = Date.now(), allocation?: FusionAllocation) {
  const error = validateGeneration(s); if (error) throw new Error(error);
  if (allocation && (allocation.formatVersion !== 1 || allocation.rows.length !== s.count)) throw new Error('本次分配数量与生成计划不一致，原结果仍保留。');
  const axes = allocation ? allocationAxes(s) : [];
  const result: FusionRow[] = [];
  chooseCategories(s, seeded(seed)).forEach((category, i) => {
    const runtime = allocation ? settingsForAllocation(s, allocation.rows[i].selections, axes) : s;
    for (const [id] of Object.entries(allocation?.rows[i].selections || {})) { const axis = axes.find(axis => axis.id === id)!; if (CONFIG.some(d => d.id === axis.kind)) category[axis.kind as Dimension] = runtime.catalogue?.dynamic?.selections[id] ? axis.terms.find(term => term.id === runtime.catalogue!.dynamic!.selections[id].values[0])!.data!.group! : runtime.boss[axis.kind as Dimension]; }
    const base = chooseConcrete({ ...makeRow(category, seed + i * 257), role: s.role, translations: translationsFor(s, category), cards: cardChoices(runtime, i, seeded(seed + i)) }, runtime);
    result.push(freezeRow(uniqueName(decorateRow(base, runtime, seeded(seed + i * 397), i), result), s, seed + i * 257));
  });
  const missing = missingRequired(s, result); if (missing.length) throw new Error(`本批必出要求未满足，原结果仍保留：${missing.join('、')}。`);
  return result;
}
export function bossRow(s: FusionSettings, others: FusionRow[], seed = Date.now()) {
  const error = validateGeneration(s); if (error) throw new Error(error);
  for (const c of CORE) if (!s.bossDimensions.includes(c.id) || !allowed(s, c.id).includes(s.boss[c.id])) throw new Error(`角色组合需要加入并选择${c.title}。`);
  const category = { ...s.boss };
  for (const c of ADDONS) if (!s.bossDimensions.includes(c.id)) category[c.id] = '';
  for (const c of s.cards.filter(c => c.joined && c.locked)) if (!cardValues(c).length || cardValues(c).some(value => !c.tags.some(t => t.label === value && t.status !== 'exclude'))) throw new Error(`请为${c.title}选择可用标签。`);
  return freezeRow(uniqueName(decorateRow(chooseConcrete({ ...makeRow(category, seed), role: s.role, translations: translationsFor(s, category), cards: cardChoices(s, 0, seeded(seed), true) }, s, true), s, seeded(seed), 0, true), others), s, seed);
}
function translationsFor(s: Pick<FusionSettings, 'rules'>, category: Categories, prior: FusionRow['translations'] = []): NonNullable<FusionRow['translations']> {
  return CONFIG.flatMap(c => { const label = category[c.id], en = s.rules[c.id].find(t => t.label === label)?.en || prior.find(t => t.dimension === c.id && t.label === label)?.en; return en ? [{ dimension: c.id, label, en }] : []; });
}
function cardChoices(s: FusionSettings, index: number, rnd: () => number, _manual = false): NonNullable<FusionRow['cards']> {
  return s.cards.filter(c => c.joined).map(c => {
    const must = c.tags.filter(t => t.status === 'must');
    const selected = c.locked ? cardValues(c) : drawChoices(c.tags.filter(t => t.status !== 'exclude' && (c.candidates === undefined || c.candidates.includes(t.label))).map(t => t.label), { multi: Boolean(c.multi) }, rnd, must[index]?.label);
    const values = selected.map(value => { const tag = c.tags.find(t => t.label === value)!; return { zh: tag.label, en: tag.en, ...(tag.termId ? { termId: tag.termId } : {}), ...(tag.descriptionZh ? { descriptionZh: tag.descriptionZh } : {}), ...(tag.descriptionEn ? { descriptionEn: tag.descriptionEn } : {}) }; });
    return { id: c.id, title: c.title, titleEn: c.titleEn, label: values.map(value => value.zh).join('、'), en: values.map(value => value.en).join(', '), ...(values.some(value => value.descriptionZh) ? { descriptionZh: values.map(value => value.descriptionZh || value.zh).join('、') } : {}), ...(values.some(value => value.descriptionEn) ? { descriptionEn: values.map(value => value.descriptionEn || value.en).join(', ') } : {}), ...(c.multi ? { values, multi: true } : {}) };
  });
}
export function missingRequired(s: FusionSettings, rows: FusionRow[]) {
  const dynamic = s.catalogue?.dynamic;
  const dynamicMissing = dynamic ? Object.entries(dynamic.selections).flatMap(([id, state]) => !state.enabled ? [] : state.must.filter(termId => !rows.some(row => row.catalogueSnapshot?.selections[id]?.includes(termId))).map(termId => `${dynamic.snapshot.categories.find(category => category.id === id)!.nameZh}：${dynamic.snapshot.terms.find(term => term.id === termId)!.nameZh}`)) : [];
  return [...dynamicMissing, ...TRAITS.flatMap(t => !dynamic?.selections[t.id] && s.catalogue?.traits[t.id]?.enabled ? s.catalogue.traits[t.id].must.filter(label => !rows.some(row => row.design?.traits[t.id]?.some(v => v.zh === label))).map(label => `${t.title}：${label}`) : []), ...CONFIG.filter(c => !optional(c.id) || s.bossDimensions.includes(c.id)).flatMap(c => required(s, c.id).filter(label => !rows.some(r => r.category[c.id] === label)).map(label => `${c.title}：${label}`)),
    ...s.cards.filter(c => c.joined).flatMap(c => c.tags.filter(t => t.status === 'must' && !rows.some(r => r.cards?.some(v => v.id === c.id && (v.values ? v.values.some(value => value.zh === t.label) : v.label === t.label)))).map(t => `${c.title}：${t.label}`))];
}
export function changeRow(s: FusionSettings, rows: FusionRow[], id: string, change?: { dimension: Dimension; value: string }, seed = Date.now()) {
  const error = validateGeneration(s); if (error) throw new Error(error);
  const old = rows.find(r => r.id === id); if (!old) throw new Error('这条提示词已不存在。');
  const others = rows.filter(r => r.id !== id), category = { ...old.category }, rnd = seeded(seed);
  for (const c of CONFIG) {
    if (change && change.dimension !== c.id) continue;
    if (!change && !s.bossDimensions.includes(c.id)) { category[c.id] = ''; continue; }
    if (s.bossDimensions.includes(c.id) && s.bossLocks[c.id]) {
      if (change && change.value !== s.boss[c.id]) throw new Error(`${c.title}已固定，请先解锁再替换。`);
      category[c.id] = s.boss[c.id]; continue;
    }
    const soleRequired = required(s, c.id).includes(old.category[c.id]) && !others.some(r => r.category[c.id] === old.category[c.id]);
    if (change) {
      const concrete = s.catalogue?.details[c.id];
      if (concrete?.locked && !concreteOptions(c.id, change.value).some(o => o.zh === concrete.value)) throw new Error(`具体选项「${concrete.value}」已固定，请先解锁。`);
      if (!allowed(s, c.id).includes(change.value) && !(optional(c.id) && change.value === '')) throw new Error('该标签已排除。');
      if (soleRequired && old.category[c.id] !== change.value) throw new Error(`「${old.category[c.id]}」是本批唯一的必出项，请先在另一条使用它。`);
      category[c.id] = change.value;
    } else if (!soleRequired) category[c.id] = pick(allowed(s, c.id), rnd) || '';
  }
  const row = uniqueName(chooseConcrete(makeRow(category, seed, change ? old : undefined, change?.dimension), s), others);
  const cards = change ? old.cards : cardChoices(s, 0, rnd);
  return rows.map(r => r.id === id ? freezeRow(uniqueName(decorateRow({ ...row, id, displayNo: old.displayNo, originBatchId: old.originBatchId, advanced: old.advanced, isBoss: old.isBoss, role: old.role, cards, translations: translationsFor(s, category, old.translations) }, s, seeded(seed), 0, false, change ? old.design : undefined), others), change ? originalRowSettings(old) || s : s, seed) : r);
}
function originalRowSettings(row: FusionRow): FusionSettings | undefined {
  if (!row.catalogueSnapshot) return undefined;
  if (!row.catalogueSnapshot.settings) throw new Error('此结果的原配置尚未读取，请读取原操作配置后再调整。');
  return row.catalogueSnapshot.settings;
}
export function settingsForRow(s: FusionSettings, row: FusionRow): FusionSettings {
  const original = originalRowSettings(row);
  const base = original || s;
  const catalogue = parseCatalogue(base.catalogue);
  catalogue.traits = Object.fromEntries(TRAITS.map(t => [t.id, { enabled: Boolean((row.design?.chosen || row.design?.traits)?.[t.id]), locked: true, values: (row.design?.chosen || row.design?.traits)?.[t.id]?.map(v => v.zh).filter(label => t.options.some(o => o.zh === label)) || [], excluded: [], must: [] }]));
  catalogue.details = {};
  catalogue.sourceFusion = { enabled: Boolean(row.design?.sources?.length), locked: true, values: row.design?.sources?.map(value => value.zh) || [], excluded: [], must: [] };
  if (catalogue.dynamic && row.catalogueSnapshot) {
    for (const [id, state] of Object.entries(catalogue.dynamic.selections)) {
      const values = row.catalogueSnapshot.selections[id] || [];
      catalogue.dynamic.selections[id] = { ...state, enabled: state.enabled && values.length > 0, locked: true, values: [...values], must: [] };
    }
  }
  for (const id of ['source', 'concept', 'equipment', 'signature', 'entity', 'physique'] as Dimension[]) {
    if (catalogue.dynamic?.snapshot.categories.some(category => category.generationKind === id && catalogue.dynamic!.selections[category.id]?.enabled)) continue;
    const value = id === 'source' ? row.source.name : id === 'concept' ? row.concept.name : row.detail[id];
    if (value && concreteOptions(id, row.category[id]).some(o => o.zh === value)) catalogue.details[id] = { value, locked: true };
  }
  return { ...base, rules: Object.fromEntries(CONFIG.map(c => [c.id, base.rules[c.id].map(tag => ({ ...tag, status: tag.status === 'must' ? 'default' : tag.status }))])) as FusionSettings['rules'],
    boss: { ...row.category }, bossLocks: Object.fromEntries(CONFIG.map(c => [c.id, true])) as FusionSettings['bossLocks'], bossDimensions: CONFIG.filter(c => row.category[c.id]).map(c => c.id), catalogue, cards: (row.cards || []).map(v => {
    const prior = base.cards.find(c => c.id === v.id), values = v.values || [{ zh: v.label, en: v.en }];
    const card = prior || { id: v.id, title: v.title, titleEn: v.titleEn, tags: values.map(value => ({ label: value.zh, en: value.en, status: 'default' as const })) };
    return { ...card, tags: card.tags.map(tag => ({ ...tag, status: tag.status === 'must' ? 'default' as const : tag.status })), multi: Boolean(v.multi), value: values[0].zh, values: v.multi ? values.map(value => value.zh) : undefined, joined: true, locked: true };
  }), role: row.role || '', requirements: row.design?.requirements.zh ?? base.requirements, requirementsEn: row.design?.requirements.en ?? base.requirementsEn, requirementsEnabled: row.design ? Boolean(row.design.requirements.zh) : base.requirementsEnabled };
}
export function reviseRow(s: FusionSettings, rows: FusionRow[], id: string, seed = Date.now()) {
  const error = validateGeneration(s); if (error) throw new Error(error);
  const old = rows.find(row => row.id === id); if (!old) throw new Error('这条提示词已不存在。');
  const next = bossRow(s, rows.filter(row => row.id !== id), seed);
  return rows.map(row => row.id === id ? refreshRowSnapshot({ ...next, id, displayNo: old.displayNo, originBatchId: old.originBatchId, advanced: old.advanced, isBoss: old.isBoss }) : row);
}
/** Apply configured axes while retaining the original choices and details on every untouched axis. */
export function applyRowConfiguration(row: FusionRow, before: FusionSettings, after: FusionSettings, seed: number): FusionRow {
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const changedDimensions = new Set(CONFIG.filter(c => !equal(before.rules[c.id], after.rules[c.id]) || before.boss[c.id] !== after.boss[c.id]
    || before.bossLocks[c.id] !== after.bossLocks[c.id] || before.bossDimensions.includes(c.id) !== after.bossDimensions.includes(c.id)
    || !equal(before.catalogue?.details[c.id], after.catalogue?.details[c.id])).map(c => c.id));
  const changedTraits = new Set([...Object.keys(before.catalogue?.traits || {}), ...Object.keys(after.catalogue?.traits || {})]
    .filter(id => !equal(before.catalogue?.traits[id], after.catalogue?.traits[id])));
  const changedDynamic = new Set([...Object.keys(before.catalogue?.dynamic?.selections || {}), ...Object.keys(after.catalogue?.dynamic?.selections || {})]
    .filter(id => !equal(before.catalogue?.dynamic?.selections[id], after.catalogue?.dynamic?.selections[id])));
  const changedCards = new Set([...before.cards, ...after.cards].filter(card => !equal(before.cards.find(c => c.id === card.id), after.cards.find(c => c.id === card.id))).map(card => card.id));
  for (const id of Array.from(changedDynamic)) {
    const category = after.catalogue?.dynamic?.snapshot.categories.find(category => category.id === id) || before.catalogue?.dynamic?.snapshot.categories.find(category => category.id === id);
    if (category?.generationKind === 'body-card') changedCards.add(category.legacyId || category.id);
    else if (category && CONFIG.some(c => c.id === category.generationKind)) changedDimensions.add(category.generationKind as Dimension);
    else changedTraits.add(category?.legacyId || id);
  }
  if (!changedDimensions.size && !changedTraits.size && !changedCards.size && equal(before.catalogue?.sourceFusion, after.catalogue?.sourceFusion) && before.role === after.role) {
    return refreshRowSnapshot({ ...row, ...(row.design ? { design: { ...row.design, requirements: { zh: after.requirementsEnabled ? after.requirements : '', en: after.requirementsEnabled ? after.requirementsEn : '' } } } : {}) }, after);
  }
  const candidate = bossRow(after, [], seed), detail = { ...row.detail }, category = { ...row.category };
  for (const id of Array.from(changedDimensions)) { category[id] = candidate.category[id]; if (candidate.detail[id] === undefined) delete detail[id]; else detail[id] = candidate.detail[id]; }
  const cards = [...(row.cards || []).filter(card => !changedCards.has(card.id)), ...(candidate.cards || []).filter(card => changedCards.has(card.id))];
  const chosen = { ...(row.design?.chosen || row.design?.traits || {}) };
  for (const id of Array.from(changedTraits)) { const values = (candidate.design?.chosen || candidate.design?.traits)?.[id]; if (values) chosen[id] = values; else delete chosen[id]; }
  const oldDynamic = row.design?.dynamic, newDynamic = candidate.design?.dynamic;
  const dynamicCategories = [...(oldDynamic?.categories || []).filter(category => !changedDynamic.has(category.id)), ...(newDynamic?.categories || []).filter(category => changedDynamic.has(category.id))];
  const dynamicTerms = [...(oldDynamic?.terms || []).filter(term => !changedDynamic.has(term.categoryId)), ...(newDynamic?.terms || []).filter(term => changedDynamic.has(term.categoryId))];
  const dynamicSelections = { ...oldDynamic?.selections };
  for (const id of Array.from(changedDynamic)) { if (newDynamic?.selections[id]) dynamicSelections[id] = newDynamic.selections[id]; else delete dynamicSelections[id]; }
  const retained: Design = { ...(row.design || candidate.design!), chosen, traits: chosen,
    sources: equal(before.catalogue?.sourceFusion, after.catalogue?.sourceFusion) ? row.design?.sources : candidate.design?.sources,
    dynamic: dynamicCategories.length ? { version: newDynamic?.version || oldDynamic!.version, categories: dynamicCategories, terms: dynamicTerms, selections: dynamicSelections } : undefined };
  const raw = { ...row, category, detail, cards, role: after.role,
    source: changedDimensions.has('source') ? candidate.source : row.source, concept: changedDimensions.has('concept') ? candidate.concept : row.concept,
    mechanism: changedDimensions.has('mechanism') ? candidate.mechanism : row.mechanism, personality: changedDimensions.has('personality') ? candidate.personality : row.personality };
  const decorated = decorateRow(raw, after, seeded(seed), 0, true, retained);
  const preserved = { ...decorated, name: row.name, ...(decorated.design ? { design: { ...decorated.design, sections: decorated.design.sections.map((section, index) => index === 0 ? { ...section, zh: section.zh.replace(`「${decorated.name}」`, `「${row.name}」`) } : section) } } : {}) };
  return freezeRow(preserved, after, seed);
}
function freezeRow(row: FusionRow, settings: FusionSettings, seed: number): FusionRow {
  const builtin = builtinCatalogue(), selections: Record<string, string[]> = {}, inlineCategories: FusionCategory[] = [], inlineTerms: FusionTerm[] = [];
  const select = (categoryId: string, labels: string[]) => {
    const card = settings.cards.find(card => card.id === categoryId), dimension = CONFIG.find(dimension => builtinCategoryId(dimension.id) === categoryId);
    const ids = labels.flatMap(label => {
      const term = builtin.terms.find(term => term.categoryId === categoryId && (term.legacyValue || term.nameZh) === label);
      if (term) return [term.id];
      const cardTag = card?.tags.find(tag => tag.label === label), inline = cardTag || dimension && settings.rules[dimension.id].find(tag => tag.label === label);
      if (!inline) return [];
      const common = { version: 'inline-1', enabled: true, scope: 'builtin' as const, ownerId: null, aliases: [], tags: [], sortOrder: 0 };
      if (card && !inlineCategories.some(category => category.id === categoryId) && !builtin.categories.some(category => category.id === categoryId)) inlineCategories.push({ ...common, id: categoryId, legacyId: card.id, nameZh: card.title, nameEn: card.titleEn,
        descriptionZh: card.title, descriptionEn: card.titleEn, group: 'extra', multi: Boolean(card.multi), randomMax: card.multi ? 3 : 1, generationKind: 'body-card' });
      const id = cardTag?.termId || builtinTermId(categoryId, label), en = inline.en || dimension?.english.toLowerCase() || label;
      inlineTerms.push({ ...common, id, categoryId, nameZh: label, nameEn: en, descriptionZh: cardTag?.descriptionZh || label, descriptionEn: cardTag?.descriptionEn || en, legacyValue: label, ...(dimension ? { data: { group: row.category[dimension.id] } } : {}) });
      return [id];
    });
    if (ids.length) selections[categoryId] = ids;
  };
  for (const dimension of CONFIG) select(builtinCategoryId(dimension.id), [dimension.id === 'source' ? row.source.name : dimension.id === 'concept' ? row.concept.name : row.detail[dimension.id] || row.category[dimension.id]]);
  for (const [id, values] of Object.entries(row.design?.traits || {})) select(id, values.map(value => value.zh));
  for (const card of row.cards || []) select(card.id, (card.values || [{ zh: card.label }]).map(value => value.zh));
  Object.assign(selections, row.design?.dynamic?.selections);
  const ids = new Set(Object.values(selections).flat()), categoryIds = new Set(Object.keys(selections));
  const categories = new Map(builtin.categories.filter(category => categoryIds.has(category.id)).map(category => [category.id, category]));
  const terms = new Map(builtin.terms.filter(term => ids.has(term.id)).map(term => [term.id, term]));
  for (const category of inlineCategories) categories.set(category.id, category);
  for (const term of inlineTerms) terms.set(term.id, term);
  for (const category of row.design?.dynamic?.categories || []) categories.set(category.id, category);
  for (const term of row.design?.dynamic?.terms || []) terms.set(term.id, term);
  const next = { ...row, catalogueSnapshot: { formatVersion: 1 as const, catalogueVersion: row.design?.dynamic?.version || builtin.version, seed, engineVersion: FUSION_ENGINE_VERSION,
    categories: structuredClone(Array.from(categories.values())), terms: structuredClone(Array.from(terms.values())), selections, settings: structuredClone(settings), body: { zh: '', en: '' } } };
  return refreshRowSnapshot(next);
}
/** For explicit row-only translation/art-direction/advanced edits; definitions stay frozen. */
export function refreshRowSnapshot(row: FusionRow, settings?: FusionSettings, seed?: number): FusionRow {
  if (!row.catalogueSnapshot) return row;
  const original = row.catalogueSnapshot;
  const snapshot = { ...original, ...(settings ? { settings: structuredClone(settings) } : {}), ...(seed !== undefined ? { seed } : {}) };
  const next = { ...row, catalogueSnapshot: snapshot };
  if (!snapshot.settings && !row.design) throw new Error('此结果的原配置尚未读取，无法更新正文快照。');
  const renderSettings = snapshot.settings || { requirements: '', requirementsEnabled: false };
  snapshot.body = { zh: textFor(next, { ...renderSettings, lang: 'zh' }), en: textFor(next, { ...renderSettings, lang: 'en' }) };
  return next;
}
export function textFor(row: FusionRow, settings: Pick<FusionSettings, 'requirements' | 'lang'> & Partial<Pick<FusionSettings, 'requirementsEnabled' | 'requirementsEn' | 'rules'>>) {
  const c = row.category;
  const fixed = settings.requirementsEnabled ? settings.requirements.trim() : '';
  const bodyRatio = row.cards?.some(card => card.id === BODY_HEAD_RATIO_ID);
  const fixedCn = bodyRatio && fixed === DEFAULT_REQUIREMENTS && !settings.requirementsEn?.trim() ? fixed.replace('2.5头身，', '') : fixed;
  const roleEn: Record<string, string> = { '主角': 'protagonist', '配角': 'supporting character', '伙伴': 'companion', '反派': 'antagonist', Boss: 'boss character', '路人': 'background character' };
  const cardCn = (row.cards || []).map(v => `${v.title}：${v.label}。`).join('');
  const cardEn = (row.cards || []).map(v => `${v.titleEn}: ${v.en}.`).join(' ');
  const featureAdaptation = ['动物', '神话', '职业'].includes(c.source) ? '保留与母体自然相连的部位' : '把特征放在母体本身合理存在的结构表面';
  const extras = [
    c.equipment ? `道具范围「${c.equipment}」：具体设计为「${row.detail.equipment}」，从${row.source.anchor}的结构特征推导出使用方式，服务于${row.concept.name}的任务，展示意料之外但因果成立的功能设计。` : '',
    c.signature ? `特征范围「${c.signature}」：具体表现为「${row.detail.signature}」，${featureAdaptation}，以具体经历或使用磨损解释其来源，形成自然且可读的辨识点。` : '',
    c.entity ? `组合范围「${c.entity}」：具体设计为「${row.detail.entity}」，明确主次角色、连接关系和拆合时的空间归属。` : '',
    c.physique ? `轮廓范围「${c.physique}」：具体表现为「${row.detail.physique}」，组织大中小体块与重心，让整体剪影一眼可辨。` : '',
  ].join('');
  let cn = `原创角色设计「${row.name}」。以${row.source.name}为母体，保留${row.source.shape}；融合${row.concept.name}的身份，将${row.source.anchor}转化为${row.concept.prop}。核心机制：${row.mechanism.cn}。${extras}视觉语言：${row.concept.mood}，主结构紧凑，形态层级分明。性格「${c.personality}」，通过${row.personality.pose}呈现。${fixedCn} ${row.role ? `角色定位：${row.role}。` : ''}${cardCn} 单角色全身设定，三分之四正面视角，完整展示机关的形态、厚度、装配与动作逻辑。${row.advanced ? '高级融合：增加收纳态、启动态与释放态的三阶段变化；关键装置通过一条明确的结构链驱动，动作前后轮廓有强烈辨识度，同时保持角色主体的视觉主导权。' : ''}`;
  const translate = (map: object, value: string) => lookup(map as Record<string, string>, value) || value;
  const extrasEn = [
    c.equipment ? `Equipment: ${englishDetail('equipment', c.equipment, row.detail.equipment)}, an unexpected but functional tool derived from the source anatomy and character role.` : '',
    c.signature ? `Signature: ${englishDetail('signature', c.signature, row.detail.signature)}, integrated into ${['动物', '神话', '职业'].includes(c.source) ? 'the natural anatomy' : 'the structural surface'} with a believable backstory.` : '',
    c.entity ? `Composition: ${englishDetail('entity', c.entity, row.detail.entity)}, with explicit primary and secondary roles, functional connections and legible assembly relationships.` : '',
    c.physique ? `Silhouette: ${englishDetail('physique', c.physique, row.detail.physique)}, with coherent weight distribution and readable large forms.` : '',
  ].join(' ');
  let en = `Original character concept: ${translate(SOURCE_EN, row.source.name)} ${translate(CONCEPT_EN, row.concept.name)}${row.name.match(/ \d+$/)?.[0] || ''}. A ${translate(SOURCE_EN, row.source.name)} crossed with a ${translate(CONCEPT_EN, row.concept.name)}. Preserve a recognizable source silhouette and reinterpret its signature physical feature as a ${translate(PROP_EN, row.concept.prop)}. Main functional system: ${row.mechanism.en}. ${extrasEn} Design language inspired by ${translate(EN_LABEL, c.concept)}; ${row.personality.en}. ${!fixed ? '' : settings.requirementsEn?.trim() ? `Fixed art direction: ${settings.requirementsEn.trim()}` : fixed === DEFAULT_REQUIREMENTS ? `Premium family-friendly stylized 3D cartoon, ${bodyRatio ? '' : 'approximately 2.5 heads tall, '}simplified rounded geometry, bold readable silhouette, vibrant clean colors, matte materials, soft studio lighting, charming and sophisticated, clear assembly thickness and animation-friendly joints.` : `Fixed art direction: ${settings.requirementsEn?.trim() || fixed}`} ${row.role ? `Narrative role: ${roleEn[row.role] || row.role}.` : ''} ${cardEn} One full-body character, front three-quarter view, complete visible mechanism, believable connections, strong form hierarchy.${row.advanced ? ' Advanced fusion: show stored, activated and released states, driven by one coherent mechanical chain, with a clear dominant body silhouette.' : ''}`;
  if (row.design) {
    cn = [...row.design.sections.map(p => p.zh), row.design.requirements.zh].filter(Boolean).join(' ');
    en = [...row.design.sections.map(p => p.en), row.design.requirements.en].filter(Boolean).join(' ');
    if (row.advanced && row.design.equipment && (row.category.mechanism || row.design.traits.mechanismPrinciple || row.design.traits.mechanismMotion)) { cn += ' 高级融合：展示收纳态、启动态与释放态，以明确的结构链驱动。'; en += ' Advanced fusion: show stored, activated and released states driven by a clear structural chain.'; }
  }
  const translated = row.catalogueSnapshot ? row.translations || [] : settings.rules ? translationsFor({ rules: settings.rules }, c, row.translations) : row.translations || [];
  for (const tag of translated) {
    if (!tag.en) continue;
    en = en.replaceAll(tag.label + '探索者', tag.en + ' explorer').replaceAll(tag.label + '主题装置', tag.en + ' themed device').replaceAll(tag.label, tag.en);
  }
  if (/[\u3400-\u9fff]/.test(en)) en = '英文尚待补齐，请先点击“补齐英文”，再复制或导出。';
  return settings.lang === 'zh' ? cn : settings.lang === 'en' ? en : cn + '\n\n[ENGLISH]\n' + en;
}
export function txtFor(rows: FusionRow[], s: FusionSettings) {
  return rows.map((r, i) => `${i + 1}. ${r.name}\n${CONFIG.filter(c => r.category[c.id]).map(c => `${c.title}：${r.category[c.id]}`).join('\n')}${(r.cards || []).map(c => `\n${c.title}：${c.label}`).join('')}\n连接点：${r.bridge}\n\n${textFor(r, s)}`).join('\n\n────────────────────────────\n\n');
}
export function csvFor(rows: FusionRow[], s: FusionSettings) {
  const quote = (v: string) => '"' + (/^[=+\-@\t\r]/.test(v) ? "'" : '') + v.replace(/"/g, '""') + '"';
  const addons = ADDONS.filter(c => c.id !== 'mechanism' && c.id !== 'personality');
  const columns = new Map<string, { id: string; title: string; frozen: boolean }>();
  for (const row of rows) {
    if (row.catalogueSnapshot) for (const category of row.catalogueSnapshot.categories.filter(category => category.generationKind === 'trait' || row.design?.dynamic?.categories.some(dynamic => dynamic.id === category.id))) columns.set(`${category.id}:${category.nameZh}`, { id: category.id, title: category.nameZh, frozen: true });
    else for (const trait of TRAITS.filter(trait => row.design?.traits[trait.id])) columns.set(`${trait.id}:${trait.title}`, { id: trait.id, title: trait.title, frozen: false });
  }
  const traits = Array.from(columns.values());
  const valueFor = (row: FusionRow, column: typeof traits[number]) => {
    const snapshot = row.catalogueSnapshot;
    if (!snapshot) return row.design?.traits[column.id]?.map(value => value.zh).join('、') || '';
    if (!snapshot.categories.some(category => category.id === column.id && category.nameZh === column.title)) return '';
    return (snapshot.selections[column.id] || []).map(id => snapshot.terms.find(term => term.id === id)?.nameZh || '').join('、');
  };
  return [['名字', '性格', '母体', '跨界概念', '连接点', '机制', ...addons.map(c => c.title), ...traits.map(t => t.title), '完整提示词'], ...rows.map(r => [r.name, r.category.personality, r.source.name, r.concept.name, r.bridge, r.category.mechanism, ...addons.map(c => r.category[c.id]), ...traits.map(t => valueFor(r, t)), textFor(r, s)])].map(row => row.map(quote).join(',')).join('\r\n');
}
