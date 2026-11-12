import { CONFIG, SOURCES, CONCEPTS, SOURCE_EN, CONCEPT_EN, PROP_EN, EN_LABEL, LEGACY_TAGS, DETAIL_ALTS } from './vocabulary';
import { englishDetail } from './english';
import { choicesConflict, drawChoices, type SelectionPolicy } from './selection';
import { NO_CHOICES } from './selection';
import { BODY_CARDS } from './body-cards';
import { builtinCategoryId, builtinTermId, FUSION_CATALOGUE_VERSION, parseFusionCatalogue, type FusionCatalogue, type FusionCategory, type FusionTerm } from './catalogue-model';
import type { FusionSettings } from './engine';

export type Pair = { zh: string; en: string; termId?: string; descriptionZh?: string; descriptionEn?: string };
export type TraitState = { enabled: boolean; locked: boolean; values: string[]; excluded: string[]; must: string[] };
export type DynamicTraitState = TraitState & { candidates?: string[] };
export type DynamicCatalogueSettings = { formatVersion: 1; selections: Record<string, DynamicTraitState>; snapshot: FusionCatalogue };
export type CatalogueSettings = { details: Partial<Record<string, { value: string; locked: boolean }>>; traits: Record<string, TraitState>; sourceFusion?: TraitState; dynamic?: DynamicCatalogueSettings };
export type Trait = SelectionPolicy & { id: string; title: string; en: string; group: 'fusion' | 'body' | 'extra'; options: Pair[] };
const trait = (id: string, title: string, en: string, group: Trait['group'], entries: string, multi = false): Trait => ({ id, title, en, group, multi, randomMax: ['occupation', 'mechanismPrinciple', 'equipmentReach'].includes(id) ? 1 : multi ? 3 : 1,
  ...(id === 'assembly' ? { incompatible: [['独立站位', '并体融合'], ['独立站位', '骑乘共体']] as [string, string][] } : {}), options: entries.split(';').map(entry => { const [zh, en] = entry.split('|'); return { zh, en }; }) });

