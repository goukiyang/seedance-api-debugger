import type { AvatarCandidate, AvatarLayout, AvatarPlan } from './types';

// Missing layout belongs to the immutable pre-0.42 independent-image contract.
export function avatarLayout(value: { layout?: AvatarLayout }): AvatarLayout { return value.layout || 'independent'; }
export function avatarOutputCount(plan: Pick<AvatarPlan, 'layout' | 'candidates'>) { return avatarLayout(plan) === 'contact-sheet' ? 1 : plan.candidates.length; }
export function validateSheetCandidates(candidates: AvatarCandidate[], references: string[] = []) {
  if (candidates.length !== 4 || candidates.some(c => c.members.length !== 1 || c.baselineAssetId) || references.length || new Set(candidates.map(c => c.characterId)).size !== 4) throw new Error('四宫格需要四位独立人物、每格一人，不能使用某个人的同人基准图。请切换独立头像或重新准备人物。');
}
export function compileContactSheet(candidates: AvatarCandidate[]) {
  validateSheetCandidates(candidates);
  const positions = ['左上格', '右上格', '左下格', '右下格'];
  return `仅生成一张正方形图片，整张图为真实的2×2四宫格。四格等大、边界清楚，每格恰好一位不同人物的头像，整张图共四位不同人物。不得把四人挤入同一格，不重复同一张脸，不增加第五人。不添加姓名、编号或文字。每格分别遵守以下人物条件，不将一格的特征混到其他格。\n${candidates.map((c, i) => `${positions[i]}：\n${c.standardDescription}`).join('\n\n')}\n最终输出是一张包含上述四格的完整图片，不是四个文件。`;
}
export function withAvatarLayout(plan: AvatarPlan, layout: AvatarLayout): AvatarPlan {
  const candidates = plan.candidates.map(c => ({ ...c, rules: { ...c.rules, layout } }));
  if (layout === 'contact-sheet') validateSheetCandidates(candidates, plan.referenceIds);
  return { ...plan, layout, candidates, sheetPrompt: layout === 'contact-sheet' ? compileContactSheet(candidates) : undefined, aspectRatio: layout === 'contact-sheet' ? '1:1' : candidates[0].members.length > 1 ? '3:2' : '1:1' };
}
