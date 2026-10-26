import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const story = readFileSync(new URL('../src/app/story-studio/story-studio.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/app/story-studio/story-studio.module.css', import.meta.url), 'utf8');
const picker = readFileSync(new URL('../src/components/ResourceLibraryPicker.tsx', import.meta.url), 'utf8');

for (const marker of [
  'useAppSession()',
  'refreshUser()',
  'sessionReady',
  'storyboardTable',
  'storyboardRow',
  'GeneratedImageResults',
  'LoopVideo',
  'MultiviewEntry',
  'ZoomableImagePreview',
  'materialSignature',
  'confirmMaterials',
  'failedSave.current',
]) assert.ok(story.includes(marker), `story contract missing: ${marker}`);

for (const field of ['description', 'dialogue', 'imagePrompt', 'videoPrompt', 'durationSeconds', 'framing', 'lighting', 'camera', 'materialIds']) {
  assert.ok(story.includes(field), `StoryShot field is not reachable: ${field}`);
}

for (const action of ['生成图片', '生成视频', '查询', '读取结果', '选择原图', '准备生图草稿', '送回画布']) {
  assert.ok(story.includes(action), `storyboard action missing: ${action}`);
}

assert.match(story, /const problem = await operate\('保存镜头图片'/);
assert.match(story, /return problem \? \{ success: false, message: problem \} : true/);
assert.doesNotMatch(story, /if \(success\) setPicker\(null\)/);
assert.match(story, /async function selectReference[\s\S]{0,300}assertCurrentContext\(\);[\s\S]{0,1800}\/api\/workspace\/assets[\s\S]{0,900}assertCurrentContext\(\);/);
const sessionEffects = story.slice(story.indexOf('if (!hasLoadedUser'), story.indexOf('async function save'));
assert.doesNotMatch(sessionEffects, /dispatchShots|\/api\/(?:tasks\/create|image-studio\/generate)/, 'session initialization must not dispatch generation');

for (const marker of ['loadingUser', 'hasLoadedUser', 'userLoadError', 'sessionChanged', 'refreshUser', 'isClientSessionBlocked', '正在确认登录状态', '重新确认', '前往登录']) {
  assert.ok(picker.includes(marker), `picker session contract missing: ${marker}`);
}
assert.match(picker, /if \(!sessionReady \|\| locked\.current \|\| !selected\.length\) return/);
assert.match(picker, /if \(!open \|\| !container\) return null/);
assert.ok(css.includes('.storyboardTable') && css.includes('@media (max-width: 760px)'), 'storyboard responsive styles missing');

console.log('W4 static source contract passed');