export const TRAITS: Trait[] = [
  trait('primaryPersonality', '主性格', 'Primary personality', 'fusion', '开朗|cheerful;乐观|optimistic;机敏|quick-witted;坚持原则|principled;温柔|gentle;可靠|dependable;外向|extroverted;冷静|calm;理智|rational;好奇|curious;内向|introverted;安静|quiet;幽默|humorous;古怪|eccentric;好胜|competitive;慢热|slow to warm up;谨慎|cautious'),
  trait('mechanismPrinciple', '机制原理', 'Functional principle', 'fusion', '结构变形|structural transformation;生物共生|biological symbiosis;重力作用|gravity manipulation;空间变化|spatial manipulation;能量转换|energy conversion;机械传动|mechanical transmission;磁力作用|magnetic interaction;不强调机制|no emphasized mechanism', true),
  trait('mechanismMotion', '动作与结构形式', 'Motion and structural forms', 'fusion', '展开|unfolding;折叠|folding;伸缩|extension and retraction;收纳|stowage;弹射|spring-driven launch;旋转|rotation;牵引|traction;联动|linked motion;拼装|modular assembly;状态切换|state switching', true),
  trait('occupation', '职业与身份', 'Occupation', 'fusion', '邮差|courier;修理匠|repair specialist;烘焙师|baker;园艺师|gardener;医生|doctor;研究员|researcher;探险家|explorer;领航员|navigator;守护者|guardian;商人|merchant;表演者|performer;运动员|athlete;无职业设定|no occupational identity', true),
  trait('culture', '文化语境', 'Cultural context', 'fusion', '远古文明|ancient civilization;街头文化|street culture;节庆民俗|festival folklore;美食文化|food culture;戏曲|Chinese opera', true),
  trait('world', '世界背景', 'World setting', 'fusion', '海洋|ocean world;深海|deep-sea world;太空|outer space;森林|forest;梦境|dream world;童话|fairy-tale world', true),
  trait('activity', '活动主题', 'Activity', 'fusion', '探索|exploration;科研|scientific research;竞技运动|competitive sport;旅行|travel;生活日常|everyday life', true),
  trait('technology', '科技语境', 'Technology', 'fusion', '蒸汽科技|steam technology;发条机械|clockwork technology;磁力科技|magnetic technology;生物科技|biotechnology;无科技设定|no technological setting', true),
  trait('temperament', '补充性格', 'Additional personality', 'fusion', '温柔|gentle;好胜|competitive;内向|introverted;外向|extroverted;害羞|shy;好奇|curious;谨慎|cautious;幽默|humorous;古怪|eccentric;固执|stubborn;坚持原则|principled;理智|rational;爱炫耀|showy;慢热|slow to warm up;勇敢|brave', true),
  trait('contrast', '反差组合', 'Personality contrast', 'fusion', '胆小但勇敢|timid yet brave;外冷内热|reserved on the outside and warm within;温柔但好胜|gentle yet competitive;严肃但幽默|serious yet humorous;莽撞但细心|impulsive yet attentive;无反差设定|no deliberate personality contrast'),
  trait('headRatio', '头身比', 'Head-to-body ratio', 'body', '1.5–2头身|1.5–2 head lengths tall;2–3头身|2–3 head lengths tall;3–4头身|3–4 head lengths tall;4–5头身|4–5 head lengths tall;5–6头身|5–6 head lengths tall;6–8头身|6–8 head lengths tall;8+头身|8 or more head lengths tall'),
  trait('silhouette', '主体轮廓', 'Main silhouette', 'body', '圆球|spherical;倒三角|inverted triangle;梨形|pear-shaped;桶形|barrel-shaped;沙漏|hourglass;水滴|teardrop-shaped;锥形|cone-shaped;弧形|curved;方形|box-shaped'),
  trait('stature', '高矮与胖瘦', 'Stature and body mass', 'body', '矮胖|short and stout;瘦小|small and slender;瘦长|tall and slender;匀称|balanced proportions;高壮|tall and stocky'),
  trait('build', '肌肉量', 'Muscular build', 'body', '纤细|delicate build;适中|moderate muscular build;壮硕|powerfully built'),
  trait('torsoLength', '躯干长度', 'Torso length', 'body', '长躯|long torso;短躯|short torso;常规躯干|regular torso length'),
  trait('armLength', '手臂长度', 'Arm length', 'body', '长臂|long arms;短臂|short arms;常规手臂|regular arm length'),
  trait('legLength', '腿部长度', 'Leg length', 'body', '长腿|long legs;短腿|short legs;常规腿长|regular leg length'),
  trait('shoulderHips', '肩胯关系', 'Shoulder-to-hip proportions', 'body', '宽肩窄胯|broad shoulders and narrow hips;窄肩宽胯|narrow shoulders and broad hips;肩胯等宽|equal shoulder and hip widths'),
  trait('headBody', '头身连接', 'Head and torso connection', 'body', '头身一体|continuous head-and-body form;头身分明|distinct head and torso'),
  trait('exaggeration', '夸张部位', 'Exaggerated parts', 'body', '巨头|oversized head;巨肩|oversized shoulders;巨胸|oversized chest;巨腹|oversized belly;巨臂|oversized arms;巨掌|oversized palms;巨腿|oversized legs;巨脚|oversized feet;无|no exaggerated body part', true),
  trait('deformation', '变形方式', 'Deformation approach', 'body', '畸变|deliberate shape distortion;拉伸|elongation;压缩|compression;无变形|no deliberate distortion'),
  trait('distribution', '上下体量', 'Upper and lower body mass', 'body', '上大下小|large upper and small lower body;上小下大|small upper and large lower body;上下均衡|balanced upper and lower body'),
  trait('shoulderFeet', '肩脚对比', 'Shoulder-to-foot width', 'body', '宽肩窄脚|broad shoulders and narrow feet;窄肩宽脚|narrow shoulders and broad feet;肩脚均衡|balanced shoulder and foot widths'),
  trait('center', '重心位置', 'Center of mass', 'body', '低重心|low center of mass;居中重心|centered mass;高重心|high center of mass'),
  trait('symmetry', '轮廓对称性', 'Silhouette symmetry', 'body', '左右对称|left-right symmetry;左右不对称|left-right asymmetry'),
  trait('narrative', '叙事地位', 'Narrative prominence', 'extra', '主角|protagonist;配角|supporting character;路人|background character'),
  trait('allegiance', '故事立场', 'Story alignment', 'extra', '正面角色|heroic character;反派|antagonist;中立|neutral character;立场变化|changing alignment'),
  trait('relationship', '角色关系', 'Character relationships', 'extra', '伙伴|companion;主从|leader and follower;共生|symbiotic partners;亲子|parent and child;镜像|mirrored partners;骑乘|rider and mount', true),
  trait('gameRole', '关卡职能', 'Game encounter role', 'extra', 'Boss|boss encounter;精英|elite encounter;普通单位|regular unit;非战斗角色|non-combat character'),
  trait('bodyCount', '主体数量', 'Number of characters', 'extra', '单体|one character;双体|two characters;三体|three characters;多体群组|a group of characters'),
  trait('assembly', '连接与拆合', 'Connections and assembly', 'extra', '并体融合|fused bodies;上下叠合|vertically stacked;分体重组|separable and recombinable;套叠结构|nested structures;骑乘共体|rider and mount sharing a structure;双面结构|two-sided structure;对称关联|symmetrically linked;独立站位|independent placement', true),
  trait('consciousness', '意识数量', 'Number of minds', 'extra', '单一意识|one mind;双意识共体|two minds in one body;多意识共体|multiple minds in one body'),
  trait('equipmentPolicy', '道具方式', 'Prop policy', 'extra', '自动关联|theme-related props;无道具|no external props'),
  trait('equipmentUse', '道具用途', 'Equipment purpose', 'extra', '防护|protection;辅助工具|assistance;反馈|feedback;解锁|unlocking;探索|exploration;移动|locomotion;导航|navigation;生活|everyday use;收纳携行|storage and carrying', true),
  trait('equipmentReach', '道具距离', 'Equipment range', 'extra', '近战|close-range use;远程|ranged use;非战斗|non-combat use', true),
  trait('equipmentStructure', '道具结构', 'Equipment structure', 'extra', '复合功能|multiple functions;折叠|folding;伸缩|telescoping;可拆卸|detachable', true),
  trait('signatureArea', '特征部位', 'Signature location', 'extra', '口部|mouth;面部|face;头部|head;躯干|torso;肢体|limbs;末端|extremities;结构表面|structural surface', true),
  trait('signatureKind', '特征类型', 'Signature type', 'extra', '局部缺损|local missing section;伤痕旧迹|old scar;左右不对称|left-right asymmetry;图形斑纹|graphic pattern;修补痕迹|repair marks;表面磨损|surface wear;异色标记|different-colored marking;材质肌理|material texture', true),
];
export const emptyTrait = (): TraitState => ({ enabled: false, locked: false, values: [], excluded: [], must: [] });
export const emptyCatalogue = (): CatalogueSettings => ({ details: {}, traits: {} });
export const sourceFusionOptions = (): Pair[] => Object.keys(SOURCES).flatMap(group => concreteOptions('source', group));
export const displayGroup = (label: string) => ({ '植物': '植物与菌菇', '乐器': '乐器与声音设备', '神话': '神话生灵', '工业': '工业装置', '天文': '天体与天象', '职业': '职业母体（原有选项）', '土星环': '土星环（带环行星原型）' }[label] || label);
export function concreteOptions(id: string, category: string): Pair[] {
  if (id === 'source') return ((SOURCES as Record<string, Array<{ name: string }>>)[category] || []).map(x => ({ zh: x.name, en: (SOURCE_EN as Record<string, string>)[x.name] }));
  if (id === 'concept') return ((CONCEPTS as Record<string, Array<{ name: string }>>)[category] || []).map(x => ({ zh: x.name, en: (CONCEPT_EN as Record<string, string>)[x.name] }));
  const config = CONFIG.find(c => c.id === id), index = config ? (config.tags as readonly string[]).indexOf(category) : -1;
  const original = (LEGACY_TAGS as Record<string, string[]>)[id]?.[index];
  if (!original || id === 'mechanism' || id === 'personality') return [];
  return [original, (DETAIL_ALTS as Record<string, string[]>)[id]?.[index]].filter(Boolean).map(zh => ({ zh, en: englishDetail(id as 'equipment', category, zh) }));
}
export function parseCatalogue(input: unknown): CatalogueSettings {
  if (input === undefined) return emptyCatalogue();
  const c = input as CatalogueSettings;
  if (!c || typeof c !== 'object' || !c.details || !c.traits || typeof c.details !== 'object' || typeof c.traits !== 'object' || Array.isArray(c.details) || Array.isArray(c.traits)) throw new Error('分类选择无效。');
  const next = emptyCatalogue();
  for (const [id, detail] of Object.entries(c.details)) {
    if (!CONFIG.some(d => d.id === id) || !detail || typeof detail.value !== 'string' || typeof detail.locked !== 'boolean' || !CONFIG.some(d => d.id === id && d.tags.some(label => concreteOptions(id, label).some(o => o.zh === detail.value)))) throw new Error('具体选项已失效，请重新选择。');
    next.details[id] = { value: detail.value, locked: detail.locked };
  }
  const invalidTraits: Array<{ path: string[]; title: string; fields: string[]; options?: string[]; multi?: boolean }> = [];
  for (const [id, state] of Object.entries(c.traits)) {
    const definition = TRAITS.find(t => t.id === id);
    const path = ['catalogue', 'traits', id.slice(0, 120)], fields: string[] = [];
    if (!definition) { invalidTraits.push({ path, title: '未识别属性', fields: ['该key不是原生trait ID；按controls的真实selectionPath写入，不用中文名或自造ID'] }); continue; }
    if (!state || typeof state.enabled !== 'boolean') fields.push('enabled须为boolean，不能缺失');
    if (!state || typeof state.locked !== 'boolean') fields.push('locked须为boolean，不能缺失');
    for (const [field, values] of Object.entries({ values: state?.values, excluded: state?.excluded, must: state?.must })) {
      if (!Array.isArray(values)) fields.push(`${field}须为数组，不能缺失`);
      else if (values.length > definition.options.length || new Set(values).size !== values.length || values.some(v => !definition.options.some(o => o.zh === v))) fields.push(`${field}只能使用不重复的合法中文选项，不能用termId、英文或自造值`);
    }
    if (!fields.length && state.values.some((value, i) => state.values.slice(i + 1).some(other => choicesConflict({ ...definition, incompatible: undefined }, value, other)))) fields.push('values包含互斥选项；按multi选择合法组合');
    if (fields.length) { invalidTraits.push({ path, title: definition.title, fields, options: definition.options.map(option => option.zh), multi: definition.multi }); continue; }
    next.traits[id] = { enabled: state.enabled, locked: state.locked, values: [...state.values], excluded: [...state.excluded], must: [...state.must] };
  }
  if (invalidTraits.length) {
    const shown = invalidTraits.slice(0, 12), describe = () => JSON.stringify({ invalidTraits: shown, remaining: invalidTraits.length - shown.length,
      shape: { enabled: true, locked: false, values: [], excluded: [], must: [] },
      ...(invalidTraits.some(item => item.title === '未识别属性') ? { validTraitIds: TRAITS.map(trait => `${trait.id}(${trait.title})`) } : {}),
      instruction: '未配置的属性须在selectionPath提交完整shape；已有属性才局部改字段。shape仅示例，按原意设置values/locked，保其它设置、锁/池/排除，不自动补默认值。原生选项用中文；动态类别用真实selectionPath和termId。' });
    while (describe().length > 6000 && shown.length > 1) shown.pop();
    const names = Array.from(new Set(invalidTraits.slice(0, 3).map(item => item.title))).join('、');
    throw Object.assign(new Error(`${names}${invalidTraits.length > 1 ? `等${invalidTraits.length}项` : ''}属性设置不完整或与目录不匹配，请重新选择相关属性；原输入与结果保留。`), { proposalError: describe() });
  }
  if (c.sourceFusion !== undefined) {
    const state = c.sourceFusion, options = sourceFusionOptions();
    if (!state || typeof state.enabled !== 'boolean' || typeof state.locked !== 'boolean') throw new Error('辅助母体设置无效。');
    for (const values of [state.values, state.excluded, state.must]) if (!Array.isArray(values) || values.length > options.length || new Set(values).size !== values.length || values.some(value => !options.some(option => option.zh === value))) throw new Error('辅助母体选项无效。');
    next.sourceFusion = { enabled: state.enabled, locked: state.locked, values: [...state.values], excluded: [...state.excluded], must: [...state.must] };
  }
  if (c.dynamic !== undefined) next.dynamic = parseDynamicCatalogue(c.dynamic);
  return next;
}
export function resolveTraits(catalogue: CatalogueSettings | undefined, random: () => number, index: number, _manual = false, dynamic = resolveDynamicTraits(catalogue, random, index)): Record<string, Pair[]> {
  const result: Record<string, Pair[]> = {};
  for (const t of TRAITS) {
    if (catalogue?.dynamic?.selections[t.id]) continue;
    const s = catalogue?.traits[t.id]; if (!s?.enabled) continue;
    const pool = t.options.filter(o => !s.excluded.includes(o.zh));
    let values: string[];
    if (s.locked && s.values.length) values = s.values;
    else if (pool.length) {
      values = drawChoices(pool.map(option => option.zh), t, random, s.must[index]);
    } else values = [];
    result[t.id] = values.map(value => t.options.find(o => o.zh === value)!);
  }
  for (const { category, terms } of Object.values(dynamic)) if (category.generationKind === 'trait') result[category.legacyId || category.id] = terms.map(termPair);
  return result;
}

