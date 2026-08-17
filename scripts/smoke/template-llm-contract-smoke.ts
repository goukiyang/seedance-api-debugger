import assert from 'node:assert/strict';
import {
  buildTemplateModuleLibraryItem,
  buildTemplateModulePatch,
  type TemplateModuleLibraryItem,
} from '@/lib/templates/module-library';
import {
  parseTemplateConfigAgentResponse,
  templateConfigDraftToTemplatePayload,
} from '@/lib/templates/template-config-builder';
import type { ModuleBuilderDraft } from '@/lib/templates/module-builder';
import type { SerializedGenerationTemplate } from '@/lib/templates/workbench';

const template: SerializedGenerationTemplate = {
  id: 'tpl_001',
  template_key: 'brand_rabbit',
  name: '品牌兔子模板',
  description: '用于品牌宣传',
  status: 'active',
  version: 'v1',
  module_bindings: {},
  temporal: { enabled: true, segment: 15, handoff: false },
  defaults: { ratio: '16:9', duration: 5, resolution: '480p' },
  assets: [],
  rules: [],
  prompts: [],
  created_by: 'admin_001',
  updated_by: null,
  created_at: new Date('2026-06-15T00:00:00Z'),
  updated_at: new Date('2026-06-15T00:00:00Z'),
};

const moduleDraft: ModuleBuilderDraft = {
  moduleType: 'character',
  moduleName: '兔子IP',
  promptBlock: {
    description: '白色兔子IP角色，保持核心比例。',
    personality: '活泼、调皮。',
  },
  rules: [
    {
      ruleType: 'MUST',
      injectionMode: 'prompt_required',
      target: 'character',
      content: '必须保持白色兔子IP核心造型。',
      priority: 95,
    },
  ],
  injectionMode: 'prompt_required',
  priority: 95,
  target: 'character',
  assetBinding: { assetId: 'rabbit_ref_001', usage: 'character_reference' },
};

const moduleItem: TemplateModuleLibraryItem = buildTemplateModuleLibraryItem({
  draft: moduleDraft,
  template,
  actorUserId: 'admin_001',
  sessionRules: '本次规则',
  agentRunId: 'run_001',
});

assert.equal(moduleItem.module_type, 'character');
assert.equal(moduleItem.category, '角色设定');
assert.equal(moduleItem.current_version, 1);
assert.equal(moduleItem.versions[0]?.content.moduleName, '兔子IP');
assert.equal(moduleItem.source.template_id, 'tpl_001');

const promptFormatModule = buildTemplateModuleLibraryItem({
  draft: {
    moduleType: 'prompt_format',
    moduleName: '视频提示词格式',
    promptBlock: {
      content: '创意名编号、总述、连续分镜、(end)。',
    },
    rules: [
      {
        ruleType: 'MUST',
        injectionMode: 'prompt_required',
        target: 'prompt_format',
        content: '必须输出连续分镜格式。',
        priority: 100,
      },
    ],
    injectionMode: 'prompt_required',
    priority: 100,
    target: 'prompt_format',
  },
  template,
  actorUserId: 'admin_001',
  scope: 'global',
  category: '提示词格式',
});

assert.equal(promptFormatModule.scope, 'global');
assert.equal(promptFormatModule.category, '提示词格式');
assert.equal(promptFormatModule.versions[0]?.prompt_format_source, 'video_generation_skills');

const modulePatch = buildTemplateModulePatch(template, moduleItem);
assert.equal(modulePatch.module_bindings.character, moduleItem.id);
assert.ok(modulePatch.prompts.some((prompt) => prompt.block_type === 'character'));
assert.ok(modulePatch.rules.some((rule) => rule.content.includes('白色兔子IP')));
assert.ok(modulePatch.assets.some((asset) => asset.metadata?.module_id === moduleItem.id));

const configResponse = parseTemplateConfigAgentResponse(JSON.stringify({
  needsClarification: false,
  templateDraft: {
    name: '兔子品牌宣传模板',
    description: '围绕兔子IP和品牌Logo生成宣传视频。',
    status: 'draft',
    version: 'v1',
  },
  defaultParams: {
    ratio: '16:9',
    duration: 5,
    resolution: '480p',
  },
  modulePlan: [
    { moduleType: 'character', source: 'new', name: '兔子IP', request: '创建兔子IP角色模块' },
    { moduleType: 'prompt_format', source: 'builtin', name: '通用视频提示词格式' },
  ],
  promptBlocks: {
    character: '保持兔子IP造型比例。',
    logo: 'Logo 保持清晰完整。',
    style: '明亮品牌宣传质感。',
    global: '使用通用视频提示词格式。',
    prompt_format: '创意名编号、总述、连续分镜、(end)。',
  },
  rules: [
    { ruleType: 'MUST', injectionMode: 'prompt_required', target: 'character', content: '必须保持兔子IP。', priority: 95 },
    { ruleType: 'CONTEXT', injectionMode: 'context_only', target: 'style', content: '参考品牌色。', priority: 60 },
  ],
  assetBindings: [
    { assetType: 'character', label: '兔子参考图', referenceImageId: 'ref_001', usage: 'character_reference' },
  ],
  temporal: { enabled: true, segment: 15, handoff: true },
  promptFormat: { source: 'builtin_sd2', version: '2026-06-15' },
  planStrategy: { variants: ['节奏', '品牌露出', '情绪'] },
  validationChecklist: ['必须有角色模块', '必须有提示词格式模块'],
  missingInputs: [],
}));

assert.equal(configResponse.needsClarification, false);
assert.equal(configResponse.draft?.templateDraft.name, '兔子品牌宣传模板');

const templatePayload = templateConfigDraftToTemplatePayload(configResponse.draft!);
assert.equal(templatePayload.name, '兔子品牌宣传模板');
assert.equal(templatePayload.status, 'draft');
assert.equal(templatePayload.module_bindings.character, '兔子IP');
assert.ok(templatePayload.prompts.some((prompt) => prompt.block_type === 'prompt_format'));
assert.ok(templatePayload.rules.some((rule) => rule.rule_type === 'context'));
assert.equal(templatePayload.temporal.handoff, true);

console.log('template-llm-contract smoke passed');
