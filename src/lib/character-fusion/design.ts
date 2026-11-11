import type { FusionRow, FusionSettings, Dimension } from './engine';
import { TRAITS, resolveTraits, resolveDynamicTraits, type Pair } from './catalogue';
import { CONFIG, DEFAULT_REQUIREMENTS, SOURCE_EN, CONCEPT_EN, PROP_EN, EN_LABEL, SOURCES, CONCEPTS } from './vocabulary';
import { englishDetail } from './english';
import { drawChoices } from './selection';
import type { FusionCategory, FusionTerm } from './catalogue-model';

export type DesignCatalogueSnapshot = { version: string; categories: FusionCategory[]; terms: FusionTerm[]; selections: Record<string, string[]> };
export type Design = { sections: Pair[]; chosen?: Record<string, Pair[]>; traits: Record<string, Pair[]>; requirements: Pair; equipment: boolean; bodies: string; sources?: Pair[]; dynamic?: DesignCatalogueSnapshot };
const pair = (zh: string, en: string): Pair => ({ zh, en });
const sourceShapes: Record<string, string> = Object.fromEntries(`海獭|round face, broad palms and a short streamlined body
蜗牛|rounded spiral shell and short soft antennae
企鹅|teardrop body and short flippers
穿山甲|overlapping armor scales and a low center of mass
水豚|a rounded rectangular torso and a calm face
螃蟹|a broad lateral shell and exaggerated claws
蒲公英|a spherical fluffy crown and a slender stem body
仙人掌|a column-shaped trunk and short branching arms
松果|overlapping oval scales
蘑菇|a broad cap and a compact stalk
老式怀表|a circular body and an exposed winding crown
折叠雨伞|a domed canopy and a telescoping frame
保温壶|a short stout flask and a curved handle
纸灯笼|an inflated shade and circular frame ribs
小型积雨云|three connected fluffy cloud masses
极光|flowing ribbons and a bright core
漩涡|rotating concentric curved volumes
闪电|a zigzag silhouette with rounded corners
邮差|sturdy short legs and a rectangular mailbag silhouette
修理匠|thick gloves and a tool belt
烘焙师|a tall hat and rounded apron volumes
园艺师|a large-pocket apron and detachable gloves
石狮守护灵|a broad forehead, large paws and a compact mane
小麒麟|short rounded horns and a full chest plate
山灵|a stacked-stone body and a small treetop
风精灵|a spherical core and ribbon arms
卷线器|a large circular reel and a side handle
齿轮箱|a thick rounded box shell and circular gear teeth
液压千斤顶|a squat base and a telescoping cylinder
磁力起重机|a rounded load-bearing arm and a suspended end
灯塔|a tapered tower and a circular top cover
风车屋|a round roof and cross-shaped windmill blades
拱桥|a clear arch and substantial bridge piers
钟楼|stacked square tower volumes and a round clock face
牛角面包|a golden curved body with curled ends
糯米团|a soft spherical body and short limbs
爆米花|irregular rounded clusters and a paper-cup silhouette
甜甜圈|a thick ring and a central circular hole
手风琴|rectangular cases and extensible bellows
小号|coiled brass tubing and a flared bell
木琴|parallel broad tone bars and short supports
留声机|a large horn and a small square base
独轮车|a large central wheel and a compact frame
潜水艇|a capsule hull and round windows
热气球|a large balloon and a suspended basket
复古电车|a rounded rectangular carriage and small wheel assemblies
小行星|faceted rounded rocks and glowing cracks
彗星|a spherical nucleus and curved tail ribbons
土星环|a spherical planetary body and a tilted surrounding ring
月牙|a soft crescent silhouette with a concave inner arc`.split('\n').map(line => line.split('|')));
const sourceAnchors: Record<string, string> = Object.fromEntries(`厚实的双掌|thick palms
螺旋背壳|spiral back shell
两侧鳍翅|side flippers
层叠背甲|overlapping back armor
大体块背部|broad back mass
可开合的双钳|opening and closing claws
伞状冠毛|umbrella-like seed tufts
节状枝干|segmented branches
层状鳞片|layered scales
宽大的伞盖|broad mushroom cap
表盘与表链|clock face and chain
辐射状伞骨|radial umbrella ribs
壶嘴与握柄|spout and handle
灯笼骨圈|circular lantern ribs
层叠云团|layered cloud masses
弧形光带|curved ribbons of light
涡旋核心|vortex core
折线闪电臂|zigzag lightning arms
背包与肩带|backpack and shoulder straps
工具带|tool belt
厨师帽|chef hat
收纳口袋|storage pockets
层叠石鬃|layered stone mane
一对短角|a pair of short horns
山石肩部|rock shoulders
环绕风带|encircling wind ribbons
中央线轴|central spool
外缘齿轮|outer gear teeth
升降活塞|lifting piston
吊臂末端|crane-arm end
顶部灯室|top lantern room
正面风叶|front windmill blades
拱形主体|arched main structure
中央大钟|central clock
层状卷角|layered curled ends
柔软圆腹|soft rounded belly
蓬松冠部|fluffy crown
环形轮廓|ring silhouette
折叠风箱|folding bellows
扩张喇叭口|flared bell
排列音条|aligned tone bars
号角形声筒|horn-shaped sound funnel
圆形轮毂|circular wheel hub
透明观察窗|transparent observation window
悬挂绳索|suspension ropes
车顶受电弓|roof pantograph
岩石裂隙|rock cracks
流线尾迹|streamlined tail trail
外侧环带|outer ring band
月牙弧线|crescent arc`.split('\n').map(line => line.split('|')));
const moods: Record<string, string> = Object.fromEntries(`遗迹探路员|ancient stone textures and ceremonial character
星图考古家|inscriptions and engraved geometric lines
涂鸦快递员|bold graphics and playful rhythm
节拍滑行家|contrasting stripes and visual rhythm
深海领航员|ocean-blue navigational markings
潮汐邮差|wave curves and nautical-chart symbols
巡游灯彩师|festival patterns and a sense of order
鼓点仪仗员|high-contrast blocks and traditional ornament
蒸汽修补匠|copper instruments and mechanical rivets
发条巡检员|retro dials and precise gears
梦境收集员|soft gradients and floating symbols
午夜寻梦者|crescent symbols and light poses
森林故事管理员|picture-book geometric graphics
魔法邮局学徒|warm fairy-tale heraldry
风味调配师|ingredient colors and utensil patterns
流动甜品师|cream curves and candy colors
反重力球员|digital playing-field emblems
极限接力手|speed lines and sports protection
星际快递员|space badges and cabin modules
迷你行星导游|celestial graphics and vivid panels
戏台机关师|geometric colors inspired by Chinese opera makeup
巡游武生|crisp banners and rhythmic movement
微光观测员|deep-sea fluorescence and scientific markings
海沟标本师|clear measurement marks and layers`.split('\n').map(line => line.split('|')));
const correctedPersonalities: Record<string, Pair[]> = {
  '开朗乐观型': [pair('开朗乐观，以轻快舒展的动作表现', 'cheerful and optimistic, expressed through buoyant open gestures'), pair('开朗乐观，以明快的目光与自然微笑表现', 'cheerful and optimistic, expressed through a bright gaze and natural smile')],
  '坚持原则型': [pair('坚持原则，以坚定而尊重他人的姿态表现', 'principled, expressed through a firm yet respectful posture'), pair('坚持原则，以明确的制止手势和沉着目光表现', 'principled, expressed through a clear stopping gesture and steady gaze')],
  '反差矛盾型': [pair('胆小但勇敢，身体稍后缩却主动伸手', 'timid yet brave, recoiling slightly while reaching forward'), pair('外冷内热，以克制表情和保护动作表现', 'reserved outside and warm within, with a restrained expression and protective gesture'), pair('严肃但幽默，以正经表情配俏皮动作表现', 'serious yet humorous, with a solemn face and playful gesture')],
  '聪明机敏型': [pair('聪明机敏，以聚焦目光和迅速手势表现', 'clever and quick-witted, with a focused gaze and nimble gestures'), pair('聪明机敏，以观察和推理的姿态表现', 'clever and quick-witted, expressed through observation and reasoning')],
  '温柔保护型': [pair('温柔且有保护欲，以包容的环抱动作表现', 'gentle and protective, expressed through an inclusive sheltering gesture'), pair('温柔且有保护欲，以稳健支撑同伴的动作表现', 'gentle and protective, expressed through steadily supporting a companion')],
  '外向表现型': [pair('外向且善于表达，以开放姿态主动交流', 'extroverted and expressive, communicating through an open posture'), pair('外向且善于表达，以热情招呼和丰富手势表现', 'extroverted and expressive, with an enthusiastic greeting and lively gestures')],
  '冷静理智型': [pair('冷静理智，以沉着目光和有条理的动作表现', 'calm and rational, with a steady gaze and orderly movements'), pair('冷静理智，以先观察再行动的姿态表现', 'calm and rational, expressed by observing before acting')],
  '好奇探索型': [pair('好奇且乐于探索，以仔细观察和试探动作表现', 'curious and exploratory, with close observation and tentative investigation'), pair('好奇且乐于探索，以研究新发现的专注姿态表现', 'curious and exploratory, focused on investigating a new discovery')],
  '内向安静型': [pair('内向安静，以自然放松的安静观察姿态表现', 'introverted and quiet, calmly observing in a relaxed posture'), pair('内向安静，以专注独立思考的动作表现', 'introverted and quiet, expressed through focused independent reflection')],
  '幽默古怪型': [pair('幽默古怪，以诙谐表情与出人意料的动作表现', 'humorous and eccentric, with a comic expression and unexpected gesture'), pair('幽默古怪，以一本正经的滑稽姿态表现', 'humorous and eccentric, with a deadpan comic pose')],
  '竞争好胜型': [pair('竞争好胜，以跃跃欲试的动作表现', 'competitive and eager to win, expressed through a ready-to-compete pose'), pair('竞争好胜，以专注目标的前倾姿态表现', 'competitive and eager to win, leaning toward a clear goal')],
  '慢热谨慎型': [pair('慢热谨慎，先安静观察再逐渐靠近', 'slow to warm up and cautious, observing quietly before gradually approaching'), pair('慢热谨慎，以仔细确认后轻轻伸手的动作表现', 'slow to warm up and cautious, carefully checking before tentatively reaching out')],
};
const extraMechanisms: Pair[][] = [
  [pair('外壳沿分段接口变形，主体辨识特征保持连贯', 'the shell transforms along segmented interfaces while preserving the identity'), pair('柔性结构通过伸缩改变轮廓', 'a flexible structure changes silhouette through extension and contraction')],
  [pair('层叠板片沿滑轨逐层展开', 'layered plates unfold progressively along guide rails'), pair('柔性膜沿支撑骨架展开并卷收', 'a flexible membrane opens along supporting ribs and rolls back')],
  [pair('伴生体通过触点交换信号并协作', 'companion organisms exchange signals through contact points and cooperate'), pair('附着生物随主体动作改变开合状态', 'an attached organism opens and closes in response to the main body')],
  [pair('局部空间折叠形成短距离通道', 'a local spatial fold forms a short passage'), pair('重力核心改变接地部位的受力方向', 'a gravity core changes the force direction at contact points')],
  [pair('发光纹路沿能量流向依次亮起', 'luminous patterns light sequentially along the energy flow'), pair('弹性囊体储能后逐段释放', 'elastic chambers store energy and release it progressively')],
  [pair('模块绕共享轴心交换工作位置', 'modules exchange working positions around a shared axis'), pair('不同模块通过榫接形成新结构', 'different modules form new structures through interlocking joints')],
  [pair('工具卷收进主体侧面的槽道', 'a tool retracts into a channel along the body'), pair('多层舱盖依次打开露出收纳空间', 'layered covers open sequentially to reveal storage space')],
  [pair('杠杆蓄力后沿导轨弹出功能端', 'a lever stores energy and launches a functional end along a guide'), pair('弹性关节驱动短距离跃动', 'elastic joints power short-range hopping')],
  [pair('同一主体在休眠和活跃状态间切换', 'the same body switches between dormant and active states'), pair('半透明组织在蓄能和释放状态间改变亮度', 'translucent tissue changes brightness between charging and release states')],
  [pair('连杆带动多个部位同步开合', 'linked rods synchronize the opening and closing of several parts'), pair('柔性筋索把身体动作传递至末端', 'flexible tendons transmit body motion to the extremities')],
  [pair('环形结构绕主体轴线旋转', 'a ring structure rotates around the body axis'), pair('偏心转轴带动有节奏的摆动', 'an eccentric rotary shaft drives rhythmic oscillation')],
  [pair('可切换磁极使模块吸合或分离', 'switchable magnetic poles join or separate modules'), pair('磁性轨道引导小部件滑动归位', 'magnetic tracks guide small parts back into position')],
];
const legacyBodyMap: Record<string, [string, string][]> = {
  '上下比例类': [['distribution', '上大下小']], '重心分布类': [['center', '低重心'], ['silhouette', '桶形']], '肢体比例类': [['torsoLength', '短躯'], ['legLength', '长腿']], '头身比例类': [['headScale', '大头短身']],
  '曲线轮廓类': [['silhouette', '水滴']], '角形轮廓类': [['silhouette', '倒三角']], '球形体块类': [['exaggeration', '巨腹']], '锥形体块类': [['silhouette', '锥形']],
  '非对称体型': [['symmetry', '左右不对称']], '细长体量类': [['stature', '瘦长']], '宽窄对比类': [['shoulderFeet', '宽肩窄脚']], '主体体块类': [['silhouette', '圆球']],
};
function applyLegacyBody(row: FusionRow, traits: Record<string, Pair[]>) {
  const apply = (id: string, label: string, en?: string) => { const option = TRAITS.find(t => t.id === id)?.options.find(o => o.zh === label); if (!traits[id] && (option || en)) traits[id] = [option || pair(label, en!)]; };
  for (const card of row.cards || []) {
    if (card.id === 'card-body-head-ratio') apply('headRatio', card.label, card.en);
    if (card.id === 'card-body-exaggeration' && !traits.exaggeration) traits.exaggeration = card.values || [pair(card.label, card.en)];
    if (card.id === 'card-body-type') { const id = ['矮胖', '瘦小', '瘦长', '匀称'].includes(card.label) ? 'stature' : card.label === '壮硕' ? 'build' : card.label === '畸变' ? 'deformation' : 'silhouette'; apply(id, card.label, card.en); }
    if (card.id === 'card-body-structure') {
      const values: Record<string, [string, string][]> = { '长躯短腿': [['torsoLength', '长躯'], ['legLength', '短腿']], '短躯长腿': [['torsoLength', '短躯'], ['legLength', '长腿']], '长臂短腿': [['armLength', '长臂'], ['legLength', '短腿']], '短臂长腿': [['armLength', '短臂'], ['legLength', '长腿']] };
      if (values[card.label]) for (const [id, label] of values[card.label]) apply(id, label);
      else apply(card.label === '宽肩窄胯' ? 'shoulderHips' : card.label === '头身一体' ? 'headBody' : 'headScale', card.label, card.en);
    }
  }
  for (const [id, value] of legacyBodyMap[row.category.physique] || []) apply(id, value, id === 'headScale' ? 'a large head and short body' : undefined);
}
export function decorateRow(row: FusionRow, s: FusionSettings, random: () => number, index = 0, manual = false, retained?: Design): FusionRow {
  const dynamicChoices = retained ? {} : resolveDynamicTraits(s.catalogue, random, index, row.category);
  const resolved = retained ? structuredClone(retained.chosen || retained.traits) : resolveTraits(s.catalogue, random, index, manual, dynamicChoices);
  for (const { category, terms } of Object.values(dynamicChoices)) {
    if (category.generationKind === 'trait') continue;
    const term = terms[0]; if (!term) continue;
    if (category.generationKind === 'body-card') {
      row = { ...row, cards: [...(row.cards || []).filter(card => card.id !== category.legacyId), { id: category.legacyId || category.id, title: category.nameZh, titleEn: category.nameEn,
        label: terms.map(term => term.legacyValue || term.nameZh).join('、'), en: terms.map(term => term.nameEn).join(', '), values: terms.map(term => ({ zh: term.legacyValue || term.nameZh, en: term.nameEn })), multi: category.multi }] };
      for (const selected of terms) for (const trait of selected.data?.bodyTraits || []) (resolved[trait.id] ||= []).push(pair(trait.zh, trait.en));
      continue;
    }
    const id = category.generationKind;
    row = { ...row, category: { ...row.category, [id]: term.data!.group! } };
    if (id === 'source') row = { ...row, source: { name: term.nameZh, en: term.nameEn, ...term.data!.source! } };
    else if (id === 'concept') row = { ...row, concept: { name: term.nameZh, en: term.nameEn, ...term.data!.concept! } };
    else if (id === 'mechanism') row = { ...row, mechanism: { cn: term.descriptionZh, en: term.descriptionEn } };
    else if (id === 'personality') resolved.primaryPersonality = [{ zh: term.nameZh, en: term.nameEn, descriptionZh: term.descriptionZh, descriptionEn: term.descriptionEn }];
    else row = { ...row, detail: { ...row.detail, [id]: term.descriptionZh } };
  }
  if (Object.values(dynamicChoices).some(({ category }) => category.generationKind === 'source' || category.generationKind === 'concept')) row = { ...row, name: row.source.root + row.concept.suffix };
  const chosen = structuredClone(resolved);
  const dynamic: DesignCatalogueSnapshot | undefined = retained ? retained.dynamic && structuredClone(retained.dynamic) : s.catalogue?.dynamic ? (() => {
    const snapshot = s.catalogue!.dynamic!.snapshot, selections: Record<string, string[]> = {};
    const categories = snapshot.categories.filter(category => s.catalogue!.dynamic!.selections[category.id]?.enabled);
    for (const category of categories) selections[category.id] = (dynamicChoices[category.id]?.terms || []).map(term => term.id);
    const selected = new Set(Object.values(selections).flat());
    return { version: snapshot.version, categories: structuredClone(categories), terms: structuredClone(snapshot.terms.filter(term => selected.has(term.id))), selections };
  })() : undefined;
  const traitDefinitions = [...TRAITS.map(trait => {
    const definition = dynamic?.categories.find(category => (category.legacyId || category.id) === trait.id);
    return definition ? { ...trait, title: definition.nameZh, en: definition.nameEn, group: definition.group } : trait;
  }), ...(dynamic?.categories.filter(category => !TRAITS.some(trait => trait.id === (category.legacyId || category.id))).map(category => ({ id: category.legacyId || category.id, title: category.nameZh, en: category.nameEn, group: category.group })) || [])];
  const explicitBody = traitDefinitions.some(t => t.group === 'body' && chosen[t.id]);
  const specialTerm = (id: Dimension) => {
    const category = dynamic?.categories.find(category => category.generationKind === id);
    return category ? dynamic?.terms.find(term => dynamic.selections[category.id]?.includes(term.id)) : undefined;
  };
  const detailEn = (id: Dimension) => specialTerm(id)?.descriptionEn || englishDetail(id, row.category[id], row.detail[id]);
  applyLegacyBody(row, resolved);
  const sections: Pair[] = [], add = (zh: string, en: string) => sections.push(pair(zh, en));
  const translated = (map: object, key: string) => key === row.source.name && row.source.en ? row.source.en : key === row.concept.name && row.concept.en ? row.concept.en : key === row.concept.prop && row.concept.propEn ? row.concept.propEn : (map as Record<string, string>)[key] || row.translations?.find(t => t.label === key)?.en || key;
  const body = traitDefinitions.some(t => t.group === 'body' && resolved[t.id]) || Boolean(resolved.headScale);
  const noProps = resolved.equipmentPolicy?.some(p => p.zh === '无道具') === true;
  const sourceName = translated(SOURCE_EN, row.source.name), conceptName = translated(CONCEPT_EN, row.concept.name);
  const fusion = s.catalogue?.sourceFusion;
  const fusionPool = Object.entries(SOURCES).filter(([group]) => s.rules.source.some(rule => rule.label === group && rule.status !== 'exclude')).flatMap(([, sources]) => sources.map(source => source.name)).filter(name => name !== row.source.name && !fusion?.excluded.includes(name));
  const sourceNames = retained ? (retained.sources || []).map(value => value.zh) : !fusion?.enabled ? [] : fusion.locked && fusion.values.length ? fusion.values : drawChoices(fusionPool, { multi: true }, random);
  const sources = sourceNames.filter(name => name !== row.source.name).map(name => pair(name, translated(SOURCE_EN, name)));
  const hasTheme = ['culture', 'world', 'activity', 'technology'].some(id => resolved[id]);
  const themeDefaults: Record<string, Record<string, string[]>> = {
    '远古文明': { culture: ['远古文明'], activity: ['探索'] }, '街头文化': { culture: ['街头文化'] }, '海洋探索': { world: ['海洋'], activity: ['探索'] },
    '节庆民俗': { culture: ['节庆民俗'] }, '蒸汽科技': { technology: ['蒸汽科技'] }, '梦境': { world: ['梦境'] }, '童话': { world: ['童话'] },
    '美食文化': { culture: ['美食文化'] }, '竞技运动': { activity: ['竞技运动'] }, '太空旅行': { world: ['太空'], activity: ['旅行'] }, '戏曲': { culture: ['戏曲'] }, '深海科研': { world: ['深海'], activity: ['科研'] },
  };
  if (hasTheme) for (const [id, values] of Object.entries(themeDefaults[row.category.concept] || {})) if (!resolved[id]) resolved[id] = values.map(v => TRAITS.find(t => t.id === id)!.options.find(o => o.zh === v)!);
  const customOccupation = row.cards?.find(card => !card.id.startsWith('card-body-') && /^(?:职业|职业与身份|职业身份|身份|角色职业|职业设定)$/.test(card.title.trim()));
  const occupation: Pair[] = resolved.occupation || (customOccupation ? customOccupation.values || [pair(customOccupation.label, customOccupation.en)] : undefined) || (row.category.source === '职业' ? [pair(row.source.name, sourceName)] : [pair(row.concept.name, conceptName)]);
  if (resolved.occupation || customOccupation) row = { ...row, name: row.source.root + (occupation[0].zh === '无职业设定' ? '角色' : occupation[0].zh) };
  add(`原创角色设计「${row.name}」。造型母体：${row.source.name === '土星环' ? '土星环（带环行星原型）' : row.source.name}。`, `Original character design: ${sourceName}. Source prototype: ${sourceName}.`);
  for (const id of ['source', 'concept'] as Dimension[]) {
    const term = specialTerm(id);
    if (term && term.descriptionZh !== term.nameZh) add(`${id === 'source' ? '母体' : '跨界'}补充：${term.descriptionZh}。`, `${id === 'source' ? 'Source' : 'Crossover'} details: ${term.descriptionEn}.`);
  }
  if (sources.length) {
    add(`辅助融合元素：${sources.map(value => value.zh).join('、')}。以${row.source.name}为主母体，将辅助元素的材质和辨识结构融入同一角色，不因母体数量增加画面主体。`, `Additional fusion sources: ${sources.map(value => value.en).join(', ')}. Keep the ${sourceName} as the primary prototype and integrate the additional materials and recognizable structures into the same character; additional sources do not add characters.`);
    for (const source of sources) {
      const original = Object.values(SOURCES).flat().find(value => value.name === source.zh)!;
      add(`${source.zh}融合特征：${original.shape}；身形比例仍按明确设置。`, `${source.en} fusion features: ${sourceShapes[source.zh]}; explicit body proportions still take precedence.`);
    }
  }
  if (noProps && row.category.source === '职业') add('以职业人物为人形母体，辨识特征通过服装与姿态表达，不添加独立道具。', 'Use a humanoid occupational prototype, conveying identity through clothing and posture without separate props.');
  else if (body) add(`保留${row.source.name}的材质、面部与表面辨识特征；主体轮廓和比例按下列身形设定。`, `Retain the recognizable material, facial and surface features of the ${sourceName}; use the silhouette and proportions specified below.`);
  else add(`母体形态：${row.source.shape}。`, `Source form: ${sourceShapes[row.source.name] || row.source.shapeEn || `a clear geometric silhouette inspired by ${sourceName}`}.`);
  if (occupation[0].zh !== '无职业设定') add(`职业与身份：${occupation.map(p => p.descriptionZh || p.zh).join('、')}。${occupation.length > 1 ? `主要身份为${occupation[0].zh}，其余为兼任。` : ''}`, `Occupation: ${occupation.map(p => p.descriptionEn || p.en).join(', ')}.${occupation.length > 1 ? ` Primary identity: ${occupation[0].en}; the others are additional roles.` : ''}`);
  if (!hasTheme) add(`视觉语言：${row.concept.mood}。`, `Visual language: ${moods[row.concept.name] || row.concept.moodEn || `distinctive visual symbols of ${translated(EN_LABEL, row.category.concept)}`}.`);
  let mechanism = row.mechanism;
  const mechIndex = CONFIG.find(c => c.id === 'mechanism')!.tags.indexOf(row.category.mechanism as never);
  if (!retained && !Object.values(dynamicChoices).some(value => value.category.generationKind === 'mechanism') && mechIndex >= 0 && extraMechanisms[mechIndex]) { const pool = [pair(row.mechanism.cn, row.mechanism.en), ...extraMechanisms[mechIndex]]; const v = pool[Math.floor(random() * pool.length)]; mechanism = { cn: v.zh, en: v.en }; }
  const independentMechanism = Boolean(resolved.mechanismPrinciple || resolved.mechanismMotion);
  if (independentMechanism) mechanism = { cn: [...(resolved.mechanismPrinciple || []), ...(resolved.mechanismMotion || [])].map(p => p.descriptionZh || p.zh).join('，'), en: [...(resolved.mechanismPrinciple || []), ...(resolved.mechanismMotion || [])].map(p => p.descriptionEn || p.en).join(', ') };
  if (row.category.mechanism && !independentMechanism && !noProps && row.category.mechanism !== '不强调机制') add(`作用机制：${mechanism.cn}。`, `Functional system: ${mechanism.en}.`);
  else if ((row.category.mechanism || independentMechanism) && noProps) add('机制通过角色自身的组织、姿态或内部结构表达，不添加外置装置。', 'Express the mechanism through the character’s own tissue, pose or internal structure, without external devices.');
  if (specialTerm('mechanism') && noProps) add(`作用机制：${mechanism.cn}。`, `Functional system: ${mechanism.en}.`);
  if (!noProps) {
    if (row.category.equipment) add(`道具：${row.detail.equipment}。`, `Equipment: ${detailEn('equipment')}.`);
    else if (!resolved.occupation && !customOccupation && !hasTheme) add(`主题关联道具：${row.concept.prop}。`, `Theme-related prop: ${translated(PROP_EN, row.concept.prop)}.`);
  }
  const anchorCn = noProps && row.category.source === '职业' ? '职业姿态' : sourceAnchors[row.source.anchor] || row.source.anchorEn ? row.source.anchor : '母体的标志特征';
  const anchorEn = noProps && row.category.source === '职业' ? 'occupational posture' : sourceAnchors[row.source.anchor] || row.source.anchorEn || 'the source’s signature feature';
  if (!noProps && row.category.equipment) add(`融合连接：让${anchorCn}参与${row.detail.equipment}的造型与使用方式。`, `Fusion connection: integrate ${anchorEn} into the form and operation of ${detailEn('equipment')}.`);
  else if (!noProps && !resolved.occupation && !customOccupation && !hasTheme) add(`融合连接：将${anchorCn}转化为${row.concept.prop}的结构线索。`, `Fusion connection: reinterpret ${anchorEn} as a structural cue for the ${translated(PROP_EN, row.concept.prop)}.`);
  else add(`融合连接：让${anchorCn}融入角色的轮廓、动作和自身功能，形成可解释的关联。`, `Fusion connection: integrate ${anchorEn} into the character’s silhouette, actions and intrinsic function with a clear causal relationship.`);
  if (row.category.signature && !resolved.signatureArea && !resolved.signatureKind) add(`识别特征：${row.detail.signature}；按母体实际部位或拟人化结构适配，以经历或使用痕迹解释。`, `Signature: ${detailEn('signature')}; adapt it to the source anatomy or anthropomorphic structure and explain it through history or use.`);
  const personalityPool = correctedPersonalities[row.category.personality];
  const personality = personalityPool ? personalityPool[Math.floor(random() * personalityPool.length)] : pair(row.personality.pose, row.personality.en);
  if (row.category.personality && !resolved.primaryPersonality) add(`主性格：${row.category.personality}。${personality.zh}。`, `Primary personality: ${personality.en}.`);
  const legacyRole: Record<string, string> = { '主角': 'narrative', '配角': 'narrative', '路人': 'narrative', '反派': 'allegiance', '伙伴': 'relationship', Boss: 'gameRole' };
  const roleId = row.role && legacyRole[row.role];
  if (roleId && !resolved[roleId]) { const v = TRAITS.find(t => t.id === roleId)!.options.find(o => o.zh === row.role); if (v) resolved[roleId] = [v]; }
  const entityIndex = CONFIG.find(c => c.id === 'entity')!.tags.indexOf(row.category.entity as never);
  const explicitComposition = ['bodyCount', 'assembly', 'relationship', 'consciousness'].some(id => resolved[id]);
  const inferredBodies = entityIndex < 0 || [3, 8, 9, 10].includes(entityIndex) ? '单体' : entityIndex === 5 ? '三体' : '双体';
  const entityDefaults: Array<Record<string, string[]>> = [
    { assembly: ['并体融合'] }, { relationship: ['共生'] }, { relationship: ['主从'] }, { assembly: ['上下叠合'] }, { assembly: ['分体重组'] },
    { assembly: ['分体重组'] }, { relationship: ['亲子'], assembly: ['套叠结构'] }, { relationship: ['镜像'] }, { assembly: ['骑乘共体'] },
    { assembly: ['双面结构'] }, { consciousness: ['双意识共体'] }, { relationship: ['镜像'], assembly: ['对称关联'] },
  ];
  for (const [id, values] of Object.entries(entityDefaults[entityIndex] || {})) if (!resolved[id]) resolved[id] = values.map(v => TRAITS.find(t => t.id === id)!.options.find(o => o.zh === v)!);
  const bodies = resolved.bodyCount?.[0]?.zh || inferredBodies;
  if (row.category.entity && !explicitComposition) add(`组合结构：${row.detail.entity}，明确连接关系和拆合空间。`, `Composition: ${detailEn('entity')}, with explicit connections and assembly space.`);
  for (const t of traitDefinitions) {
    const values = resolved[t.id]; if (!values?.length || t.id === 'occupation' || !explicitBody && t.group === 'body' || t.id === 'equipmentPolicy' && !noProps || noProps && t.id.startsWith('equipment') && t.id !== 'equipmentPolicy') continue;
    add(`${t.title}：${values.map(p => p.descriptionZh || p.zh).join('、')}。`, `${t.en}: ${values.map(p => p.descriptionEn || p.en).join(', ')}.`);
  }
  if (!explicitBody && row.category.physique) add(`形体轮廓：${row.detail.physique}。`, `Silhouette: ${detailEn('physique')}.`);
  if (explicitBody && resolved.headScale && !resolved.headRatio && !resolved.headBody) add(`头部与躯干：${resolved.headScale[0].zh}。`, `Head and body: ${resolved.headScale[0].en}.`);
  for (const c of row.cards || []) if ((!c.id.startsWith('card-body-') || !explicitBody) && c.id !== customOccupation?.id && !(noProps && /道具|装备|武器|工具/.test(c.title))) add(`${c.title}：${c.label}。`, `${c.titleEn}: ${c.en}.`);
  if (bodies === '单体' && resolved.relationship?.length) add('角色关系为故事背景，同伴不要求入画，只展示当前主体。', 'Relationships describe story context; companions remain off-screen and only the current character is shown.');
  if (bodies === '单体') add('单体角色全身设定，三分之四正面视角。', 'One full-body character, front three-quarter view.');
  else add(`${bodies === '双体' ? '两位' : bodies === '三体' ? '三位' : '多位'}角色完整组合设定，清楚展示各主体与空间关系。`, `A complete composition of ${bodies === '双体' ? 'two characters' : bodies === '三体' ? 'three characters' : 'multiple characters'}, showing each participant and their spatial relationships.`);
  add('体块层级清晰，连接与动作逻辑可信，适于建模和动画。', 'Clear form hierarchy, believable connections and movement, suitable for modeling and animation.');
  let cn = s.requirementsEnabled ? s.requirements : '', en = s.requirementsEnabled ? s.requirementsEn || (s.requirements === DEFAULT_REQUIREMENTS ? 'Premium family-friendly stylized 3D cartoon, approximately 2.5 heads tall, simplified rounded geometry, vivid clean colors, a strong readable silhouette, matte materials, soft studio lighting, charming without being infantile, clear thickness and assembly, suitable for 3D modeling and animation.' : s.requirements) : '';
  ({ zh: cn, en } = artDirectionPair(cn, en, Boolean(resolved.headRatio)));
  if (body && cn) add('身形设置中的明确比例优先于固定要求内同一属性的描述。', 'Explicit body proportions take precedence over descriptions of the same attributes in the fixed art direction.');
  return { ...row, bridge: `${row.source.name} → ${occupation.map(p => p.zh).join('、')}${noProps ? ' · 无外置道具' : row.category.equipment ? ` · ${row.detail.equipment}` : ''}${row.category.mechanism ? ` · ${row.category.mechanism}` : ''}`, mechanism, personality: resolved.primaryPersonality ? { pose: resolved.primaryPersonality.map(p => p.descriptionZh || p.zh).join('、'), en: resolved.primaryPersonality.map(p => p.descriptionEn || p.en).join(', ') } : { pose: personality.zh, en: personality.en }, design: { sections, chosen, traits: resolved, requirements: pair(cn, en), equipment: !noProps, bodies, sources, ...(dynamic ? { dynamic } : {}) } };
}
export function artDirectionPair(zh: string, en: string, headRatio: boolean): Pair {
  if (!headRatio) return pair(zh, en);
  return pair(zh.replace(/(?:约|大约)?\s*\d+(?:\.\d+)?(?:\s*[-–~至]\s*\d+(?:\.\d+)?)?\+?\s*头身[，,、]?/g, ''), en.replace(/(?:approximately\s+|about\s+)?\d+(?:\.\d+)?(?:\s*[-–~]\s*\d+(?:\.\d+)?)?(?:\+|\s+or more)?\s*(?:heads?|head lengths?)\s+tall[,;]?/gi, ''));
}
export function chooseConcrete(row: FusionRow, s: FusionSettings, manual = false): FusionRow {
  let next = { ...row, detail: { ...row.detail } };
  for (const [id, d] of Object.entries(s.catalogue?.details || {})) {
    if (!d || !(manual || d.locked)) continue;
    if (id === 'source') { const source = (SOURCES as Record<string, typeof row.source[]>)[row.category.source]?.find(x => x.name === d.value); if (source) next = { ...next, source, name: source.root + next.concept.suffix }; }
    else if (id === 'concept') { const concept = (CONCEPTS as Record<string, typeof row.concept[]>)[row.category.concept]?.find(x => x.name === d.value); if (concept) next = { ...next, concept, name: next.source.root + concept.suffix }; }
    else if (['equipment', 'signature', 'entity', 'physique'].includes(id)) next.detail[id as Dimension] = d.value;
  }
  return next;
}