/** Adapter only: the original lists and handlers remain the authority for built-ins. */
export function builtinCatalogue(): FusionCatalogue {
  const categories: FusionCategory[] = [], terms: FusionTerm[] = [];
  const common = { version: '1', enabled: true, scope: 'builtin' as const, ownerId: null, aliases: [] as string[], tags: [] as string[] };
  const add = (category: FusionCategory, options: Pair[], groupFor?: (label: string) => string) => {
    categories.push(category);
    options.forEach((option, index) => {
      const group = groupFor?.(option.zh);
      const source = category.generationKind === 'source' ? Object.values(SOURCES).flat().find(source => source.name === option.zh) : undefined;
      const concept = category.generationKind === 'concept' ? Object.values(CONCEPTS).flat().find(concept => concept.name === option.zh) : undefined;
      terms.push({ ...common, id: builtinTermId(category.id, option.zh), categoryId: category.id, nameZh: option.zh, nameEn: option.en,
        descriptionZh: option.zh, descriptionEn: option.en, legacyValue: option.zh, sortOrder: index, ...(group ? { data: { group,
          ...(source ? { source: { shape: source.shape, shapeEn: `a recognizable ${option.en} silhouette`, anchor: source.anchor, anchorEn: `the distinctive physical feature of the ${option.en}`, root: source.root } } : {}),
          ...(concept ? { concept: { prop: concept.prop, propEn: (PROP_EN as Record<string, string>)[concept.prop] || 'a theme-related prop', mood: concept.mood, moodEn: `visual motifs associated with ${option.en}`, suffix: concept.suffix } } : {}) } } : {}) });
    });
  };
  for (const dimension of CONFIG) {
    const id = builtinCategoryId(dimension.id);
    const options = dimension.tags.flatMap(label => concreteOptions(dimension.id, label));
    const unique = options.filter((option, i) => options.findIndex(value => value.zh === option.zh) === i);
    add({ ...common, id, legacyId: dimension.id, nameZh: dimension.title, nameEn: dimension.id, descriptionZh: dimension.title, descriptionEn: dimension.id,
      sortOrder: categories.length, group: 'fusion', multi: false, randomMax: 1, generationKind: dimension.id },
    unique.length ? unique : dimension.tags.map(label => ({ zh: label, en: (EN_LABEL as Record<string, string>)[label] || dimension.english.toLowerCase() })),
    label => dimension.tags.find(group => concreteOptions(dimension.id, group).some(option => option.zh === label)) || label);
  }
  for (const definition of TRAITS) add({ ...common, id: definition.id, legacyId: definition.id, nameZh: definition.title, nameEn: definition.en, descriptionZh: definition.title, descriptionEn: definition.en,
    sortOrder: categories.length, group: definition.group, multi: definition.multi, randomMax: definition.randomMax || 1, generationKind: 'trait',
    exclusive: (definition.exclusive || NO_CHOICES).filter(label => definition.options.some(option => option.zh === label)).map(label => builtinTermId(definition.id, label)),
    incompatible: (definition.incompatible || []).map(([a, b]) => [builtinTermId(definition.id, a), builtinTermId(definition.id, b)]) }, definition.options);
  for (const card of BODY_CARDS) add({ ...common, id: card.id, legacyId: card.id, nameZh: card.title, nameEn: card.titleEn, descriptionZh: card.title, descriptionEn: card.titleEn,
    sortOrder: categories.length, group: 'body', multi: Boolean(card.multi), randomMax: card.multi ? 3 : 1, generationKind: 'body-card',
    exclusive: card.tags.filter(tag => NO_CHOICES.includes(tag.label)).map(tag => builtinTermId(card.id, tag.label)) }, card.tags.map(tag => ({ zh: tag.label, en: tag.en })));
  return { version: FUSION_CATALOGUE_VERSION, categories, terms };
}

