import { englishDetail } from './english';
import { parseCardDraft, cardValues, type FusionCard } from './cards';
import { TRAITS, parseCatalogue, concreteOptions, builtinCatalogue, dynamicPool, dynamicPolicy, validateDynamicGeneration, type CatalogueSettings } from './catalogue';
import { builtinCategoryId, type FusionCategory, type FusionTerm } from './catalogue-model';
import { chooseConcrete, decorateRow, type Design } from './design';
import { BODY_HEAD_RATIO_ID } from './body-cards';
import { choicesConflict, drawChoices } from './selection';
import { CONFIG, DEFAULT_REQUIREMENTS, SOURCES, CONCEPTS, MECHANISMS, PERSONALITIES, LEGACY_TAGS, DETAIL_ALTS, EN_LABEL, SOURCE_EN, CONCEPT_EN, PROP_EN } from './vocabulary';

export { CONFIG, DEFAULT_REQUIREMENTS };
export type Dimension = typeof CONFIG[number]['id'];
export type Tag = { label: string; en?: string; status: 'default' | 'must' | 'exclude' };
export type Categories = Record<Dimension, string>;
export type FusionSettings = {
  rules: Record<Dimension, Tag[]>; requirements: string; count: number; lang: 'zh' | 'en' | 'both';
  boss: Categories; bossLocks: Record<Dimension, boolean>; bossDimensions: Dimension[];
  requirementsEnabled: boolean; requirementsEn: string; cards: FusionCard[]; role: string; catalogue?: CatalogueSettings;
};
type Source = { name: string; shape: string; anchor: string; root: string; en?: string; shapeEn?: string; anchorEn?: string };
type Concept = { name: string; prop: string; mood: string; suffix: string; en?: string; propEn?: string; moodEn?: string };
export type FusionRowCatalogueSnapshot = { formatVersion: 1; catalogueVersion: string; seed: number; engineVersion: string; categories: FusionCategory[]; terms: FusionTerm[];
  selections: Record<string, string[]>; settings?: FusionSettings; settingsRef?: { operationId: string; configurationId: string }; body: { zh: string; en: string } };
