import { characterLabStrength, type CharacterLabConfig, type CharacterLabDraft, type CharacterLabOperation, type CharacterLabPromptFields } from './types';

const faceDirections = [
  '长脸型，较窄下颌与拉长的中庭，细长眼形，窄直鼻梁，较薄嘴唇',
  '方脸型，较宽的下颌角，较强眉骨，低平颧骨，宽鼻翼，较短人中',
  '圆脸型，饱满颊部与圆润下巴，较圆眼形，较短鼻，较饱满嘴唇',
  '心形脸，较宽额头与颧骨、逐渐收窄下巴，深眼窝与较突出鼻梁',
  '菱形脸，高颧骨、较窄额头和下颌，宽眼距，略上翘鼻尖，清晰唇峰',
  '椭圆脸，柔和骨架，平直眉形，较短眼裂，较长鼻梁，宽嘴角',
  '矩形脸，平直侧轮廓、较长下巴，较近眼距，低鼻根与较宽鼻尖',
  '梨形脸，窄额头、较宽下颌，较低眉位，较浅眼窝，较厚下唇',
  '短宽脸，明显颧弓与短下巴，大眼距，较浅鼻梁，小巧嘴形',
];
export function labFaceRules(draft: Pick<CharacterLabDraft, 'count' | 'diversity'>) {
  const n = draft.count === 9 ? 3 : 2;
  const strength = characterLabStrength(draft.diversity);
  const degree = strength === '小幅'
    ? '围绕同一个基准面孔，仅改变一到两处局部比例。保留人物身份、年龄、脸型和骨相，各格不能换成不同人物。'
    : strength === '中等'
      ? '保留角色辨识点和基础骨相，在眼鼻比例、下颌轮廓等两三处做适度变化。保持发型、年龄和表情一致。'
      : '允许探索明显不同的真人面孔，在脸型、骨相和五官组合上拉开差距，保留角色年龄感与标志性特征。';
  return [
    `输出一张1:1正方形${n}×${n}宫格，恰好${draft.count}个等宽等高格子，对齐等分坐标。每格独立呈现正面头肩照，不跨格、不留空。`,
    `面部变化强度为${strength}。${degree}`,
    ...(strength === '明显' ? faceDirections.slice(0, draft.count).map((direction, index) => `第${index + 1}格结构方向：${direction}。`) : []),
    '使用原始设计图理解角色。采用统一平视头肩构图、表情、背景和光线，只输出候选头像，不含全身、文字或原设计板。',
  ];
}
export function faceLabPrompt(config: CharacterLabConfig, draft: CharacterLabDraft) {
  return [
    ...labFaceRules(draft), config.characterContext, config.styleConstraints,
    ...(characterLabStrength(draft.diversity) === '明显' ? [config.basePrompt, config.faceVariables] : []),
    draft.faceDescription ? `正脸补充（遵守上述变化范围）：${draft.faceDescription}` : '',
  ].filter(Boolean).join('\n\n');
}

export const labViewPromptFields = {
  'refine-face': 'refineFacePrompt',
  side: 'sidePrompt',
  'refine-side': 'refineSidePrompt',
  'body-front': 'bodyFrontPrompt',
  'body-back': 'bodyBackPrompt',
  'body-pair': 'bodyPairPrompt',
} as const satisfies Record<CharacterLabOperation, keyof CharacterLabPromptFields>;

export const labDefaultViewPrompts = {
  bodyPairPrompt: '同一角色的正背面成对呈现，保留原角色头身比、身材轮廓、服装层次、材质、颜色、配饰和鞋。正背面服装和配件位置相互对应，人物高度、站姿、镜头和光线一致。',
  refineFacePrompt: '保留这张正脸的年龄感、骨相、发型与辨识特征，四个方案只在指定细节上做小幅变化。',
  sidePrompt: '保持正脸的年龄感、鼻唇轮廓、下颌、发型、眼镜和配饰。背景与正脸协调。',
  refineSidePrompt: '保留同一个人的身份和侧脸方向，只细调指定部分，四个版本的变化应小而可辨。',
  bodyFrontPrompt: '保留原角色身体比例、服装层次、材质、颜色、配饰和鞋，以站立全身照还原设计。',
  bodyBackPrompt: '还原原角色的背部轮廓、服装结构、配饰位置和鞋，保持原设计比例、材质与配色。',
};