export function parseDynamicCatalogue(input: unknown): DynamicCatalogueSettings {
  const value = input as DynamicCatalogueSettings;
  if (!value || typeof value !== 'object' || value.formatVersion !== 1 || !value.selections || typeof value.selections !== 'object' || Array.isArray(value.selections)) throw new Error('此词库引用格式暂不支持，请保留草稿并刷新页面。');
  const snapshot = parseFusionCatalogue(value.snapshot), selections: Record<string, DynamicTraitState> = {};
  for (const [id, state] of Object.entries(value.selections)) {
    const category = snapshot.categories.find(category => category.id === id);
    if (!category || !state || typeof state !== 'object' || typeof state.enabled !== 'boolean' || typeof state.locked !== 'boolean') throw new Error('动态类别选择无效，原内容仍保留。');
    const terms = snapshot.terms.filter(term => term.categoryId === id), ids = new Set(terms.map(term => term.id));
    for (const list of [state.values, state.excluded, state.must, ...(state.candidates !== undefined ? [state.candidates] : [])]) {
      if (!Array.isArray(list) || list.length > ids.size || new Set(list).size !== list.length || list.some(termId => typeof termId !== 'string' || !ids.has(termId))) throw new Error(`${category.nameZh}包含未知词条引用，请刷新目录后处理。`);
    }
    selections[id] = { enabled: state.enabled, locked: state.locked, values: [...state.values], excluded: [...state.excluded], must: [...state.must], ...(state.candidates !== undefined ? { candidates: [...state.candidates] } : {}) };
  }
  return { formatVersion: 1, selections, snapshot };
}

