import assert from 'node:assert/strict';
import { createTemplatePlanResult } from '../src/lib/agent-plans/template-plans';
import type { SerializedGenerationTemplate } from '../src/lib/templates/workbench';

const template: SerializedGenerationTemplate = {
  id: 'template-card-context-smoke',
  template_key: 'template_card_context_smoke',
  name: '品牌兔子模板',
  description: '品牌宣传视频',
  status: 'active',
  version: 'v1',
  module_bindings: {
    character: 'brand_ip',
    logo: 'brand_logo',
    style: 'tech_brand',
    module_usage: {
      character: 'required',
      logo: 'required',
      style: 'reference',
    },
    context_cards: [
      {
        id: 'card-1',
        title: '品牌角色',
        content: '保持白色兔子 IP 的外观、材质、比例和活泼性格。',
        mode: 'force',
        enabled: true,
        sort_order: 1,
        bound_image: {
          source: 'reference_album',
          id: 'rabbit-ref',
          reference_image_id: 'rabbit-ref',
          asset_id: null,
          label: '兔子参考图',
          url: 'https://example.com/rabbit.png',
          thumbnail_url: 'https://example.com/rabbit-thumb.png',
        },
        llm_reference: '只影响卡片改写，不应进入最终生成提示词。',
        legacy_block_type: 'character',
      },
      {
        id: 'card-2',
        title: '视觉风格',
        content: '科技感干净，画面清楚，品牌色稳定。',
        mode: 'reference',
        enabled: true,
        sort_order: 2,
        bound_image: null,
        llm_reference: '',
        legacy_block_type: 'style',
      },
    ],
  },
  temporal: { enabled: true, segment: 5, handoff: false },
  defaults: { ratio: '16:9', duration: 15, resolution: '720p' },
  assets: [],
  rules: [
    { rule_type: 'must', content: '保持品牌一致性。', priority: 90, sort_order: 1, status: 'active' },
  ],
  prompts: [
    { block_type: 'character', content: '旧隐藏提示词不应在卡片存在时进入方案。', sort_order: 1, status: 'active' },
  ],
  created_by: 'smoke',
  updated_by: 'smoke',
  created_at: new Date(),
  updated_at: new Date(),
};

const result = createTemplatePlanResult(template, {
  text: '做一条 15 秒品牌宣传视频',
  modifiers: ['更科技'],
});

const prompt = result.prompt;

assert.match(prompt, /强制插入卡片/);
assert.match(prompt, /强制插入卡片：保持白色兔子 IP 的外观、材质、比例和活泼性格。/);
assert.match(prompt, /参考卡片/);
assert.match(prompt, /参考卡片：科技感干净，画面清楚，品牌色稳定。/);
assert.doesNotMatch(prompt, /品牌角色：|视觉风格：/);
assert.doesNotMatch(prompt, /绑定图片：|兔子参考图|参考图集/);
assert.doesNotMatch(prompt, /brand_ip|brand_logo|tech_brand/);
assert.doesNotMatch(prompt, /旧隐藏提示词/);
assert.doesNotMatch(prompt, /保持品牌一致性/);
assert.doesNotMatch(prompt, /强制插入模块/);
assert.doesNotMatch(prompt, /只影响卡片改写/);

const disabledCardTemplate: SerializedGenerationTemplate = {
  ...template,
  id: 'template-card-context-disabled-smoke',
  module_bindings: {
    ...template.module_bindings,
    context_cards: template.module_bindings.context_cards?.map((card) => ({ ...card, enabled: false })) || [],
  },
};

const disabledPrompt = createTemplatePlanResult(disabledCardTemplate, {
  text: '卡片已停用时也不能回退读取旧模块',
  modifiers: [],
}).prompt;

assert.doesNotMatch(disabledPrompt, /brand_ip|brand_logo|tech_brand/);
assert.doesNotMatch(disabledPrompt, /旧隐藏提示词/);
assert.doesNotMatch(disabledPrompt, /强制插入模块|模板提示词/);

console.log('template-card-final-context-smoke passed');
