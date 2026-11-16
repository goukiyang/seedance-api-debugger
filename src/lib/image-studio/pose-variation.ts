import { createHash } from 'node:crypto';

export const STUDIO_POSE_VARIATION_MARKER = '[[studio-pose-variation:v1]]';

const bodyStates = [
  '腾空转体：双脚离地，肩线与骨盆反向扭转，一膝抬起、另一腿伸展，双臂向不同方向展开平衡；不用手撑地，以离地投影交代高度。',
  '单脚平衡：仅一脚支撑，另一腿抬起向身侧或身后展开，躯干侧倾，双臂一高一低建立平衡；不蹲下，不用手撑地。',
  '低位支撑：重心接近地面，一手与双脚形成支撑，双腿一屈一展，躯干沿斜线前伸，另一臂向身后或侧方展开。',
  '转身跨步：捕捉转向中的交叉步或旋转步，胸腔与骨盆朝向不同，一臂绕过身体前侧、另一臂向外展开；不是双臂下垂的静立或低蹲撑地。',
  '后仰避让：骨盆前送、躯干向侧后方弯曲，双膝适度屈曲承重，一臂上举、另一臂向侧前伸展；不把重心压向前方手撑地。',
  '跪姿高伸：一膝落地，另一条腿屈曲竖起支撑，躯干上提并扭转，一臂向高处伸展、另一臂护于身侧；不用手撑地。',
  '坐姿转体：臀部或大腿外侧接地，双腿一屈一伸错开，胸腔上扬扭转，双臂向两个不同方向展开；不是手在身体前方撑地的低蹲。',
  '侧向跃步：捕捉横向移动的中间瞬间，一足即将离地、另一腿向侧方跨出，躯干明显侧倾，手臂沿横向运动展开；不是正向弓步或低蹲撑地。',
] as const;

export function buildStudioPoseVariations(templatePrompt: string | undefined, personalPrompt: string,
  requestId: string, count: number): string[] | undefined {
  if (!templatePrompt?.includes(STUDIO_POSE_VARIATION_MARKER)) return;
  const prompt = templatePrompt.replaceAll(STUDIO_POSE_VARIATION_MARKER, '').trim();
  // Request IDs already identify a frozen batch. Reusing one must not draw new poses.
  const ordered = bodyStates.map((bodyState, index) => ({ bodyState,
    rank: createHash('sha256').update(`${requestId}\0${index}`).digest('hex') }))
    .sort((a, b) => a.rank.localeCompare(b.rank));
  return ordered.slice(0, count).map(({ bodyState }) => [prompt,
    `本张动作分配：\n${bodyState}\n仅当本次主体是有身体四肢的角色时执行；动作幅度按服装装备合理调整，自由设计左右方向和细节。保持模板要求的镜头、眼神、人物身份和画面干净。若主体是商品，忽略人体动作分配，不增添人物或四肢。用户本次明确指定的动作优先于本分配。`,
    personalPrompt ? `本次个人要求：\n${personalPrompt}` : '',
  ].filter(Boolean).join('\n\n'));
}