/** Call with the fresh, permission-filtered server catalogue before creating new results. */
export function hydrateCatalogueSettings(settings: CatalogueSettings, catalogue: FusionCatalogue, context?: FusionSettings): CatalogueSettings {
  const next = parseCatalogue(settings);
  const fresh = parseFusionCatalogue(catalogue);
  if (context) {
    const builtin = builtinCatalogue();
    const selections = next.dynamic?.selections || {};
    for (const category of fresh.categories.filter(category => category.scope === 'builtin' && !selections[category.id])) {
      const original = builtin.categories.find(original => original.id === category.id);
      const terms = fresh.terms.filter(term => term.categoryId === category.id), oldTerms = builtin.terms.filter(term => term.categoryId === category.id);
      if (!original || stableCatalogueValue(category) === stableCatalogueValue(original) && stableCatalogueValue(terms) === stableCatalogueValue(oldTerms)) continue;
      const ids = (labels: string[]) => labels.map(label => terms.find(term => (term.legacyValue || term.nameZh) === label)?.id).map((id, index) => {
        if (!id) throw new Error(`${category.nameZh}的原选择「${labels[index]}」无法读取，请保留草稿并调整。`);
        return id;
      });
      if (category.generationKind === 'trait') {
        const state = next.traits[category.legacyId || category.id]; if (!state?.enabled) continue;
        selections[category.id] = { ...state, values: ids(state.values), excluded: ids(state.excluded), must: ids(state.must) };
      } else if (category.generationKind === 'body-card') {
        const card = context.cards.find(card => card.id === category.legacyId && card.joined); if (!card) continue;
        selections[category.id] = { enabled: true, locked: card.locked, values: ids(card.values || [card.value]), excluded: ids(card.tags.filter(tag => tag.status === 'exclude').map(tag => tag.label)), must: ids(card.tags.filter(tag => tag.status === 'must').map(tag => tag.label)),
          candidates: ids(card.tags.filter(tag => tag.status !== 'exclude').map(tag => tag.label)).filter(id => terms.find(term => term.id === id)?.enabled) };
      } else {
        const dimension = CONFIG.find(dimension => dimension.id === category.generationKind); if (!dimension || !context.bossDimensions.includes(dimension.id)) continue;
        const propPolicy = next.traits.equipmentPolicy, dynamicProps = selections.equipmentPolicy;
        const noProps = propPolicy?.enabled && propPolicy.locked && propPolicy.values.includes('无道具') || dynamicProps?.enabled && dynamicProps.locked && dynamicProps.values.some(id => fresh.terms.some(term => term.id === id && (term.legacyValue || term.nameZh) === '无道具'));
        if (dimension.id === 'equipment' && noProps) continue;
        if (dimension.id === 'personality' && (next.dynamic?.selections.primaryPersonality?.enabled || next.traits.primaryPersonality?.enabled)
          || dimension.id === 'mechanism' && ['mechanismPrinciple', 'mechanismMotion'].some(id => next.dynamic?.selections[id]?.enabled || next.traits[id]?.enabled)
          || dimension.id === 'physique' && (TRAITS.some(trait => trait.group === 'body' && next.traits[trait.id]?.enabled) || context.cards.some(card => card.joined && card.id.startsWith('card-body-')))
          || dimension.id === 'entity' && ['bodyCount', 'assembly', 'relationship', 'consciousness'].some(id => next.dynamic?.selections[id]?.enabled || next.traits[id]?.enabled)
          || dimension.id === 'signature' && ['signatureArea', 'signatureKind'].some(id => next.dynamic?.selections[id]?.enabled || next.traits[id]?.enabled)) continue;
        const allowed = context.rules[dimension.id].filter(tag => tag.status !== 'exclude').map(tag => tag.label);
        const candidates = terms.filter(term => term.enabled && allowed.includes(term.data!.group!) && (!context.bossLocks[dimension.id] || term.data!.group === context.boss[dimension.id])).map(term => term.id);
        const detail = next.details[dimension.id];
        const must = context.rules[dimension.id].filter(tag => tag.status === 'must').map(tag => {
          const term = terms.find(term => term.data!.group === tag.label && term.enabled && candidates.includes(term.id));
          if (!term) throw new Error(`${category.nameZh}的必出类别「${tag.label}」没有可用词条。`);
          return term.id;
        });
        selections[category.id] = { enabled: true, locked: Boolean(detail?.locked), values: detail ? ids([detail.value]) : [], excluded: terms.filter(term => !allowed.includes(term.data!.group!)).map(term => term.id), must, candidates };
        delete next.details[dimension.id];
      }
    }
    if (Object.keys(selections).length) next.dynamic = { formatVersion: 1, selections, snapshot: fresh };
  }
  if (!next.dynamic) return next;
  const selectedIds = Object.keys(next.dynamic.selections);
  for (const id of selectedIds) {
    const state = next.dynamic.selections[id], category = fresh.categories.find(category => category.id === id);
    if (!category || state.enabled && !category.enabled) throw new Error('所选类别已停用或无权读取，请保留草稿并调整选择。');
    const terms = fresh.terms.filter(term => term.categoryId === id), ids = new Set(terms.map(term => term.id));
    if ([...state.values, ...state.excluded, ...state.must, ...(state.candidates || [])].some(termId => !ids.has(termId))) throw new Error(`${category.nameZh}的引用已失效或无权读取，请调整选择。`);
    const active = [...(state.locked ? state.values : state.candidates || []), ...state.must];
    if (state.enabled && active.some(termId => !terms.find(term => term.id === termId)?.enabled)) throw new Error(`${category.nameZh}包含已停用的选择，请调整后再生成。`);
  }
  next.dynamic.snapshot = { version: fresh.version, categories: fresh.categories.filter(category => selectedIds.includes(category.id)), terms: fresh.terms.filter(term => selectedIds.includes(term.categoryId)) };
  return parseCatalogue(next);
}

function stableCatalogueValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCatalogueValue).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableCatalogueValue(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export const dynamicPolicy = (category: FusionCategory, terms: FusionTerm[]): SelectionPolicy => ({ multi: ['trait', 'body-card'].includes(category.generationKind) && category.multi, randomMax: category.randomMax,
  exclusive: [...(category.exclusive || []), ...terms.filter(term => NO_CHOICES.includes(term.legacyValue || term.nameZh)).map(term => term.id)], incompatible: category.incompatible });
export const dynamicPool = (category: FusionCategory, state: DynamicTraitState, terms: FusionTerm[]) => terms.filter(term => category.enabled && term.enabled && !state.excluded.includes(term.id) && (state.candidates === undefined || state.candidates.includes(term.id)));
export const termPair = (term: FusionTerm): Pair => ({ zh: term.legacyValue || term.nameZh, en: term.nameEn, termId: term.id, descriptionZh: term.descriptionZh, descriptionEn: term.descriptionEn });
export function resolveDynamicTraits(settings: CatalogueSettings | undefined, random: () => number, index: number, groups?: Record<string, string>): Record<string, { category: FusionCategory; terms: FusionTerm[] }> {
  const dynamic = settings?.dynamic, result: Record<string, { category: FusionCategory; terms: FusionTerm[] }> = {};
  if (!dynamic) return result;
  for (const [id, state] of Object.entries(dynamic.selections)) {
    if (!state.enabled) continue;
    const category = dynamic.snapshot.categories.find(category => category.id === id)!;
    const terms = dynamic.snapshot.terms.filter(term => term.categoryId === id);
    let pool = dynamicPool(category, state, terms);
    const group = groups?.[category.generationKind];
    if (group && !state.locked && !state.must[index] && !['trait', 'body-card'].includes(category.generationKind)) {
      pool = pool.filter(term => term.data?.group === group);
      if (!pool.length) throw new Error(`${category.nameZh}在当前类别内没有可用词条，请调整类别或候选范围。`);
    }
    const selected = state.locked ? state.values : drawChoices(pool.map(term => term.id), dynamicPolicy(category, terms), random, state.must[index]);
    result[id] = { category, terms: selected.map(id => terms.find(term => term.id === id)!) };
  }
  return result;
}

export function validateDynamicGeneration(settings: CatalogueSettings | undefined, count: number): string | null {
  const dynamic = settings?.dynamic;
  if (!dynamic) return null;
  for (const [id, state] of Object.entries(dynamic.selections)) {
    if (!state.enabled) continue;
    const category = dynamic.snapshot.categories.find(category => category.id === id)!;
    const terms = dynamic.snapshot.terms.filter(term => term.categoryId === id), pool = dynamicPool(category, state, terms), ids = pool.map(term => term.id);
    if (!category.enabled) return `${category.nameZh}已停用，请调整后生成。`;
    if (!pool.length) return `${category.nameZh}没有可生成的候选，请调整候选或排除项。`;
    if (!state.locked && state.must.length > count) return `${category.nameZh}本批必出项超过生成数量。`;
    if (state.must.some(id => !ids.includes(id))) return `${category.nameZh}的必出项不在有效候选范围内。`;
    if (state.locked && (!state.values.length || state.values.some(id => !ids.includes(id)) || state.must.some(id => !state.values.includes(id)))) return `${category.nameZh}的固定组合与候选或排除规则冲突。`;
    if (state.locked && state.values.some((value, index) => state.values.slice(index + 1).some(other => choicesConflict(dynamicPolicy(category, terms), value, other)))) return `${category.nameZh}固定组合包含互斥词条，请调整后生成。`;
  }
  return null;
}
