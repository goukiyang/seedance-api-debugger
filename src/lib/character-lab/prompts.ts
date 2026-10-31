import type { CharacterLabConfig, CharacterLabDraft } from './types';

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
export function faceLabPrompt(config: CharacterLabConfig, draft: CharacterLabDraft) {
  const n = draft.count === 9 ? 3 : 2;
  const degree = draft.diversity <= 25 ? '保留原图核心气质和相近年龄，在面部结构上作温和但可辨认的变化'
    : draft.diversity <= 60 ? '保持年龄与气质，各方案在脸型、骨相和五官比例上形成中等且清楚的差别'
      : '探索显著不同的真人身份，强烈拉开脸型、骨相和五官组合；禁止复制原脸，禁止只改体重、年龄、表情、发型或镜头角度冒充不同人';
  return [config.basePrompt, config.characterContext, config.faceVariables, config.styleConstraints,
    `输出恰好一张1:1正方形${n}×${n}宫格，${draft.count}个格子等宽等高，每格为一位不同真人的正面头肩近景。`,
    `面部差异强度${draft.diversity}/100：${degree}。各候选保持同一年龄段和合理的角色身份特征。`,
    ...faceDirections.slice(0, draft.count).map((direction, index) => `第${index + 1}格结构方向：${direction}。按差异强度调整变化幅度。`),
    draft.context ? `用户对当前角色的补充：${draft.context}` : '',
    '所附唯一原始设计图仅用于理解角色；自行在原图中识别同一角色及头部，不要求用户预先抠图、拆分或裁头。整张输出只含候选面部，不含全身、原设定板或文字。',
  ].filter(Boolean).join('\n\n');
}
export function resultLabPrompt(config: CharacterLabConfig, draft: CharacterLabDraft, hasPrevious: boolean) {
  const labels = ['左上正面头肩特写', '右上侧面头肩特写', '左下正面全身', '右下背面全身'];
  return [config.resultPrompt, config.styleConstraints,
    '参考图1是原始角色设计，参考图2是用户明确选中的主面部。以主面部确定唯一真人身份，并保留参考图1的服装、配色、配饰及身体比例，不把原设计图的动漫脸当最终面部。',
    draft.auxiliaryFaces.length ? `后续${draft.auxiliaryFaces.length}张为辅助面部参考，只借鉴下列指定特征，不替换主身份：${draft.auxiliaryFeatures || '整体特征方向，以主面部身份为准'}。` : '',
    draft.context ? `角色补充：${draft.context}` : '',
    hasPrevious ? '最后一张参考是用户正在调整的既有成品，保留其有效人物与构图。' : '',
    draft.adjustmentCell !== null ? `本次仅调整${labels[draft.adjustmentCell]}，其他三格保持原有内容。仍输出完整四格参考图。` : '',
    draft.adjustment ? `本次调整要求：${draft.adjustment}` : '',
    '仅输出一张完整2:3竖版四格图片，不添加格子编号或文字，不裁掉头顶、脚和鞋。',
  ].filter(Boolean).join('\n\n');
}
