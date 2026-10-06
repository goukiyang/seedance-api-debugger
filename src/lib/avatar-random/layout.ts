import type { AvatarCandidate, AvatarLayout, AvatarPlan } from './types';

// Missing layout belongs to the immutable pre-0.42 independent-image contract.
export function avatarLayout(value: { layout?: AvatarLayout }): AvatarLayout { return value.layout || 'independent'; }
export function avatarSheetSize(layout: AvatarLayout | undefined) { return layout === 'contact-sheet-9' ? 3 : layout === 'contact-sheet' ? 2 : 0; }
export function isAvatarSheet(value: { layout?: AvatarLayout }) { return avatarSheetSize(avatarLayout(value)) > 0; }
export function avatarSheetLabel(layout: AvatarLayout | undefined) { return layout === 'contact-sheet-9' ? '九宫格' : '四宫格'; }
export function avatarCellLabel(layout: AvatarLayout | undefined, index: number) {
  return (avatarSheetSize(layout) === 3 ? ['左上', '上中', '右上', '左中', '正中', '右中', '左下', '下中', '右下'] : ['左上', '右上', '左下', '右下'])[index] || `第${index + 1}`;
}
export function avatarOutputCount(plan: Pick<AvatarPlan, 'layout' | 'candidates'>) { return isAvatarSheet(plan) ? 1 : plan.candidates.length; }
export function validateSheetCandidates(candidates: AvatarCandidate[], references: string[] = [], layout: AvatarLayout = 'contact-sheet') {
  const size = avatarSheetSize(layout), count = size * size;
  if (!size || candidates.length !== count || candidates.some(c => c.members.length !== 1 || c.baselineAssetId) || references.length || new Set(candidates.map(c => c.characterId)).size !== count) throw new Error(`${avatarSheetLabel(layout)}需要${count}位独立人物、每格一人，不能使用某个人的同人基准图。请切换独立头像或重新准备人物。`);
}
export function compileContactSheet(candidates: AvatarCandidate[], layout: AvatarLayout = 'contact-sheet') {
  validateSheetCandidates(candidates, [], layout);
  const size = avatarSheetSize(layout), count = size * size;
  return `仅生成一张正方形图片，整张图为真实的${size}×${size}${avatarSheetLabel(layout)}。所有格子等大、边界清楚，每格恰好一位不同人物的头像，整张图共${count}位不同人物。不得把多人挤入同一格，不重复同一张脸，不增加第${count + 1}人。不添加姓名、编号或文字。每格分别遵守以下人物条件，不将一格的特征混到其他格。\n${candidates.map((c, i) => `${avatarCellLabel(layout, i)}格：\n${c.standardDescription}`).join('\n\n')}\n最终输出是一张包含上述${count}格的完整图片，不是${count}个文件。`;
}
export function withAvatarLayout(plan: AvatarPlan, layout: AvatarLayout): AvatarPlan {
  if (layout === 'independent' && (plan.candidates.length < 1 || plan.candidates.length > 4)) throw new Error('独立头像最多4位候选，请重新准备人物。');
  const candidates = plan.candidates.map(c => ({ ...c, rules: { ...c.rules, layout } }));
  if (isAvatarSheet({ layout })) validateSheetCandidates(candidates, plan.referenceIds, layout);
  return { ...plan, layout, candidates, sheetPrompt: isAvatarSheet({ layout }) ? compileContactSheet(candidates, layout) : undefined, aspectRatio: isAvatarSheet({ layout }) ? '1:1' : candidates[0].members.length > 1 ? '3:2' : '1:1' };
}
