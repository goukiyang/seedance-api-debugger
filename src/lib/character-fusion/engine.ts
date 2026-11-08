import { englishDetail } from './english';
import { CONFIG, DEFAULT_REQUIREMENTS, SOURCES, CONCEPTS, MECHANISMS, PERSONALITIES, LEGACY_TAGS, DETAIL_ALTS, EN_LABEL, SOURCE_EN, CONCEPT_EN, PROP_EN } from './vocabulary';

export { CONFIG, DEFAULT_REQUIREMENTS };
export type Dimension = typeof CONFIG[number]['id'];
export type Tag = { label: string; status: 'default' | 'must' | 'exclude' };
export type Categories = Record<Dimension, string>;
export type FusionSettings = {
  rules: Record<Dimension, Tag[]>; requirements: string; count: number; lang: 'zh' | 'en' | 'both';
  boss: Categories; bossLocks: Record<Dimension, boolean>; bossDimensions: Dimension[];
};
type Source = { name: string; shape: string; anchor: string; root: string };
type Concept = { name: string; prop: string; mood: string; suffix: string };
export type FusionRow = {
  id: string; name: string; category: Categories; source: Source; concept: Concept; bridge: string;
  mechanism: { cn: string; en: string }; personality: { pose: string; en: string };
  detail: Partial<Record<Dimension, string>>; advanced: boolean; isBoss?: boolean;
};
export const COUNTS = [4, 8, 12, 16, 24, 32];
export const CORE = CONFIG.filter(c => !('optional' in c));
export const ADDONS = CONFIG.filter(c => 'optional' in c);
export const optional = (id: Dimension) => ADDONS.some(c => c.id === id);
export function defaults(): FusionSettings {
  return { rules: Object.fromEntries(CONFIG.map(c => [c.id, c.tags.map(label => ({ label, status: 'default' }))])) as FusionSettings['rules'],
    requirements: DEFAULT_REQUIREMENTS, count: 16, lang: 'zh',
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
    rules[c.id] = tags.map(t => ({ label: t.label.trim(), status: t.status }));
    boss[c.id] = s.boss[c.id]; bossLocks[c.id] = s.bossLocks[c.id];
  }
  return reconcile({ rules, boss, bossLocks, bossDimensions: [...s.bossDimensions], requirements: s.requirements, count: s.count, lang: s.lang });
}
export const allowed = (s: FusionSettings, id: Dimension) => s.rules[id].filter(t => t.status !== 'exclude').map(t => t.label);
export const required = (s: FusionSettings, id: Dimension) => s.rules[id].filter(t => t.status === 'must').map(t => t.label);
export function reconcile(s: FusionSettings): FusionSettings {
  const next = { ...s, boss: { ...s.boss }, bossLocks: { ...s.bossLocks } };
  for (const c of CONFIG) if (!allowed(s, c.id).includes(s.boss[c.id]) && !(optional(c.id) && s.boss[c.id] === '')) {
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
  return { ...s, boss };
}
export function validateGeneration(s: FusionSettings) {
  for (const c of CONFIG) {
    if (!optional(c.id) && !allowed(s, c.id).length) return `${c.title}已全部排除，请至少保留一个选项。`;
    if (required(s, c.id).length > s.count) return `${c.title}的必须项超过本轮 ${s.count} 条，请增加数量或减少必须项。`;
  }
  return null;
}
export function chooseCategories(s: FusionSettings, rnd: () => number): Categories[] {
  const rows = Array.from({ length: s.count }, () => ({} as Categories));
  for (const c of CONFIG) {
    const pool = allowed(s, c.id), must = shuffled(required(s, c.id), rnd);
    // Cycle source domains before repeating; required tags retain their own slots.
    const sourceCycle = shuffled(pool.filter(v => !must.includes(v)), rnd);
    const values = Array.from({ length: s.count }, (_, i) => {
      if (i < must.length) return must[i];
      if (c.id === 'source') return sourceCycle[i - must.length] || pool[(i - must.length) % pool.length];
      return pool.length && (!optional(c.id) || rnd() < .43) ? pick(pool, rnd) : '';
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
  for (const c of ADDONS) {
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
  return row;
}
export function generateBatch(s: FusionSettings, seed = Date.now()) {
  const error = validateGeneration(s); if (error) throw new Error(error);
  const result: FusionRow[] = [];
  chooseCategories(s, seeded(seed)).forEach((category, i) => result.push(uniqueName(makeRow(category, seed + i * 257), result)));
  return result;
}
export function bossRow(s: FusionSettings, others: FusionRow[], seed = Date.now()) {
  for (const c of CORE) if (!s.bossDimensions.includes(c.id) || !allowed(s, c.id).includes(s.boss[c.id])) throw new Error(`Boss 提示词需要加入并选择${c.title}。`);
  const category = { ...s.boss };
  for (const c of ADDONS) if (!s.bossDimensions.includes(c.id)) category[c.id] = '';
  return { ...uniqueName(makeRow(category, seed), others), isBoss: true };
}
export function missingRequired(s: FusionSettings, rows: FusionRow[]) {
  return CONFIG.flatMap(c => required(s, c.id).filter(label => !rows.some(r => r.category[c.id] === label)).map(label => `${c.title}：${label}`));
}
export function changeRow(s: FusionSettings, rows: FusionRow[], id: string, change?: { dimension: Dimension; value: string }, seed = Date.now()) {
  const error = validateGeneration(s); if (error) throw new Error(error);
  const old = rows.find(r => r.id === id); if (!old) throw new Error('这条提示词已不存在。');
  const others = rows.filter(r => r.id !== id), category = { ...old.category }, rnd = seeded(seed);
  for (const c of CONFIG) {
    if (change && change.dimension !== c.id) continue;
    const soleRequired = required(s, c.id).includes(old.category[c.id]) && !others.some(r => r.category[c.id] === old.category[c.id]);
    if (change) {
      if (!allowed(s, c.id).includes(change.value) && !(optional(c.id) && change.value === '')) throw new Error('该标签已排除。');
      if (soleRequired && old.category[c.id] !== change.value) throw new Error(`「${old.category[c.id]}」是清单中唯一的必须项，请先在另一条使用它。`);
      category[c.id] = change.value;
    } else if (!soleRequired) category[c.id] = optional(c.id) && rnd() > .43 ? '' : pick(allowed(s, c.id), rnd) || '';
  }
  const row = uniqueName(makeRow(category, seed, change ? old : undefined, change?.dimension), others);
  return rows.map(r => r.id === id ? { ...row, id, advanced: old.advanced, isBoss: old.isBoss } : r);
}
export function textFor(row: FusionRow, settings: Pick<FusionSettings, 'requirements' | 'lang'>) {
  const c = row.category;
  const featureAdaptation = ['动物', '神话', '职业'].includes(c.source) ? '保留与母体自然相连的部位' : '把特征放在母体本身合理存在的结构表面';
  const extras = [
    c.equipment ? `道具范围「${c.equipment}」：具体设计为「${row.detail.equipment}」，从${row.source.anchor}的结构特征推导出使用方式，服务于${row.concept.name}的任务，展示意料之外但因果成立的功能设计。` : '',
    c.signature ? `特征范围「${c.signature}」：具体表现为「${row.detail.signature}」，${featureAdaptation}，以具体经历或使用磨损解释其来源，形成自然且可读的辨识点。` : '',
    c.entity ? `组合范围「${c.entity}」：具体设计为「${row.detail.entity}」，明确主次角色、连接关系和拆合时的空间归属。` : '',
    c.physique ? `轮廓范围「${c.physique}」：具体表现为「${row.detail.physique}」，组织大中小体块与重心，让整体剪影一眼可辨。` : '',
  ].join('');
  const cn = `原创角色设计「${row.name}」。以${row.source.name}为母体，保留${row.source.shape}；融合${row.concept.name}的身份，将${row.source.anchor}转化为${row.concept.prop}。核心机制：${row.mechanism.cn}。${extras}视觉语言：${row.concept.mood}，主结构紧凑，形态层级分明。性格「${c.personality}」，通过${row.personality.pose}呈现。${settings.requirements.trim()} 单角色全身设定，三分之四正面视角，完整展示机关的形态、厚度、装配与动作逻辑。${row.advanced ? '高级融合：增加收纳态、启动态与释放态的三阶段变化；关键装置通过一条明确的结构链驱动，动作前后轮廓有强烈辨识度，同时保持角色主体的视觉主导权。' : ''}`;
  const translate = (map: object, value: string) => lookup(map as Record<string, string>, value) || value;
  const extrasEn = [
    c.equipment ? `Equipment: ${englishDetail('equipment', c.equipment, row.detail.equipment)}, an unexpected but functional tool derived from the source anatomy and character role.` : '',
    c.signature ? `Signature: ${englishDetail('signature', c.signature, row.detail.signature)}, integrated into ${['动物', '神话', '职业'].includes(c.source) ? 'the natural anatomy' : 'the structural surface'} with a believable backstory.` : '',
    c.entity ? `Composition: ${englishDetail('entity', c.entity, row.detail.entity)}, with explicit primary and secondary roles, functional connections and legible assembly relationships.` : '',
    c.physique ? `Silhouette: ${englishDetail('physique', c.physique, row.detail.physique)}, with coherent weight distribution and readable large forms.` : '',
  ].join(' ');
  const en = `Original character concept: ${translate(SOURCE_EN, row.source.name)} ${translate(CONCEPT_EN, row.concept.name)}${row.name.match(/ \d+$/)?.[0] || ''}. A ${translate(SOURCE_EN, row.source.name)} crossed with a ${translate(CONCEPT_EN, row.concept.name)}. Preserve a recognizable source silhouette and reinterpret its signature physical feature as a ${translate(PROP_EN, row.concept.prop)}. Main functional system: ${row.mechanism.en}. ${extrasEn} Design language inspired by ${translate(EN_LABEL, c.concept)}; ${row.personality.en}. ${settings.requirements.trim() === DEFAULT_REQUIREMENTS ? 'Premium family-friendly stylized 3D cartoon, approximately 2.5 heads tall, simplified rounded geometry, bold readable silhouette, vibrant clean colors, matte materials, soft studio lighting, charming and sophisticated, clear assembly thickness and animation-friendly joints.' : `Fixed art direction: ${settings.requirements.trim()}`} One full-body character, front three-quarter view, complete visible mechanism, believable connections, strong form hierarchy.${row.advanced ? ' Advanced fusion: show stored, activated and released states, driven by one coherent mechanical chain, with a clear dominant body silhouette.' : ''}`;
  return settings.lang === 'zh' ? cn : settings.lang === 'en' ? en : cn + '\n\n[ENGLISH]\n' + en;
}
export function txtFor(rows: FusionRow[], s: FusionSettings) {
  return rows.map((r, i) => `${i + 1}. ${r.name}\n${CONFIG.filter(c => r.category[c.id]).map(c => `${c.title}：${r.category[c.id]}`).join('\n')}\n连接点：${r.bridge}\n\n${textFor(r, s)}`).join('\n\n────────────────────────────\n\n');
}
export function csvFor(rows: FusionRow[], s: FusionSettings) {
  const quote = (v: string) => '"' + (/^[=+\-@\t\r]/.test(v) ? "'" : '') + v.replace(/"/g, '""') + '"';
  return [['名字', '性格', '母体', '跨界概念', '连接点', '机制', ...ADDONS.map(c => c.title), '完整提示词'], ...rows.map(r => [r.name, r.category.personality, r.source.name, r.concept.name, r.bridge, r.category.mechanism, ...ADDONS.map(c => r.category[c.id]), textFor(r, s)])].map(row => row.map(quote).join(',')).join('\r\n');
}
