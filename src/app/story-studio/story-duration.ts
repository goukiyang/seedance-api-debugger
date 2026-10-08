import type { StoryShot } from '@/lib/story-workflow';

export type StoryTiming = { total?: number; count?: number; each?: number };

// Only explicit instructions in the original story establish automatic constraints.
export function timingFromStory(story: string): StoryTiming {
  const unit = '(?:秒|sec(?:onds)?|s)(?![a-z])';
  const split = new RegExp(`(\\d+)\\s*[x×*]\\s*(\\d+)\\s*${unit}`, 'i').exec(story);
  const count = /(\d+)\s*(?:个)?镜头/.exec(story);
  const each = new RegExp(`(?:每镜|每个镜头|每镜头|各镜头|每段)\\s*(?:时长|为|是)?\\s*(\\d+)\\s*${unit}`, 'i').exec(story);
  const total = new RegExp(`(?:总时长|总长|全片时长|合计|总共|总计|总长度)\\s*[:：为是]?\\s*(\\d+)\\s*${unit}`, 'i').exec(story)
    || new RegExp(`^\\s*(\\d+)\\s*${unit}`, 'i').exec(story)
    || new RegExp(`(\\d+)\\s*${unit}\\s*(?:短片|视频|影片|故事)`, 'i').exec(story);
  const result: StoryTiming = {};
  if (split) { result.count = Number(split[1]); result.each = Number(split[2]); result.total = result.count * result.each; }
  if (count) result.count = Number(count[1]);
  if (each) result.each = Number(each[1]);
  if (total) result.total = Number(total[1]);
  return result;
}

export function validateStoryTiming(timing: StoryTiming, shots?: StoryShot[]) {
  for (const [key, value] of Object.entries(timing)) {
    const max = key === 'count' ? 30 : key === 'each' ? 15 : 450;
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) throw Error('时长约束超出范围，请核对总时长、镜头数和每镜时长');
  }
  if (timing.total && timing.count && timing.each && timing.total !== timing.count * timing.each) {
    throw Error('总时长与镜头分配不一致，请先核对原故事要求');
  }
  if (!shots) return;
  if (timing.count && shots.length !== timing.count) throw Error(`要求 ${timing.count} 个镜头，实际 ${shots.length} 个；分镜未应用，请核对`);
  const total = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  if (timing.total && total !== timing.total) throw Error(`要求总时长 ${timing.total} 秒，实际 ${total} 秒；分镜未应用，请核对`);
  if (timing.each && shots.some(shot => shot.durationSeconds !== timing.each)) throw Error(`要求每镜 ${timing.each} 秒；分镜时长不匹配，请核对`);
}