export const labDefaultStageStyles = {
  sideStyleConstraints: '真实人物侧面摄影，自然皮肤纹理与合理解剖结构，统一灰色摄影背景。避免动漫、插画、游戏建模和塑料皮肤。不添加编号、字幕、标注、边框装饰或水印。',
  bodyStyleConstraints: '真实人物全身摄影，合理人体比例与服装材质，统一灰色摄影背景。避免动漫、插画、游戏建模和塑料质感。不添加编号、字幕、标注、边框装饰或水印。',
  resultStyleConstraints: '真实人物摄影，自然皮肤与服装材质，统一灰色摄影背景。不添加编号、字幕、标注、边框装饰或水印。',
};
export function labStyleField(operation: CharacterLabOperation) {
  return operation.startsWith('body-') ? 'bodyStyleConstraints' : operation === 'refine-face' ? 'styleConstraints' : 'sideStyleConstraints';
}

export function labOperationRules(operation: CharacterLabOperation) {
  switch (operation) {
    case 'refine-face':
      return '参考图是用户选定的正脸。输出一张正方形2×2等分宫格，四格都为同一人的正面头肩照。只微调本次描述指定的细节。';
    case 'side':
      return '唯一参考图是选定正脸。输出一张同一人的90°纯侧面头肩照，面向画面左侧，视线水平、保留头顶。仅输出单张侧脸。';
    case 'refine-side':
      return '参考图1是锁定身份的正脸，参考图2是待细调的侧脸。输出一张正方形2×2等分宫格，四格都是同一人同方向的90°纯侧面头肩照。只微调指定细节。';
    case 'body-pair':
      return '仅用原始角色设计图作为参考，不根据头像重构身体。只输出一张1:1正方形正背面全身对照图，左右两个等宽、全高区域。左半区严格正面站姿，右半区严格背面站姿且不回头；两面必须是同一个角色，站在相同地面高度，头顶和鞋底完整入画。两面共同还原原设计的身体比例、服装和配饰，不添加文字或其他视图。';
    case 'body-front':
      return '仅用原始角色设计图作为参考。输出一张严格朝正前方的全身站姿照，头、双脚和鞋完整入画。身体比例、服装与配饰以原设计为准。';
    case 'body-back':
      return '仅用原始角色设计图作为参考。输出一张严格朝正后方的全身站姿照，不回头，头、双脚和鞋完整入画。身体比例、服装与配饰以原设计为准。';
  }
}

export function labViewPrompt(config: CharacterLabPromptFields, operation: CharacterLabOperation, description: string) {
  const field = labViewPromptFields[operation];
  const style = labStyleField(operation);
  return [labOperationRules(operation), config[field] || labDefaultViewPrompts[field], config[style] ?? (style === 'styleConstraints' ? '' : labDefaultStageStyles[style]),
    description ? `${operation.startsWith('body-') ? '本次角色补充' : '本次局部调整'}：${description}` : '',
    '保持自然摄影、平视和一致背景。遵守上述身份、参考来源与构图约束。'].filter(Boolean).join('\n\n');
}
export function resultLabPrompt(config: CharacterLabConfig, draft: CharacterLabDraft, hasPrevious: boolean) {
  const labels = ['左上正面头肩特写', '右上侧面头肩特写', '左下正面全身', '右下背面全身'];
  return [config.resultPrompt, config.resultStyleConstraints ?? labDefaultStageStyles.resultStyleConstraints,
    '参考图1是原始角色设计，参考图2是用户明确选中的主面部。以主面部确定唯一真人身份，并保留参考图1的服装、配色、配饰及身体比例，不把原设计图的动漫脸当最终面部。',
    draft.auxiliaryFaces.length ? `后续${draft.auxiliaryFaces.length}张为辅助面部参考，只借鉴下列指定特征，不替换主身份：${draft.auxiliaryFeatures || '整体特征方向，以主面部身份为准'}。` : '',
    draft.context ? `角色补充：${draft.context}` : '',
    hasPrevious ? '最后一张参考是用户正在调整的既有成品，保留其有效人物与构图。' : '',
    draft.adjustmentCell !== null ? `本次仅调整${labels[draft.adjustmentCell]}，其他三格保持原有内容。仍输出完整四格参考图。` : '',
    draft.adjustment ? `本次调整要求：${draft.adjustment}` : '',
    '仅输出一张完整2:3竖版四格图片，不添加格子编号或文字，不裁掉头顶、脚和鞋。',
  ].filter(Boolean).join('\n\n');
}
