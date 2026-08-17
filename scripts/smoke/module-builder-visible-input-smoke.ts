import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModuleBuilderUserPrompt } from '../../src/lib/templates/module-builder';
import type { SerializedGenerationTemplate } from '../../src/lib/templates/workbench';

const template: SerializedGenerationTemplate = {
  id: 'module-builder-visible-input-smoke',
  template_key: 'module_builder_visible_input_smoke',
  name: '隐藏模板名称不应影响草稿',
  description: '隐藏模板描述不应影响草稿',
  status: 'active',
  version: 'v1',
  module_bindings: {
    character: 'hidden_brand_ip',
    logo: 'hidden_brand_logo',
    style: 'hidden_style',
  },
  temporal: { enabled: true, segment: 5, handoff: false },
  defaults: { ratio: '16:9', duration: 15, resolution: '720p' },
  assets: [
    {
      id: 'hidden-asset',
      asset_type: 'character',
      label: '隐藏图片标签',
      url: 'https://example.com/hidden.png',
      thumbnail_url: null,
      reference_image_id: 'hidden-ref',
      sort_order: 1,
      status: 'active',
      metadata: {},
    },
  ],
  rules: [
    { rule_type: 'must', content: '隐藏旧规则不能进入模块草稿输入。', priority: 90, sort_order: 1, status: 'active' },
  ],
  prompts: [
    { block_type: 'character', content: '隐藏旧 Prompt 不能进入模块草稿输入。', sort_order: 1, status: 'active' },
  ],
  created_by: 'smoke',
  updated_by: 'smoke',
  created_at: new Date(),
  updated_at: new Date(),
};

const prompt = buildModuleBuilderUserPrompt({
  template,
  moduleType: 'auto',
  intent: '模块需求：把角色表现得更活泼。',
  contextText: 'LLM 上下文内容：保持白色兔子角色的核心外观。',
  sessionRules: '只使用模块需求和 LLM 上下文内容。',
  contextAssetIds: ['visible-selected-image'],
});

const payload = JSON.parse(prompt);

assert.equal(payload.moduleRequirement, '模块需求：把角色表现得更活泼。');
assert.equal(payload.llmContextContent, 'LLM 上下文内容：保持白色兔子角色的核心外观。');
assert.equal(payload.generationRules, '只使用模块需求和 LLM 上下文内容。');
assert.deepEqual(payload.contextAssetIds, ['visible-selected-image']);
assert.equal(payload.templateContext, undefined);

assert.doesNotMatch(prompt, /hidden_brand_ip|hidden_brand_logo|hidden_style/);
assert.doesNotMatch(prompt, /隐藏模板名称|隐藏模板描述/);
assert.doesNotMatch(prompt, /隐藏旧规则|隐藏旧 Prompt|隐藏图片标签|hidden-ref/);

const panelSource = readFileSync('src/components/templates/TemplateContextCardsPanel.tsx', 'utf8');
const drawerSource = readFileSync('src/components/templates/TemplateEditorDrawer.tsx', 'utf8');

assert.doesNotMatch(panelSource, /会写入最终输入|boundImageSourceLabel/);
assert.match(panelSource, /卡片名称（只用于管理，不进入最终提示词）/);
assert.doesNotMatch(drawerSource, /卡片标题：|current_template_context|context_card_title|one_time_rules/);
assert.match(drawerSource, /context_text: card\.content/);

console.log('module-builder-visible-input-smoke passed');
