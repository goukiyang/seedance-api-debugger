import { CONFIG, SOURCES, CONCEPTS, SOURCE_EN, CONCEPT_EN, LEGACY_TAGS, DETAIL_ALTS } from './vocabulary';
import { englishDetail } from './english';

export type Pair = { zh: string; en: string };
export type TraitState = { enabled: boolean; locked: boolean; values: string[]; excluded: string[]; must: string[] };
export type CatalogueSettings = { details: Partial<Record<string, { value: string; locked: boolean }>>; traits: Record<string, TraitState> };
export type Trait = { id: string; title: string; en: string; group: 'fusion' | 'body' | 'extra'; multi: boolean; options: Pair[] };
const trait = (id: string, title: string, en: string, group: Trait['group'], entries: string, multi = false): Trait => ({ id, title, en, group, multi, options: entries.split(';').map(entry => { const [zh, en] = entry.split('|'); return { zh, en }; }) });

export const TRAITS: Trait[] = [
  trait('primaryPersonality', '主性格', 'Primary personality', 'fusion', '开朗|cheerful;乐观|optimistic;机敏|quick-witted;坚持原则|principled;温柔|gentle;可靠|dependable;外向|extroverted;冷静|calm;理智|rational;好奇|curious;内向|introverted;安静|quiet;幽默|humorous;古怪|eccentric;好胜|competitive;慢热|slow to warm up;谨慎|cautious'),
  trait('mechanismPrinciple', '机制原理', 'Functional principle', 'fusion', '结构变形|structural transformation;生物共生|biological symbiosis;重力作用|gravity manipulation;空间变化|spatial manipulation;能量转换|energy conversion;机械传动|mechanical transmission;磁力作用|magnetic interaction;不强调机制|no emphasized mechanism'),
  trait('mechanismMotion', '动作与结构形式', 'Motion and structural forms', 'fusion', '展开|unfolding;折叠|folding;伸缩|extension and retraction;收纳|stowage;弹射|spring-driven launch;旋转|rotation;牵引|traction;联动|linked motion;拼装|modular assembly;状态切换|state switching', true),
  trait('occupation', '职业与身份', 'Occupation', 'fusion', '邮差|courier;修理匠|repair specialist;烘焙师|baker;园艺师|gardener;医生|doctor;研究员|researcher;探险家|explorer;领航员|navigator;守护者|guardian;商人|merchant;表演者|performer;运动员|athlete;无职业设定|no occupational identity'),
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
  trait('equipmentReach', '道具距离', 'Equipment range', 'extra', '近战|close-range use;远程|ranged use;非战斗|non-combat use'),
  trait('equipmentStructure', '道具结构', 'Equipment structure', 'extra', '复合功能|multiple functions;折叠|folding;伸缩|telescoping;可拆卸|detachable', true),
  trait('signatureArea', '特征部位', 'Signature location', 'extra', '口部|mouth;面部|face;头部|head;躯干|torso;肢体|limbs;末端|extremities;结构表面|structural surface', true),
  trait('signatureKind', '特征类型', 'Signature type', 'extra', '局部缺损|local missing section;伤痕旧迹|old scar;左右不对称|left-right asymmetry;图形斑纹|graphic pattern;修补痕迹|repair marks;表面磨损|surface wear;异色标记|different-colored marking;材质肌理|material texture', true),
];
export const emptyTrait = (): TraitState => ({ enabled: false, locked: false, values: [], excluded: [], must: [] });
export const emptyCatalogue = (): CatalogueSettings => ({ details: {}, traits: {} });
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
  for (const [id, state] of Object.entries(c.traits)) {
    const definition = TRAITS.find(t => t.id === id);
    if (!definition || !state || typeof state.enabled !== 'boolean' || typeof state.locked !== 'boolean') throw new Error('属性选择无效。');
    for (const values of [state.values, state.excluded, state.must]) if (!Array.isArray(values) || values.length > definition.options.length || new Set(values).size !== values.length || values.some(v => !definition.options.some(o => o.zh === v))) throw new Error(`${definition.title}选项无效。`);
    if (!definition.multi && state.values.length > 1 || state.values.some(v => v.startsWith('无')) && state.values.length > 1) throw new Error(`${definition.title}包含互斥选项。`);
    next.traits[id] = { enabled: state.enabled, locked: state.locked, values: [...state.values], excluded: [...state.excluded], must: [...state.must] };
  }
  return next;
}
export function resolveTraits(catalogue: CatalogueSettings | undefined, random: () => number, index: number, manual = false): Record<string, Pair[]> {
  const result: Record<string, Pair[]> = {};
  for (const t of TRAITS) {
    const s = catalogue?.traits[t.id]; if (!s?.enabled) continue;
    const pool = t.options.filter(o => !s.excluded.includes(o.zh));
    let values: string[];
    if ((manual || s.locked) && s.values.length) values = s.values;
    else if (pool.length) {
      const first = s.must[index] || pool[Math.floor(random() * pool.length)].zh;
      values = [first];
      if (t.multi && !first.startsWith('无')) {
        const rest = pool.filter(o => o.zh !== first && !o.zh.startsWith('无'));
        const count = Math.floor(random() * Math.min(3, rest.length + 1));
        for (let i = 0; i < count && rest.length; i++) values.push(rest.splice(Math.floor(random() * rest.length), 1)[0].zh);
      }
    } else values = [];
    result[t.id] = values.map(value => t.options.find(o => o.zh === value)!);
  }
  return result;
}