export type FusionRow = {
  id: string; name: string; category: Categories; source: Source; concept: Concept; bridge: string;
  mechanism: { cn: string; en: string }; personality: { pose: string; en: string };
  detail: Partial<Record<Dimension, string>>; advanced: boolean; isBoss?: boolean;
  design?: Design;
  translations?: Array<{ dimension: Dimension; label: string; en: string }>;
  role?: string; cards?: Array<{ id: string; title: string; titleEn: string; label: string; en: string; values?: { zh: string; en: string }[]; multi?: boolean }>;
  catalogueSnapshot?: FusionRowCatalogueSnapshot;
};
export const FUSION_ENGINE_VERSION = 'ux14-1';
export const COUNTS = [4, 8, 12, 16, 24, 32];
export const CORE = CONFIG.filter(c => !('optional' in c));
export const ADDONS = CONFIG.filter(c => 'optional' in c);
export const optional = (id: Dimension) => ADDONS.some(c => c.id === id);
export function defaults(): FusionSettings {
  return { rules: Object.fromEntries(CONFIG.map(c => [c.id, c.tags.map(label => ({ label, status: c.id === 'source' && label === '职业' ? 'exclude' : 'default' }))])) as FusionSettings['rules'],
    requirements: DEFAULT_REQUIREMENTS, requirementsEnabled: false, requirementsEn: '', cards: [], role: '', catalogue: { details: {}, traits: { primaryPersonality: { enabled: true, locked: false, values: [], excluded: [], must: [] } } }, count: 16, lang: 'zh',
    boss: { source: '动物', concept: '海洋探索', mechanism: '展开折叠类', personality: '聪明机敏型', equipment: '', signature: '', entity: '', physique: '' },
    bossLocks: Object.fromEntries(CONFIG.map(c => [c.id, false])) as FusionSettings['bossLocks'], bossDimensions: CORE.map(c => c.id) };
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
    if (!Array.isArray(tags) || tags.length > 80 || tags.length < 1 || tags.some(t => !t || typeof t.label !== 'string'
      || !t.label.trim() || t.label.length > 30 || !['default', 'must', 'exclude'].includes(t.status))
      || new Set(tags.map(t => t.label.trim())).size !== tags.length
      || typeof s.boss[c.id] !== 'string' || typeof s.bossLocks[c.id] !== 'boolean') throw new Error(`${c.title}规则无效。`);
    if (tags.some(t => t.en !== undefined && (typeof t.en !== 'string' || t.en.length > 180 || /[\u3400-\u9fff]/.test(t.en)))) throw new Error('英文标签无效。');
    rules[c.id] = tags.map(t => ({ label: t.label.trim(), status: t.status, ...(t.en ? { en: t.en.trim() } : {}) }));
    boss[c.id] = s.boss[c.id]; bossLocks[c.id] = s.bossLocks[c.id];
  }
  if (s.requirementsEnabled !== undefined && typeof s.requirementsEnabled !== 'boolean'
    || s.requirementsEn !== undefined && (typeof s.requirementsEn !== 'string' || s.requirementsEn.length > 10000 || /[\u3400-\u9fff]/.test(s.requirementsEn))
    || s.role !== undefined && !['', '主角', '配角', '伙伴', '反派', 'Boss', '路人'].includes(s.role)
    || s.cards !== undefined && (!Array.isArray(s.cards) || s.cards.length > 16)) throw new Error('扩展卡片或英文设置无效。');
  const cards = (s.cards || []).map(c => {
    const draft = parseCardDraft(c);
    if (!/^card-[a-zA-Z0-9-]{1,80}$/.test(c.id) || typeof c.joined !== 'boolean' || typeof c.locked !== 'boolean' || !draft.tags.some(t => t.label === c.value)) throw new Error('扩展卡片选择无效。');
    if (c.values !== undefined && (!Array.isArray(c.values) || c.values.length > draft.tags.length || new Set(c.values).size !== c.values.length || c.values.some(value => !draft.tags.some(tag => tag.label === value)) || c.values.some((value, i) => c.values!.slice(i + 1).some(other => choicesConflict({ multi: c.multi === true }, value, other))))) throw new Error('扩展卡片多选无效。');
    return { ...draft, id: c.id, joined: c.joined, value: c.value, locked: c.locked, ...(c.values !== undefined ? { values: [...c.values] } : {}) };
  });
  if (new Set(cards.map(c => c.id)).size !== cards.length) throw new Error('扩展卡片重复。');
  return reconcile({ rules, boss, bossLocks, bossDimensions: [...s.bossDimensions], requirements: s.requirements, count: s.count, lang: s.lang,
    requirementsEnabled: s.requirementsEnabled === true, requirementsEn: s.requirementsEn || '', role: s.role || '', cards, catalogue: parseCatalogue(s.catalogue) });
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
    const values = drawChoices(c.tags.filter(t => t.status !== 'exclude').map(t => t.label), { multi: Boolean(c.multi) }, rnd);
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
    const guaranteed = terms.filter(term => (state.locked ? state.values : state.must).includes(term.id)).map(term => term.data!.group);
    if (required(s, dimension.id).some(group => !guaranteed.includes(group))) return `${category.nameZh}的原类别必出项须在词库选择中明确设为本批必出。`;
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
    if (!c.tags.some(t => t.status !== 'exclude')) return `${c.title}已全部排除，请保留一个选项。`;
    const must = c.tags.filter(t => t.status === 'must');
    if (!c.locked && must.length > s.count) return `${c.title}的本批必出项超过生成数量。`;
    if (c.locked && (!cardValues(c).length || cardValues(c).some(value => !c.tags.some(t => t.label === value && t.status !== 'exclude')) || must.some(t => !cardValues(c).includes(t.label)))) return `${c.title}的固定项与规则冲突，请解锁或调整本批必出项。`;
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
export function generateBatch(s: FusionSettings, seed = Date.now()) {
  const error = validateGeneration(s); if (error) throw new Error(error);
  const result: FusionRow[] = [];
  chooseCategories(s, seeded(seed)).forEach((category, i) => {
    const base = chooseConcrete({ ...makeRow(category, seed + i * 257), role: s.role, translations: translationsFor(s, category), cards: cardChoices(s, i, seeded(seed + i)) }, s);
    result.push(freezeRow(uniqueName(decorateRow(base, s, seeded(seed + i * 397), i), result), s, seed + i * 257));
  });
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
    const selected = c.locked ? cardValues(c) : drawChoices(c.tags.filter(t => t.status !== 'exclude').map(t => t.label), { multi: Boolean(c.multi) }, rnd, must[index]?.label);
    const values = selected.map(value => { const tag = c.tags.find(t => t.label === value)!; return { zh: tag.label, en: tag.en }; });
    return { id: c.id, title: c.title, titleEn: c.titleEn, label: values.map(value => value.zh).join('、'), en: values.map(value => value.en).join(', '), ...(c.multi ? { values, multi: true } : {}) };
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
  return rows.map(r => r.id === id ? freezeRow(uniqueName(decorateRow({ ...row, id, advanced: old.advanced, isBoss: old.isBoss, role: old.role, cards, translations: translationsFor(s, category, old.translations) }, s, seeded(seed), 0, false, change ? old.design : undefined), others), change ? originalRowSettings(old) || s : s, seed) : r);
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
      catalogue.dynamic.selections[id] = { enabled: state.enabled && values.length > 0, locked: true, values: [...values], excluded: [], must: [] };
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
  return rows.map(row => row.id === id ? refreshRowSnapshot({ ...next, id, advanced: old.advanced, isBoss: old.isBoss }) : row);
}
function freezeRow(row: FusionRow, settings: FusionSettings, seed: number): FusionRow {
  const builtin = builtinCatalogue(), selections: Record<string, string[]> = {};
  const select = (categoryId: string, labels: string[]) => {
    const ids = builtin.terms.filter(term => term.categoryId === categoryId && labels.includes(term.legacyValue || term.nameZh)).map(term => term.id);
    if (ids.length) selections[categoryId] = ids;
  };
  for (const dimension of CONFIG) select(builtinCategoryId(dimension.id), [dimension.id === 'source' ? row.source.name : dimension.id === 'concept' ? row.concept.name : row.detail[dimension.id] || row.category[dimension.id]]);
  for (const [id, values] of Object.entries(row.design?.traits || {})) select(id, values.map(value => value.zh));
  for (const card of row.cards || []) select(card.id, (card.values || [{ zh: card.label }]).map(value => value.zh));
  Object.assign(selections, row.design?.dynamic?.selections);
  const ids = new Set(Object.values(selections).flat()), categoryIds = new Set(Object.keys(selections));
  const categories = new Map(builtin.categories.filter(category => categoryIds.has(category.id)).map(category => [category.id, category]));
  const terms = new Map(builtin.terms.filter(term => ids.has(term.id)).map(term => [term.id, term]));
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
