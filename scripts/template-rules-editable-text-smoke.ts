import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTemplatePlanResult } from '../src/lib/agent-plans/template-plans';
import { serializeGenerationTemplate } from '../src/lib/templates/workbench';

const now = new Date();

const template = serializeGenerationTemplate({
  id: 'template-rules-editable-text-smoke',
  template_key: 'template_rules_editable_text_smoke',
  name: '规则文本化模板',
  description: '验证旧规则会变成可编辑上下文卡片',
  status: 'active',
  version: 'v1',
  module_bindings_json: JSON.stringify({
    context_cards: [
      {
        id: 'card-character',
        title: '品牌角色',
        content: '保持品牌角色外观稳定。',
        mode: 'force',
        enabled: true,
        sort_order: 1,
        bound_image: null,
        llm_reference: '隐藏参考不应影响最终提示词。',
        legacy_block_type: 'character',
      },
    ],
  }),
  temporal_json: JSON.stringify({ enabled: true, segment: 5, handoff: false }),
  default_ratio: '16:9',
  default_duration: 15,
  default_resolution: '720p',
  created_by: 'smoke',
  updated_by: 'smoke',
  created_at: now,
  updated_at: now,
  assets: [],
  rules: [
    {
      id: 'rule-must',
      rule_type: 'must',
      content: '必须保持品牌角色、标识和画面风格一致。',
      priority: 95,
      sort_order: 2,
      status: 'active',
    },
    {
      id: 'rule-forbid',
      rule_type: 'forbid',
      content: '禁止把角色写实化或替换成其他主体。',
      priority: 100,
      sort_order: 1,
      status: 'active',
    },
    {
      id: 'rule-disabled',
      rule_type: 'suggest',
      content: '这条停用规则不能出现。',
      priority: 70,
      sort_order: 3,
      status: 'disabled',
    },
  ],
  prompts: [],
});

const contextCards = template.module_bindings.context_cards || [];
const rulesCard = contextCards.find((card) => card.legacy_block_type === 'rules' || card.title === '生成规则');

assert.ok(rulesCard, '旧规则必须转换成可编辑的“生成规则”卡片');
assert.equal(rulesCard?.title, '生成规则');
assert.equal(rulesCard?.mode, 'force');
assert.equal(rulesCard?.enabled, true);
assert.match(rulesCard?.content || '', /禁止 FORBID（优先级 100）：禁止把角色写实化或替换成其他主体。/);
assert.match(rulesCard?.content || '', /必须 MUST（优先级 95）：必须保持品牌角色、标识和画面风格一致。/);
assert.doesNotMatch(rulesCard?.content || '', /这条停用规则不能出现/);

const prompt = createTemplatePlanResult(template, {
  text: '生成品牌宣传视频',
  modifiers: [],
}).prompt;

assert.match(prompt, /生成规则：禁止 FORBID（优先级 100）：禁止把角色写实化或替换成其他主体。/);
assert.match(prompt, /必须 MUST（优先级 95）：必须保持品牌角色、标识和画面风格一致。/);
assert.doesNotMatch(prompt, /\n必须：必须保持品牌角色/);
assert.doesNotMatch(prompt, /\n禁止：禁止把角色写实化/);
assert.doesNotMatch(prompt, /隐藏参考不应影响最终提示词/);

const panelSource = readFileSync('src/components/templates/TemplateContextCardsPanel.tsx', 'utf8');
const drawerSource = readFileSync('src/components/templates/TemplateEditorDrawer.tsx', 'utf8');

assert.doesNotMatch(panelSource, /规则与非最终输入来源|本卡片规则与 LLM 参考|template-context-reference/);
assert.doesNotMatch(drawerSource, /LLM 参考与设置|templateRules/);

console.log('template-rules-editable-text-smoke passed');
