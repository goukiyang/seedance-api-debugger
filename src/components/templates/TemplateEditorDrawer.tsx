'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SerializedGenerationTemplate, TemplateAssetType, TemplateRuleType } from '@/lib/templates/workbench';

type Props = {
  open: boolean;
  template: SerializedGenerationTemplate | null;
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
};

const ruleTypes: Array<{ key: TemplateRuleType; label: string }> = [
  { key: 'must', label: 'MUST' },
  { key: 'forbid', label: 'FORBID' },
  { key: 'suggest', label: 'SUGGEST' },
  { key: 'context', label: 'CONTEXT' },
];

const assetTypes: Array<{ key: TemplateAssetType; label: string }> = [
  { key: 'character', label: 'Character' },
  { key: 'logo', label: 'Logo' },
  { key: 'style', label: 'Style' },
  { key: 'product', label: 'Product' },
  { key: 'negative', label: 'Negative' },
  { key: 'other', label: 'Other' },
];

const moduleBuilderTypes = [
  { key: 'auto', label: '自动判断' },
  { key: 'character', label: '角色模块' },
  { key: 'logo', label: 'Logo 模块' },
  { key: 'style', label: '风格模块' },
  { key: 'camera', label: '镜头模块' },
  { key: 'rule', label: '规则模块' },
  { key: 'asset_rule', label: '素材带规则模块' },
  { key: 'temporal', label: 'Temporal 分段模块' },
  { key: 'prompt_format', label: '提示词格式模块' },
] as const;

type ModuleBuilderType = typeof moduleBuilderTypes[number]['key'];
type ResolvedModuleBuilderType = Exclude<ModuleBuilderType, 'auto'>;

type AssetDraft = {
  asset_type: TemplateAssetType;
  label: string;
  url: string;
  thumbnail_url: string;
  reference_image_id: string;
  sort_order: number;
  status: string;
};

type RuleDraft = {
  rule_type: TemplateRuleType;
  content: string;
  priority: number;
  sort_order: number;
  status: string;
};

type TemplateConfigDraft = {
  name: string;
  description: string;
  modules: {
    character: string;
    logo: string;
    style: string;
    camera: string;
    rules: string;
    asset_rule: string;
    temporal: string;
    prompt_format: string;
  };
  prompts: {
    character: string;
    logo: string;
    style: string;
    camera: string;
    rules: string;
    asset_rule: string;
    temporal: string;
    prompt_format: string;
    global: string;
  };
  rules: RuleDraft[];
  temporal: {
    enabled: boolean;
    segment: number;
    handoff: boolean;
  };
  summary: string;
  missingInputs: string[];
};

type ModuleDraft = {
  moduleType: ResolvedModuleBuilderType;
  moduleName: string;
  promptBlock: string;
  rules: RuleDraft[];
  injectionMode: 'prompt_required' | 'context_only' | 'validation_only';
  priority: number;
  summary: string;
  raw?: ModuleBuilderApiDraft;
};

type ModuleBuilderApiDraft = {
  moduleType: ResolvedModuleBuilderType;
  moduleName: string;
  promptBlock: Record<string, unknown> | string;
  rules: Array<{
    ruleType: 'MUST' | 'FORBID' | 'SUGGEST' | 'CONTEXT';
    injectionMode: 'prompt_required' | 'context_only' | 'validation_only';
    target: string;
    content: string;
    priority: number;
  }>;
  injectionMode: 'prompt_required' | 'context_only' | 'validation_only';
  priority: number;
  target?: string;
  assetBinding?: Record<string, unknown> | null;
};

type ModuleBuilderApiResponse = {
  error?: string;
  agent_run_id?: string;
  needs_clarification?: boolean;
  questions?: string[];
  draft?: ModuleBuilderApiDraft | null;
  validation_errors?: string[];
  model?: string | null;
};

type TemplateConfigApiDraft = {
  templateDraft: {
    name: string;
    description: string | null;
    status: 'draft' | 'active' | 'archived';
    version: string;
    template_key?: string;
  };
  defaultParams: {
    ratio: string | null;
    duration: number | null;
    resolution: string | null;
  };
  modulePlan: Array<{
    moduleType: ResolvedModuleBuilderType;
    source: 'new' | 'existing' | 'builtin';
    name: string;
    request?: string;
    moduleId?: string;
  }>;
  promptBlocks: Partial<Record<'character' | 'logo' | 'style' | 'camera' | 'rules' | 'asset_rule' | 'temporal' | 'prompt_format' | 'global', string>>;
  rules: ModuleBuilderApiDraft['rules'];
  assetBindings: Array<{
    assetType: TemplateAssetType;
    label: string;
    referenceImageId?: string | null;
    url?: string | null;
    thumbnailUrl?: string | null;
    usage?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  temporal: TemplateConfigDraft['temporal'];
  promptFormat: Record<string, unknown>;
  planStrategy: Record<string, unknown>;
  validationChecklist: string[];
  missingInputs: string[];
};

type TemplateConfigApiResponse = {
  error?: string;
  agent_run_id?: string | null;
  needs_clarification?: boolean;
  questions?: string[];
  draft?: TemplateConfigApiDraft | null;
  validation_errors?: string[];
  model?: string | null;
  template?: SerializedGenerationTemplate;
};

const PROMPT_FORMAT_BLOCK = [
  '提示词格式必须使用通用视频提示词结构：第一行使用“最多两个中文字符 + 三位数字”的创意名编号，例如 (弹力001)。',
  '总述行必须包含开场方式、空间/背景、主体、主任务和限制。',
  '分镜行必须使用“时间 / 景别 / 运镜 / 内容”，时间连续、不重叠、不跳秒，每一镜只写一个核心可见动作，结尾必须包含 (end)。',
].join('\n');

const DEFAULT_MODULE_BUILDER_RULES = [
  '不要只生成自然语言描述，必须输出结构化模块。',
  '必须区分 prompt_required / context_only / validation_only。',
  '必须区分 MUST / FORBID / SUGGEST / CONTEXT。',
  '如果是图片素材，必须判断它是角色、Logo、风格、镜头、产品还是反例。',
  '如果缺少关键信息，必须先追问，不要直接生成。',
  '输出结果必须可保存为系统模块。',
].join('\n');

const DEFAULT_TEMPLATE_CONFIG_RULES = [
  '不要把模板配置生成成纯说明文字，必须输出可保存的结构化模板草稿。',
  '必须生成 templateDraft、defaultParams、modulePlan、promptBlocks、rules、assetBindings、temporal。',
  '必须包含 prompt_format 模块，并直接采用现有视频生成 skills 的提示词格式要求。',
  '如果缺少模板用途、目标视频类型或必要素材信息，必须先追问，不要直接生成。',
  '输出结果必须能保存为模板草稿或模板新版本。',
].join('\n');

function shortIntent(value: string, fallback: string) {
  const text = value.trim().replace(/\s+/g, ' ');
  return (text || fallback).slice(0, 48);
}

function inferTemplateName(intent: string, fallback: string) {
  const source = shortIntent(intent, fallback || '视频模板');
  if (source.includes('兔')) return '兔子 IP 宣传模板';
  if (source.includes('Logo') || source.includes('logo')) return 'Logo 演绎模板';
  if (source.includes('产品')) return '产品展示模板';
  if (source.includes('品牌')) return '品牌宣传模板';
  return source.endsWith('模板') ? source : `${source}模板`;
}

function buildTemplateConfigDraft(intent: string, template: SerializedGenerationTemplate): TemplateConfigDraft {
  const brief = shortIntent(intent, template.description || template.name);
  const name = inferTemplateName(intent, template.name);
  const isLogo = /logo|Logo|标志|字标/.test(intent);
  const isProduct = intent.includes('产品');
  const isCharacter = /角色|IP|兔|人物|主角/.test(intent) || !isLogo;

  return {
    name,
    description: `${brief}。由 Template Config Agent 生成草稿，管理员确认后保存为模板版本。`,
    modules: {
      character: isCharacter ? `${name}角色一致性模块` : template.module_bindings.character || '',
      logo: isLogo || intent.includes('品牌') ? `${name}Logo 识别模块` : template.module_bindings.logo || '',
      style: `${name}风格模块`,
      camera: `${name}镜头节奏模块`,
      rules: template.module_bindings.rules || `${name}规则模块`,
      asset_rule: template.module_bindings.asset_rule || `${name}素材规则模块`,
      temporal: template.module_bindings.temporal || `${name}Temporal 分段模块`,
      prompt_format: template.module_bindings.prompt_format || '通用视频提示词格式',
    },
    prompts: {
      character: isCharacter
        ? `主体保持模板设定的角色识别点和造型比例，表演要服务于“${brief}”。`
        : promptByType(template, 'character'),
      logo: `Logo、字标和品牌识别点必须保持完整、清晰、稳定，不拆字、不碎片化。`,
      style: `画面风格围绕“${brief}”建立统一色彩、材质和光线，不混入无关风格。`,
      camera: `镜头围绕“${brief}”设置景别、运镜和节奏，确保每段画面任务清晰。`,
      rules: `规则输出必须拆成 MUST / FORBID / SUGGEST / CONTEXT，并标注优先级。`,
      asset_rule: '素材需要区分角色、Logo、风格、产品、反例和其他，并说明用途。',
      temporal: '默认按 15 秒分段，段落之间保持动作、构图和主体连续。',
      prompt_format: PROMPT_FORMAT_BLOCK,
      global: `模板主任务：${brief}。最终 Prompt 必须可直接提交到视频生成链路。`,
    },
    rules: [
      {
        rule_type: 'must',
        content: `必须围绕“${brief}”组织画面，主体、动作和结尾信息要一致。`,
        priority: 92,
        sort_order: 1,
        status: 'active',
      },
      {
        rule_type: 'forbid',
        content: '禁止生成与模板用途无关的主体、Logo 变体、混乱文字或无法复用的临时风格。',
        priority: 96,
        sort_order: 2,
        status: 'active',
      },
      {
        rule_type: 'suggest',
        content: isProduct ? '优先突出产品动作和使用场景，品牌露出保持清晰。' : '优先生成 A/B/C/D 四个差异化方案，便于管理员或用户选择。',
        priority: 70,
        sort_order: 3,
        status: 'active',
      },
    ],
    temporal: {
      enabled: true,
      segment: 15,
      handoff: false,
    },
    summary: `已按“${brief}”生成模板配置草稿，覆盖模块规划、规则、提示词格式和 Temporal。`,
    missingInputs: [
      ...(isCharacter ? ['角色参考图'] : []),
      ...(isLogo || intent.includes('品牌') ? ['Logo 素材'] : []),
    ],
  };
}

function buildModuleDraft(moduleType: ResolvedModuleBuilderType, intent: string): ModuleDraft {
  const brief = shortIntent(intent, '新增模块');
  const moduleNameMap: Record<ResolvedModuleBuilderType, string> = {
    character: `${brief}角色模块`,
    logo: `${brief}Logo 模块`,
    style: `${brief}风格模块`,
    camera: `${brief}镜头模块`,
    rule: `${brief}规则模块`,
    asset_rule: `${brief}素材规则模块`,
    temporal: `${brief}分段模块`,
    prompt_format: '通用视频提示词格式模块',
  };
  const moduleName = moduleNameMap[moduleType];
  const commonRule: RuleDraft = {
    rule_type: moduleType === 'prompt_format' || moduleType === 'temporal' ? 'must' : 'suggest',
    content: moduleType === 'prompt_format'
      ? '最终 Prompt 必须遵守通用视频提示词格式，包含创意名编号、总述、连续分镜行和 (end)。'
      : `模块应用时必须围绕“${brief}”保持一致，不生成无关内容。`,
    priority: moduleType === 'prompt_format' ? 98 : 78,
    sort_order: 1,
    status: 'active',
  };

  const promptBlockMap: Record<ResolvedModuleBuilderType, string> = {
    character: `角色模块：保持“${brief}”的核心身份、造型比例、表演性格和视觉识别点。`,
    logo: `Logo 模块：保持“${brief}”的品牌标识完整、清晰、稳定，不拆字、不变形。`,
    style: `风格模块：围绕“${brief}”统一画面色彩、材质、光线和视觉语言。`,
    camera: `镜头模块：为“${brief}”提供清晰景别、运镜、节奏和结尾定格策略。`,
    rule: `规则模块：把“${brief}”拆成 MUST、FORBID、SUGGEST 三类约束。`,
    asset_rule: `素材规则模块：识别“${brief}”的素材用途，区分角色、Logo、风格、产品和反例。`,
    temporal: 'Temporal 模块：默认按 15s 分段，保持段间连续，必要时启用帧传递。',
    prompt_format: PROMPT_FORMAT_BLOCK,
  };

  return {
    moduleType,
    moduleName,
    promptBlock: promptBlockMap[moduleType],
    rules: [
      commonRule,
      ...(moduleType === 'logo' ? [{
        rule_type: 'forbid' as TemplateRuleType,
        content: '禁止 Logo 碎片拼装、拆字、变形、错误拼写或低清晰度露出。',
        priority: 100,
        sort_order: 2,
        status: 'active',
      }] : []),
    ],
    injectionMode: moduleType === 'prompt_format' || moduleType === 'character' || moduleType === 'logo'
      ? 'prompt_required'
      : moduleType === 'asset_rule'
        ? 'context_only'
        : 'validation_only',
    priority: moduleType === 'prompt_format' ? 98 : 82,
    summary: `已生成 ${moduleName} 草稿，可应用到当前模板后再人工微调。`,
  };
}

function promptBlockToText(promptBlock: ModuleBuilderApiDraft['promptBlock']) {
  if (typeof promptBlock === 'string') return promptBlock;
  const preferred = ['description', 'content', 'personality', 'performance', 'format', 'requirements']
    .map((key) => promptBlock[key])
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  if (preferred.length > 0) return preferred.join('\n');
  return JSON.stringify(promptBlock, null, 2);
}

function mapApiRuleType(ruleType: ModuleBuilderApiDraft['rules'][number]['ruleType']): TemplateRuleType {
  if (ruleType === 'FORBID') return 'forbid';
  if (ruleType === 'SUGGEST') return 'suggest';
  if (ruleType === 'CONTEXT') return 'context';
  return 'must';
}

function moduleDraftFromApiDraft(draft: ModuleBuilderApiDraft, model?: string | null, validationErrors: string[] = []): ModuleDraft {
  return {
    moduleType: draft.moduleType,
    moduleName: draft.moduleName,
    promptBlock: promptBlockToText(draft.promptBlock),
    rules: draft.rules.map((rule, index) => ({
      rule_type: mapApiRuleType(rule.ruleType),
      content: rule.content,
      priority: rule.priority,
      sort_order: index + 1,
      status: 'active',
    })),
    injectionMode: draft.injectionMode,
    priority: draft.priority,
    summary: [
      `真实 LLM 已生成 ${draft.moduleName} 草稿。`,
      model ? `模型：${model}。` : '',
      validationErrors.length > 0 ? `结构化校验提示：${validationErrors.join(' / ')}` : '结构化校验通过，仍需管理员审核后保存。',
    ].filter(Boolean).join(' '),
    raw: draft,
  };
}

function templateConfigDraftFromApiDraft(draft: TemplateConfigApiDraft, model?: string | null, validationErrors: string[] = []): TemplateConfigDraft {
  const moduleValue = (moduleType: ResolvedModuleBuilderType) => {
    const item = draft.modulePlan.find((planItem) => planItem.moduleType === moduleType);
    return item?.moduleId || item?.name || '';
  };

  return {
    name: draft.templateDraft.name,
    description: draft.templateDraft.description || '',
    modules: {
      character: moduleValue('character'),
      logo: moduleValue('logo'),
      style: moduleValue('style'),
      camera: moduleValue('camera'),
      rules: moduleValue('rule'),
      asset_rule: moduleValue('asset_rule'),
      temporal: moduleValue('temporal'),
      prompt_format: moduleValue('prompt_format'),
    },
    prompts: {
      character: draft.promptBlocks.character || '',
      logo: draft.promptBlocks.logo || '',
      style: draft.promptBlocks.style || '',
      camera: draft.promptBlocks.camera || '',
      rules: draft.promptBlocks.rules || '',
      asset_rule: draft.promptBlocks.asset_rule || '',
      temporal: draft.promptBlocks.temporal || '',
      prompt_format: draft.promptBlocks.prompt_format || PROMPT_FORMAT_BLOCK,
      global: draft.promptBlocks.global || '',
    },
    rules: draft.rules.map((rule, index) => ({
      rule_type: mapApiRuleType(rule.ruleType),
      content: rule.content,
      priority: rule.priority,
      sort_order: index + 1,
      status: 'active',
    })),
    temporal: draft.temporal,
    summary: [
      `真实 LLM 已生成模板配置草稿。`,
      model ? `模型：${model}。` : '',
      validationErrors.length > 0 ? `结构化校验提示：${validationErrors.join(' / ')}` : '结构化校验通过，仍需管理员审核后保存。',
    ].filter(Boolean).join(' '),
    missingInputs: draft.missingInputs,
  };
}

function promptByType(template: SerializedGenerationTemplate | null, blockType: string) {
  return template?.prompts.find((prompt) => prompt.block_type === blockType && prompt.status === 'active')?.content || '';
}

function assetDraftsFromTemplate(template: SerializedGenerationTemplate | null): AssetDraft[] {
  const existing = template?.assets
    .filter((asset) => asset.status === 'active')
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((asset, index) => ({
      asset_type: asset.asset_type,
      label: asset.label,
      url: asset.url || '',
      thumbnail_url: asset.thumbnail_url || '',
      reference_image_id: asset.reference_image_id || '',
      sort_order: asset.sort_order || index + 1,
      status: asset.status,
    })) || [];
  if (existing.length > 0) return existing;
  return [
    { asset_type: 'character', label: '角色参考图', url: '', thumbnail_url: '', reference_image_id: '', sort_order: 1, status: 'active' },
    { asset_type: 'logo', label: 'Logo资源', url: '', thumbnail_url: '', reference_image_id: '', sort_order: 2, status: 'active' },
    { asset_type: 'style', label: '风格参考图', url: '', thumbnail_url: '', reference_image_id: '', sort_order: 3, status: 'active' },
  ];
}

function ruleDraftsFromTemplate(template: SerializedGenerationTemplate | null): RuleDraft[] {
  return template?.rules
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((rule, index) => ({
      rule_type: rule.rule_type,
      content: rule.content,
      priority: rule.priority,
      sort_order: rule.sort_order || index + 1,
      status: rule.status,
    })) || [];
}

export function TemplateEditorDrawer({ open, template, saving = false, error, onClose, onSave }: Props) {
  const [activeTab, setActiveTab] = useState<'modules' | 'rules' | 'assets'>('modules');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('active');
  const [version, setVersion] = useState('v1');
  const [character, setCharacter] = useState('');
  const [logo, setLogo] = useState('');
  const [style, setStyle] = useState('');
  const [camera, setCamera] = useState('');
  const [rulesModule, setRulesModule] = useState('');
  const [assetRule, setAssetRule] = useState('');
  const [temporalModule, setTemporalModule] = useState('');
  const [promptFormatModule, setPromptFormatModule] = useState('');
  const [segmentEnabled, setSegmentEnabled] = useState(true);
  const [segment, setSegment] = useState(15);
  const [handoff, setHandoff] = useState(false);
  const [ruleDrafts, setRuleDrafts] = useState<RuleDraft[]>([]);
  const [characterPrompt, setCharacterPrompt] = useState('');
  const [logoPrompt, setLogoPrompt] = useState('');
  const [stylePrompt, setStylePrompt] = useState('');
  const [cameraPrompt, setCameraPrompt] = useState('');
  const [rulesPrompt, setRulesPrompt] = useState('');
  const [assetRulePrompt, setAssetRulePrompt] = useState('');
  const [temporalPrompt, setTemporalPrompt] = useState('');
  const [promptFormatPrompt, setPromptFormatPrompt] = useState('');
  const [globalPrompt, setGlobalPrompt] = useState('');
  const [assets, setAssets] = useState<AssetDraft[]>([]);
  const [templateAgentInput, setTemplateAgentInput] = useState('');
  const [templateConfigApiDraft, setTemplateConfigApiDraft] = useState<TemplateConfigApiDraft | null>(null);
  const [templateConfigDraft, setTemplateConfigDraft] = useState<TemplateConfigDraft | null>(null);
  const [templateConfigRules, setTemplateConfigRules] = useState(DEFAULT_TEMPLATE_CONFIG_RULES);
  const [templateConfigBusy, setTemplateConfigBusy] = useState(false);
  const [templateConfigError, setTemplateConfigError] = useState<string | null>(null);
  const [templateConfigNotice, setTemplateConfigNotice] = useState<string | null>(null);
  const [templateConfigAgentRunId, setTemplateConfigAgentRunId] = useState<string | null>(null);
  const [templateConfigSaving, setTemplateConfigSaving] = useState(false);
  const [moduleBuilderInput, setModuleBuilderInput] = useState('');
  const [moduleBuilderType, setModuleBuilderType] = useState<ModuleBuilderType>('character');
  const [moduleBuilderRules, setModuleBuilderRules] = useState(DEFAULT_MODULE_BUILDER_RULES);
  const [moduleBuilderRulesOpen, setModuleBuilderRulesOpen] = useState(false);
  const [moduleBuilderBusy, setModuleBuilderBusy] = useState(false);
  const [moduleBuilderError, setModuleBuilderError] = useState<string | null>(null);
  const [moduleBuilderNotice, setModuleBuilderNotice] = useState<string | null>(null);
  const [moduleBuilderAgentRunId, setModuleBuilderAgentRunId] = useState<string | null>(null);
  const [moduleBuilderSaving, setModuleBuilderSaving] = useState(false);
  const [moduleDraft, setModuleDraft] = useState<ModuleDraft | null>(null);
  const [moduleBuilderOpen, setModuleBuilderOpen] = useState(false);
  const [ruleBuilderOpen, setRuleBuilderOpen] = useState(false);
  const [ruleBuilderTargetType, setRuleBuilderTargetType] = useState<TemplateRuleType | null>(null);

  useEffect(() => {
    if (!template) return;
    setName(template.name);
    setDescription(template.description || '');
    setStatus(template.status);
    setVersion(template.version);
    setCharacter(template.module_bindings.character || '');
    setLogo(template.module_bindings.logo || '');
    setStyle(template.module_bindings.style || '');
    setCamera(template.module_bindings.camera || '');
    setRulesModule(template.module_bindings.rules || '');
    setAssetRule(template.module_bindings.asset_rule || '');
    setTemporalModule(template.module_bindings.temporal || '');
    setPromptFormatModule(template.module_bindings.prompt_format || '');
    setSegmentEnabled(template.temporal.enabled);
    setSegment(template.temporal.segment);
    setHandoff(template.temporal.handoff);
    setRuleDrafts(ruleDraftsFromTemplate(template));
    setCharacterPrompt(promptByType(template, 'character'));
    setLogoPrompt(promptByType(template, 'logo'));
    setStylePrompt(promptByType(template, 'style'));
    setCameraPrompt(promptByType(template, 'camera'));
    setRulesPrompt(promptByType(template, 'rules'));
    setAssetRulePrompt(promptByType(template, 'asset_rule'));
    setTemporalPrompt(promptByType(template, 'temporal'));
    setPromptFormatPrompt(promptByType(template, 'prompt_format'));
    setGlobalPrompt(promptByType(template, 'global'));
    setAssets(assetDraftsFromTemplate(template));
    setTemplateAgentInput('');
    setTemplateConfigApiDraft(null);
    setTemplateConfigDraft(null);
    setTemplateConfigRules(DEFAULT_TEMPLATE_CONFIG_RULES);
    setTemplateConfigBusy(false);
    setTemplateConfigError(null);
    setTemplateConfigNotice(null);
    setTemplateConfigAgentRunId(null);
    setTemplateConfigSaving(false);
    setModuleBuilderInput('');
    setModuleBuilderType('character');
    setModuleBuilderRules(DEFAULT_MODULE_BUILDER_RULES);
    setModuleBuilderRulesOpen(false);
    setModuleBuilderBusy(false);
    setModuleBuilderError(null);
    setModuleBuilderNotice(null);
    setModuleBuilderAgentRunId(null);
    setModuleBuilderSaving(false);
    setModuleDraft(null);
    setModuleBuilderOpen(false);
    setRuleBuilderOpen(false);
    setRuleBuilderTargetType(null);
    setActiveTab('modules');
  }, [template]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/templates/module-builder/rules')
      .then(async (response) => {
        const data = await response.json() as { rules?: string };
        if (!cancelled && response.ok && data.rules) setModuleBuilderRules(data.rules);
      })
      .catch(() => {
        if (!cancelled) setModuleBuilderRules(DEFAULT_MODULE_BUILDER_RULES);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const ruleCount = useMemo(() => {
    return ruleDrafts.filter((rule) => rule.status === 'active' && rule.content.trim()).length;
  }, [ruleDrafts]);

  if (!open || !template) return null;

  const buildPayload = () => ({
      name,
      description,
      status,
      version,
      module_bindings: {
        character,
        logo,
        style,
        camera,
        rules: rulesModule,
        asset_rule: assetRule,
        temporal: temporalModule,
        prompt_format: promptFormatModule,
      },
      temporal: { enabled: segmentEnabled, segment, handoff },
      defaults: template.defaults,
      assets: assets
        .filter((asset) => asset.label.trim())
        .map((asset, index) => ({
          asset_type: asset.asset_type,
          label: asset.label.trim(),
          url: asset.url.trim() || null,
          thumbnail_url: asset.thumbnail_url.trim() || null,
          reference_image_id: asset.reference_image_id.trim() || null,
          sort_order: index + 1,
          status: asset.status,
        })),
      rules: ruleDrafts
        .filter((rule) => rule.content.trim())
        .map((rule, index) => ({
          rule_type: rule.rule_type,
          content: rule.content.trim(),
          priority: rule.priority,
          sort_order: index + 1,
          status: rule.status,
        })),
      prompts: [
        { block_type: 'character', content: characterPrompt, sort_order: 1, status: 'active' },
        { block_type: 'logo', content: logoPrompt, sort_order: 2, status: 'active' },
        { block_type: 'style', content: stylePrompt, sort_order: 3, status: 'active' },
        { block_type: 'camera', content: cameraPrompt, sort_order: 4, status: 'active' },
        { block_type: 'rules', content: rulesPrompt, sort_order: 5, status: 'active' },
        { block_type: 'asset_rule', content: assetRulePrompt, sort_order: 6, status: 'active' },
        { block_type: 'temporal', content: temporalPrompt, sort_order: 7, status: 'active' },
        { block_type: 'prompt_format', content: promptFormatPrompt, sort_order: 8, status: 'active' },
        { block_type: 'global', content: globalPrompt, sort_order: 9, status: 'active' },
      ].filter((prompt) => prompt.content.trim()),
  });

  const initialPayload = {
    name: template.name,
    description: template.description || '',
    status: template.status,
    version: template.version,
    module_bindings: {
      character: template.module_bindings.character || '',
      logo: template.module_bindings.logo || '',
      style: template.module_bindings.style || '',
      camera: template.module_bindings.camera || '',
      rules: template.module_bindings.rules || '',
      asset_rule: template.module_bindings.asset_rule || '',
      temporal: template.module_bindings.temporal || '',
      prompt_format: template.module_bindings.prompt_format || '',
    },
    temporal: template.temporal,
    defaults: template.defaults,
    assets: assetDraftsFromTemplate(template).map((asset, index) => ({
      asset_type: asset.asset_type,
      label: asset.label.trim(),
      url: asset.url.trim() || null,
      thumbnail_url: asset.thumbnail_url.trim() || null,
      reference_image_id: asset.reference_image_id.trim() || null,
      sort_order: index + 1,
      status: asset.status,
    })),
    rules: ruleDraftsFromTemplate(template)
      .filter((rule) => rule.content.trim())
      .map((rule, index) => ({
        rule_type: rule.rule_type,
        content: rule.content.trim(),
        priority: rule.priority,
        sort_order: index + 1,
        status: rule.status,
      })),
    prompts: [
      { block_type: 'character', content: promptByType(template, 'character'), sort_order: 1, status: 'active' },
      { block_type: 'logo', content: promptByType(template, 'logo'), sort_order: 2, status: 'active' },
      { block_type: 'style', content: promptByType(template, 'style'), sort_order: 3, status: 'active' },
      { block_type: 'camera', content: promptByType(template, 'camera'), sort_order: 4, status: 'active' },
      { block_type: 'rules', content: promptByType(template, 'rules'), sort_order: 5, status: 'active' },
      { block_type: 'asset_rule', content: promptByType(template, 'asset_rule'), sort_order: 6, status: 'active' },
      { block_type: 'temporal', content: promptByType(template, 'temporal'), sort_order: 7, status: 'active' },
      { block_type: 'prompt_format', content: promptByType(template, 'prompt_format'), sort_order: 8, status: 'active' },
      { block_type: 'global', content: promptByType(template, 'global'), sort_order: 9, status: 'active' },
    ].filter((prompt) => prompt.content.trim()),
  };

  const isDirty = JSON.stringify(buildPayload()) !== JSON.stringify(initialPayload);

  const handleClose = () => {
    if (isDirty && !window.confirm('模板有未保存修改，确定关闭吗？')) return;
    onClose();
  };

  const handleSubmit = async () => {
    await onSave(buildPayload());
  };

  const hydrateFromSerializedTemplate = (nextTemplate: SerializedGenerationTemplate) => {
    setName(nextTemplate.name);
    setDescription(nextTemplate.description || '');
    setStatus(nextTemplate.status);
    setVersion(nextTemplate.version);
    setCharacter(nextTemplate.module_bindings.character || '');
    setLogo(nextTemplate.module_bindings.logo || '');
    setStyle(nextTemplate.module_bindings.style || '');
    setCamera(nextTemplate.module_bindings.camera || '');
    setRulesModule(nextTemplate.module_bindings.rules || '');
    setAssetRule(nextTemplate.module_bindings.asset_rule || '');
    setTemporalModule(nextTemplate.module_bindings.temporal || '');
    setPromptFormatModule(nextTemplate.module_bindings.prompt_format || '');
    setSegmentEnabled(nextTemplate.temporal.enabled);
    setSegment(nextTemplate.temporal.segment);
    setHandoff(nextTemplate.temporal.handoff);
    setRuleDrafts(ruleDraftsFromTemplate(nextTemplate));
    setCharacterPrompt(promptByType(nextTemplate, 'character'));
    setLogoPrompt(promptByType(nextTemplate, 'logo'));
    setStylePrompt(promptByType(nextTemplate, 'style'));
    setCameraPrompt(promptByType(nextTemplate, 'camera'));
    setRulesPrompt(promptByType(nextTemplate, 'rules'));
    setAssetRulePrompt(promptByType(nextTemplate, 'asset_rule'));
    setTemporalPrompt(promptByType(nextTemplate, 'temporal'));
    setPromptFormatPrompt(promptByType(nextTemplate, 'prompt_format'));
    setGlobalPrompt(promptByType(nextTemplate, 'global'));
    setAssets(assetDraftsFromTemplate(nextTemplate));
  };

  const generateTemplateConfigDraft = async () => {
    if (!template) return;
    if (!templateAgentInput.trim()) {
      setTemplateConfigError('请先描述要创建或调整的模板。');
      return;
    }

    setTemplateConfigBusy(true);
    setTemplateConfigError(null);
    setTemplateConfigNotice(null);
    setTemplateConfigAgentRunId(null);
    setTemplateConfigApiDraft(null);
    setTemplateConfigDraft(null);

    try {
      const response = await fetch('/api/templates/config-builder/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: template.id,
          intent: templateAgentInput,
          session_rules: templateConfigRules,
          context_asset_ids: assets
            .map((asset) => asset.reference_image_id)
            .filter((id): id is string => Boolean(id.trim())),
        }),
      });
      const data = await response.json() as TemplateConfigApiResponse;
      setTemplateConfigAgentRunId(data.agent_run_id || null);

      if (!response.ok) {
        setTemplateConfigError(data.error || '模板配置生成失败');
        return;
      }

      if (data.needs_clarification) {
        setTemplateConfigNotice(`LLM 需要先追问：${(data.questions || []).join(' / ') || '缺少关键信息'}`);
        return;
      }

      if (!data.draft) {
        setTemplateConfigError((data.validation_errors || []).join(' / ') || 'LLM 未返回可保存的模板配置草稿');
        return;
      }

      const validationErrors = data.validation_errors || [];
      setTemplateConfigApiDraft(data.draft);
      setTemplateConfigDraft(templateConfigDraftFromApiDraft(data.draft, data.model, validationErrors));
      setTemplateConfigNotice(validationErrors.length > 0
        ? `已收到草稿，但结构化校验有 ${validationErrors.length} 个提示。`
        : '已生成结构化模板配置草稿，保存前请人工审核。');
    } catch (fetchError) {
      setTemplateConfigError(fetchError instanceof Error ? fetchError.message : '模板配置生成失败');
    } finally {
      setTemplateConfigBusy(false);
    }
  };

  const applyTemplateConfigDraft = () => {
    if (!templateConfigDraft) return;
    setName(templateConfigDraft.name);
    setDescription(templateConfigDraft.description);
    setCharacter(templateConfigDraft.modules.character);
    setLogo(templateConfigDraft.modules.logo);
    setStyle(templateConfigDraft.modules.style);
    setCamera(templateConfigDraft.modules.camera);
    setRulesModule(templateConfigDraft.modules.rules);
    setAssetRule(templateConfigDraft.modules.asset_rule);
    setTemporalModule(templateConfigDraft.modules.temporal);
    setPromptFormatModule(templateConfigDraft.modules.prompt_format);
    setCharacterPrompt(templateConfigDraft.prompts.character);
    setLogoPrompt(templateConfigDraft.prompts.logo);
    setStylePrompt(templateConfigDraft.prompts.style);
    setCameraPrompt(templateConfigDraft.prompts.camera);
    setRulesPrompt(templateConfigDraft.prompts.rules);
    setAssetRulePrompt(templateConfigDraft.prompts.asset_rule);
    setTemporalPrompt(templateConfigDraft.prompts.temporal);
    setPromptFormatPrompt(templateConfigDraft.prompts.prompt_format);
    setGlobalPrompt(templateConfigDraft.prompts.global);
    setSegmentEnabled(templateConfigDraft.temporal.enabled);
    setSegment(templateConfigDraft.temporal.segment);
    setHandoff(templateConfigDraft.temporal.handoff);
    setRuleDrafts(templateConfigDraft.rules);
  };

  const saveTemplateConfigDraft = async (mode: 'draft' | 'new_version') => {
    if (!templateConfigApiDraft || !template) return;
    setTemplateConfigSaving(true);
    setTemplateConfigError(null);
    setTemplateConfigNotice(null);

    try {
      const response = await fetch('/api/templates/config-builder/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: template.id,
          agent_run_id: templateConfigAgentRunId,
          mode,
          draft: templateConfigApiDraft,
        }),
      });
      const data = await response.json() as TemplateConfigApiResponse;
      if (!response.ok || !data.template) {
        setTemplateConfigError(data.error || '保存模板配置失败');
        return;
      }
      hydrateFromSerializedTemplate(data.template);
      setTemplateConfigNotice(mode === 'new_version' ? '已保存为模板新版本。' : '已保存为模板草稿。');
    } catch (fetchError) {
      setTemplateConfigError(fetchError instanceof Error ? fetchError.message : '保存模板配置失败');
    } finally {
      setTemplateConfigSaving(false);
    }
  };

  const moduleTypeLabel = (type: ModuleBuilderType) => (
    moduleBuilderTypes.find((item) => item.key === type)?.label || '模块'
  );

  const ruleTypeDisplayLabel = (type: TemplateRuleType | null) => (
    ruleTypes.find((item) => item.key === type)?.label || '规则'
  );

  const scrollToBuilderPanel = (id: string) => {
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };

  const startModuleBuilder = (type: ModuleBuilderType = 'auto', currentValue = '') => {
    setActiveTab('modules');
    setModuleBuilderType(type);
    setModuleBuilderOpen(true);
    setRuleBuilderOpen(false);
    setRuleBuilderTargetType(null);
    setModuleDraft(null);
    setModuleBuilderError(null);
    setModuleBuilderNotice(type === 'auto'
      ? '请选择或描述要新增的模块，LLM 会自动判断类型。'
      : `已选择 ${moduleTypeLabel(type)}，描述模块用途后生成草稿。`);
    setModuleBuilderAgentRunId(null);
    setModuleBuilderInput(currentValue
      ? `重写 ${moduleTypeLabel(type)}：${currentValue}`
      : '');
    scrollToBuilderPanel('template-module-builder-panel');
  };

  const startRuleBuilder = (ruleType: TemplateRuleType | null = null) => {
    setActiveTab('rules');
    setModuleBuilderType('rule');
    setModuleBuilderOpen(false);
    setRuleBuilderOpen(true);
    setRuleBuilderTargetType(ruleType);
    setModuleDraft(null);
    setModuleBuilderError(null);
    setModuleBuilderNotice(ruleType
      ? `已选择 ${ruleTypeDisplayLabel(ruleType)} 规则，LLM 会优先生成这一类规则草稿。`
      : '描述规则目标，LLM 会生成可加入规则列表的结构化草稿。');
    setModuleBuilderAgentRunId(null);
    setModuleBuilderInput(ruleType ? `生成 ${ruleTypeDisplayLabel(ruleType)} 规则：` : '');
    scrollToBuilderPanel('template-rule-builder-panel');
  };

  const generateModuleDraft = async () => {
    if (!template) return;
    if (!moduleBuilderInput.trim()) {
      setModuleBuilderError('请先描述要创建的模块。');
      return;
    }

    setModuleBuilderBusy(true);
    setModuleBuilderError(null);
    setModuleBuilderNotice(null);
    setModuleBuilderAgentRunId(null);

    try {
      const response = await fetch('/api/templates/module-builder/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: template.id,
          module_type: moduleBuilderType,
          intent: moduleBuilderInput,
          session_rules: moduleBuilderRules,
          context_asset_ids: assets
            .map((asset) => asset.reference_image_id)
            .filter((id): id is string => Boolean(id.trim())),
        }),
      });
      const data = await response.json() as ModuleBuilderApiResponse;
      setModuleBuilderAgentRunId(data.agent_run_id || null);

      if (!response.ok) {
        setModuleDraft(null);
        setModuleBuilderError(data.error || 'Module Builder 生成失败');
        return;
      }

      if (data.needs_clarification) {
        setModuleDraft(null);
        setModuleBuilderNotice(`LLM 需要先追问：${(data.questions || []).join(' / ') || '缺少关键信息'}`);
        return;
      }

      if (!data.draft) {
        setModuleDraft(null);
        setModuleBuilderError((data.validation_errors || []).join(' / ') || 'LLM 未返回可保存的模块草稿');
        return;
      }

      const validationErrors = data.validation_errors || [];
      setModuleDraft(moduleDraftFromApiDraft(data.draft, data.model, validationErrors));
      setModuleBuilderNotice(validationErrors.length > 0
        ? `已收到草稿，但结构化校验有 ${validationErrors.length} 个提示。`
        : '已生成结构化模块草稿，保存前请人工审核。');
    } catch (fetchError) {
      setModuleDraft(null);
      setModuleBuilderError(fetchError instanceof Error ? fetchError.message : 'Module Builder 生成失败');
    } finally {
      setModuleBuilderBusy(false);
    }
  };

  const saveModuleBuilderRules = async () => {
    setModuleBuilderError(null);
    setModuleBuilderNotice(null);
    try {
      const response = await fetch('/api/templates/module-builder/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: moduleBuilderRules }),
      });
      const data = await response.json() as { error?: string; rules?: string };
      if (!response.ok) {
        setModuleBuilderError(data.error || '保存生成规则失败');
        return;
      }
      if (data.rules) setModuleBuilderRules(data.rules);
      setModuleBuilderNotice('已保存当前 LLM 生成规则。');
    } catch (fetchError) {
      setModuleBuilderError(fetchError instanceof Error ? fetchError.message : '保存生成规则失败');
    }
  };

  const saveModuleDraft = async () => {
    if (!template || !moduleDraft?.raw) return;
    setModuleBuilderSaving(true);
    setModuleBuilderError(null);
    setModuleBuilderNotice(null);

    try {
      const response = await fetch('/api/templates/module-builder/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: template.id,
          agent_run_id: moduleBuilderAgentRunId,
          draft: moduleDraft.raw,
          session_rules: moduleBuilderRules,
          apply_to_template: true,
          admin_modified: false,
        }),
      });
      const data = await response.json() as { error?: string; template?: SerializedGenerationTemplate; module?: { id: string; current_version: number } };
      if (!response.ok) {
        setModuleBuilderError(data.error || '保存模块失败');
        return;
      }
      if (data.template) hydrateFromSerializedTemplate(data.template);
      setModuleBuilderNotice(`已保存为正式模块${data.module ? `：${data.module.id} v${data.module.current_version}` : ''}`);
    } catch (fetchError) {
      setModuleBuilderError(fetchError instanceof Error ? fetchError.message : '保存模块失败');
    } finally {
      setModuleBuilderSaving(false);
    }
  };

  const rejectModuleDraft = async () => {
    if (!template || !moduleDraft) return;
    setModuleBuilderSaving(true);
    setModuleBuilderError(null);
    setModuleBuilderNotice(null);

    try {
      const response = await fetch('/api/templates/module-builder/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: template.id,
          agent_run_id: moduleBuilderAgentRunId,
          reason: `管理员拒绝模块草稿：${moduleDraft.moduleName}`,
        }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        setModuleBuilderError(data.error || '拒绝模块草稿失败');
        return;
      }
      setModuleDraft(null);
      setModuleBuilderNotice('已拒绝该模块草稿，并写入 Memory。');
    } catch (fetchError) {
      setModuleBuilderError(fetchError instanceof Error ? fetchError.message : '拒绝模块草稿失败');
    } finally {
      setModuleBuilderSaving(false);
    }
  };

  const applyModuleDraft = () => {
    if (!moduleDraft) return;
    if (moduleDraft.moduleType === 'character') {
      setCharacter(moduleDraft.moduleName);
      setCharacterPrompt(moduleDraft.promptBlock);
    } else if (moduleDraft.moduleType === 'logo') {
      setLogo(moduleDraft.moduleName);
      setLogoPrompt(moduleDraft.promptBlock);
    } else if (moduleDraft.moduleType === 'style') {
      setStyle(moduleDraft.moduleName);
      setStylePrompt(moduleDraft.promptBlock);
    } else if (moduleDraft.moduleType === 'camera') {
      setCamera(moduleDraft.moduleName);
      setCameraPrompt(moduleDraft.promptBlock);
    } else if (moduleDraft.moduleType === 'temporal') {
      setTemporalModule(moduleDraft.moduleName);
      setSegmentEnabled(true);
      setSegment(15);
      setHandoff(true);
      setTemporalPrompt(moduleDraft.promptBlock);
    } else if (moduleDraft.moduleType === 'rule') {
      setRulesModule(moduleDraft.moduleName);
      setRulesPrompt(moduleDraft.promptBlock);
    } else if (moduleDraft.moduleType === 'asset_rule') {
      setAssetRule(moduleDraft.moduleName);
      setAssetRulePrompt(moduleDraft.promptBlock);
    } else if (moduleDraft.moduleType === 'prompt_format') {
      setPromptFormatModule(moduleDraft.moduleName);
      setPromptFormatPrompt(moduleDraft.promptBlock);
    } else {
      setGlobalPrompt((current) => [current, moduleDraft.promptBlock].filter(Boolean).join('\n'));
    }
    setRuleDrafts((current) => [
      ...current,
      ...moduleDraft.rules.map((rule, index) => ({
        ...rule,
        sort_order: current.length + index + 1,
      })),
    ]);
    setModuleBuilderNotice('已应用到模板表单，保存模板版本后生效。');
  };

  const applyRuleBuilderDraft = () => {
    if (!moduleDraft) return;
    setRuleDrafts((current) => [
      ...current,
      ...moduleDraft.rules.map((rule, index) => ({
        ...rule,
        rule_type: ruleBuilderTargetType || rule.rule_type,
        sort_order: current.length + index + 1,
      })),
    ]);
    setModuleBuilderNotice('已应用到规则列表，保存模板版本后生效。');
  };

  const moduleBindingRows = [
    { key: 'character', label: 'Character', builderType: 'character' as ModuleBuilderType, value: character, setValue: setCharacter },
    { key: 'logo', label: 'Logo', builderType: 'logo' as ModuleBuilderType, value: logo, setValue: setLogo },
    { key: 'style', label: 'Style', builderType: 'style' as ModuleBuilderType, value: style, setValue: setStyle },
    { key: 'camera', label: 'Camera', builderType: 'camera' as ModuleBuilderType, value: camera, setValue: setCamera },
    { key: 'rules', label: 'Rules', builderType: 'rule' as ModuleBuilderType, value: rulesModule, setValue: setRulesModule },
    { key: 'asset_rule', label: 'Asset Rule', builderType: 'asset_rule' as ModuleBuilderType, value: assetRule, setValue: setAssetRule },
    { key: 'temporal', label: 'Temporal', builderType: 'temporal' as ModuleBuilderType, value: temporalModule, setValue: setTemporalModule },
    { key: 'prompt_format', label: 'Prompt Format', builderType: 'prompt_format' as ModuleBuilderType, value: promptFormatModule, setValue: setPromptFormatModule },
  ];

  const modulePreviewCards = [
    { type: 'character', label: 'Character', value: character || '未绑定角色模块' },
    { type: 'logo', label: 'Logo', value: logo || '未绑定 Logo 模块' },
    { type: 'style', label: 'Style', value: style || '未绑定风格模块' },
    { type: 'other', label: 'Camera', value: camera || '未绑定镜头策略' },
    { type: 'other', label: 'Rules', value: rulesModule || '未绑定规则模块' },
    { type: 'other', label: 'Asset Rule', value: assetRule || '未绑定素材规则模块' },
    { type: 'other', label: 'Temporal', value: temporalModule || '未绑定 Temporal 模块' },
    { type: 'other', label: 'Prompt Format', value: promptFormatModule || '未绑定提示词格式模块' },
  ] as const;

  const addRuleDraft = (ruleType: TemplateRuleType) => {
    setRuleDrafts((current) => [
      ...current,
      {
        rule_type: ruleType,
        content: '',
        priority: ruleType === 'suggest' ? 60 : 90,
        sort_order: current.length + 1,
        status: 'active',
      },
    ]);
  };

  const updateRuleDraft = (index: number, patch: Partial<RuleDraft>) => {
    setRuleDrafts((current) => current.map((rule, ruleIndex) => (
      ruleIndex === index ? { ...rule, ...patch } : rule
    )));
  };

  const renderModuleBuilderPanel = (mode: 'module' | 'rule') => {
    const isRuleBuilder = mode === 'rule';
    const visible = isRuleBuilder ? ruleBuilderOpen : moduleBuilderOpen;
    if (!visible) return null;

    return (
      <div
        id={isRuleBuilder ? 'template-rule-builder-panel' : 'template-module-builder-panel'}
        className="template-builder-inline-panel"
      >
        <div className="template-builder-inline-head">
          <div>
            <h3>{isRuleBuilder ? '新增规则 / Rule Builder' : '新增模块 / Module Builder'} <small>LLM 草稿</small></h3>
            <p>{isRuleBuilder
              ? '规则由 LLM 生成结构化草稿，管理员审核后追加到规则列表。'
              : '模块由 LLM 生成结构化草稿，管理员审核后应用到模板或保存到模块库。'}</p>
          </div>
          <button
            type="button"
            className="template-builder-close"
            onClick={() => {
              if (isRuleBuilder) setRuleBuilderOpen(false);
              else setModuleBuilderOpen(false);
            }}
          >
            收起
          </button>
        </div>
        <div className="template-drawer-grid">
          {isRuleBuilder ? (
            <label>
              <span>规则类型</span>
              <input value={ruleBuilderTargetType ? ruleTypeDisplayLabel(ruleBuilderTargetType) : '自动判断'} readOnly />
            </label>
          ) : (
            <label>
              <span>模块类型</span>
              <select value={moduleBuilderType} onChange={(event) => setModuleBuilderType(event.currentTarget.value as ModuleBuilderType)}>
                {moduleBuilderTypes.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
              </select>
            </label>
          )}
          <label>
            <span>{isRuleBuilder ? '规则目标' : '模块用途'}</span>
            <input
              value={moduleBuilderInput}
              onChange={(event) => setModuleBuilderInput(event.currentTarget.value)}
              placeholder={isRuleBuilder ? '例如：禁止角色变形，必须保持 Logo 清晰' : '例如：白色兔子 IP 角色'}
            />
          </label>
        </div>
        <div className="template-builder-rules">
          <button
            type="button"
            className="template-builder-rules-toggle"
            onClick={() => setModuleBuilderRulesOpen((current) => !current)}
          >
            {moduleBuilderRulesOpen ? '▾' : '▸'} LLM生成规则设定
            <small>严格模式 / 输出 JSON / 自动分类 / 缺信息先追问</small>
          </button>
          {moduleBuilderRulesOpen && (
            <label>
              <span>这个模块生成时，LLM 必须遵守</span>
              <textarea
                value={moduleBuilderRules}
                onChange={(event) => setModuleBuilderRules(event.currentTarget.value)}
                rows={8}
              />
              <button
                type="button"
                className="template-drawer-secondary"
                onClick={() => setModuleBuilderRules(DEFAULT_MODULE_BUILDER_RULES)}
              >
                恢复默认规则
              </button>
              <button
                type="button"
                className="template-drawer-secondary"
                onClick={saveModuleBuilderRules}
              >
                保存当前生成规则
              </button>
            </label>
          )}
        </div>
        <div className="template-builder-actions">
          <button type="button" className="template-drawer-secondary" onClick={generateModuleDraft} disabled={moduleBuilderBusy}>
            {moduleBuilderBusy ? 'LLM 生成中...' : moduleDraft ? (isRuleBuilder ? '重新生成规则草稿' : '重新生成模块草稿') : (isRuleBuilder ? '生成规则草稿' : '生成模块草稿')}
          </button>
          <button
            type="button"
            className="template-drawer-secondary"
            onClick={isRuleBuilder ? applyRuleBuilderDraft : applyModuleDraft}
            disabled={!moduleDraft}
          >
            {isRuleBuilder ? '应用到规则列表' : '应用模块到模板'}
          </button>
          <button type="button" className="template-drawer-secondary" onClick={saveModuleDraft} disabled={!moduleDraft?.raw || moduleBuilderSaving}>
            {moduleBuilderSaving ? '保存中...' : isRuleBuilder ? '保存为规则模块' : '保存模块'}
          </button>
          <button type="button" className="template-drawer-secondary" onClick={rejectModuleDraft} disabled={!moduleDraft || moduleBuilderSaving}>
            拒绝草稿
          </button>
          <a className="template-drawer-secondary" href="/admin/integrations">API 设置</a>
          {moduleBuilderAgentRunId && (
            <a className="template-drawer-secondary" href={`/admin/agent-runs/${moduleBuilderAgentRunId}`}>
              查看生成链路
            </a>
          )}
        </div>
        {moduleBuilderError && <div className="template-drawer-error">{moduleBuilderError}</div>}
        {moduleBuilderNotice && <div className="template-builder-notice">{moduleBuilderNotice}</div>}
        {moduleDraft && (
          <div className="template-builder-preview">
            <strong>{moduleDraft.moduleName}</strong>
            <p>{moduleDraft.summary}</p>
            <dl>
              <div><dt>{isRuleBuilder ? '草稿类型' : '模块类型'}</dt><dd>{isRuleBuilder ? 'rule' : moduleDraft.moduleType}</dd></div>
              <div><dt>注入方式</dt><dd>{moduleDraft.injectionMode}</dd></div>
              <div><dt>优先级</dt><dd>{moduleDraft.priority}</dd></div>
              <div><dt>规则</dt><dd>{moduleDraft.rules.length} 条</dd></div>
            </dl>
            <pre className="template-builder-json-preview">{JSON.stringify({
              moduleType: moduleDraft.moduleType,
              moduleName: moduleDraft.moduleName,
              promptBlock: moduleDraft.promptBlock,
              rules: isRuleBuilder && ruleBuilderTargetType
                ? moduleDraft.rules.map((rule) => ({ ...rule, rule_type: ruleBuilderTargetType }))
                : moduleDraft.rules,
              injectionMode: moduleDraft.injectionMode,
              priority: moduleDraft.priority,
            }, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="template-drawer-shell" role="dialog" aria-modal="true" aria-label="模板编辑">
      <button type="button" className="template-drawer-backdrop" aria-label="关闭模板编辑" onClick={handleClose} />
      <aside className="template-drawer">
        <header className="template-drawer-head">
          <div>
            <span>模板编辑</span>
            <h2>{template.name}</h2>
          </div>
          <button type="button" onClick={handleClose}>关闭</button>
        </header>

        <nav className="template-drawer-tabs" aria-label="模板编辑分组">
          <button type="button" className={activeTab === 'modules' ? 'is-active' : ''} onClick={() => setActiveTab('modules')}>模块</button>
          <button type="button" className={activeTab === 'rules' ? 'is-active' : ''} onClick={() => setActiveTab('rules')}>规则 <span>{ruleCount}</span></button>
          <button type="button" className={activeTab === 'assets' ? 'is-active' : ''} onClick={() => setActiveTab('assets')}>资产 <span>{assets.length}</span></button>
        </nav>

        {error && <div className="template-drawer-error">{error}</div>}

        {activeTab === 'modules' && (
        <>
        <section className="template-drawer-section template-agent-panel">
          <h3>LLM 配置模板 <small>生成草稿后人工确认</small></h3>
          <label>
            <span>模板目标</span>
            <textarea
              value={templateAgentInput}
              onChange={(event) => setTemplateAgentInput(event.currentTarget.value)}
              rows={3}
              placeholder="例如：我要做一个品牌宣传用的兔子 IP 动画模板，突出 Logo 和角色动作。"
            />
          </label>
          <div className="template-builder-actions">
            <button type="button" className="template-drawer-secondary" onClick={generateTemplateConfigDraft} disabled={templateConfigBusy}>
              {templateConfigBusy ? 'LLM 生成中...' : templateConfigDraft ? '重新生成配置草稿' : '生成配置草稿'}
            </button>
            <button type="button" className="template-drawer-secondary" onClick={applyTemplateConfigDraft} disabled={!templateConfigDraft}>
              应用草稿到表单
            </button>
            <button
              type="button"
              className="template-drawer-secondary"
              onClick={() => saveTemplateConfigDraft('draft')}
              disabled={!templateConfigApiDraft || templateConfigSaving}
            >
              {templateConfigSaving ? '保存中...' : '保存草稿'}
            </button>
            <button
              type="button"
              className="template-drawer-secondary"
              onClick={() => saveTemplateConfigDraft('new_version')}
              disabled={!templateConfigApiDraft || templateConfigSaving}
            >
              保存为新版本
            </button>
            {templateConfigAgentRunId && (
              <a className="template-drawer-secondary" href={`/admin/agent-runs/${templateConfigAgentRunId}`}>
                查看配置链路
              </a>
            )}
          </div>
          <details className="template-config-rules">
            <summary>LLM 配置规则设定</summary>
            <textarea
              value={templateConfigRules}
              onChange={(event) => setTemplateConfigRules(event.currentTarget.value)}
              rows={5}
            />
          </details>
          {templateConfigError && <div className="template-drawer-error">{templateConfigError}</div>}
          {templateConfigNotice && <div className="template-builder-notice">{templateConfigNotice}</div>}
          {templateConfigDraft && (
            <div className="template-builder-preview">
              <strong>{templateConfigDraft.name}</strong>
              <p>{templateConfigDraft.summary}</p>
              <dl>
                <div><dt>模块</dt><dd>{Object.values(templateConfigDraft.modules).filter(Boolean).join(' / ') || '待补充'}</dd></div>
                <div><dt>规则</dt><dd>{templateConfigDraft.rules.length} 条</dd></div>
                <div><dt>缺口</dt><dd>{templateConfigDraft.missingInputs.length ? templateConfigDraft.missingInputs.join(' / ') : '无'}</dd></div>
              </dl>
              <pre className="template-builder-json-preview">{JSON.stringify(templateConfigApiDraft || templateConfigDraft, null, 2)}</pre>
            </div>
          )}
        </section>

        <section className="template-drawer-section">
          <h3>基础信息</h3>
          <label>
            <span>名称</span>
            <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
          </label>
          <label>
            <span>描述</span>
            <textarea value={description} onChange={(event) => setDescription(event.currentTarget.value)} rows={3} />
          </label>
          <div className="template-drawer-grid">
            <label>
              <span>状态</span>
              <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
                <option value="draft">草稿</option>
                <option value="active">启用</option>
                <option value="archived">归档</option>
              </select>
            </label>
            <label>
              <span>版本</span>
              <input value={version} onChange={(event) => setVersion(event.currentTarget.value)} />
            </label>
          </div>
        </section>

        <section className="template-drawer-section">
          <div className="template-section-title-row">
            <h3>模块绑定</h3>
            <button type="button" className="template-drawer-secondary" onClick={() => startModuleBuilder('auto')}>
              + 新增模块（LLM）
            </button>
          </div>
          <div className="template-module-binding-list">
            {moduleBindingRows.map((row) => (
              <div className="template-module-binding-row" key={row.key}>
                <label>
                  <span>{row.label}</span>
                  <input value={row.value} onChange={(event) => row.setValue(event.currentTarget.value)} />
                </label>
                <button
                  type="button"
                  className="template-drawer-secondary"
                  onClick={() => startModuleBuilder(row.builderType, row.value)}
                >
                  LLM 生成
                </button>
              </div>
            ))}
          </div>
          {renderModuleBuilderPanel('module')}
          <div className="template-drawer-preview-grid" aria-label="模块素材预览">
            {modulePreviewCards.map((card) => {
              const previewAsset = assets.find((asset) => asset.asset_type === card.type && (asset.thumbnail_url || asset.url));
              return (
                <article className="template-drawer-preview-card" key={card.label}>
                  <div className="template-drawer-preview-thumb">
                    {previewAsset ? <img src={previewAsset.thumbnail_url || previewAsset.url} alt="" /> : <span>无预览</span>}
                  </div>
                  <div>
                    <span>{card.label}</span>
                    <strong>{card.value}</strong>
                    <small>{previewAsset?.label || '可在资产页绑定参考素材'}</small>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="template-drawer-section">
          <h3>专属提示词</h3>
          <label><span>Character Prompt</span><textarea value={characterPrompt} onChange={(event) => setCharacterPrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Logo Prompt</span><textarea value={logoPrompt} onChange={(event) => setLogoPrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Style Prompt</span><textarea value={stylePrompt} onChange={(event) => setStylePrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Camera Prompt</span><textarea value={cameraPrompt} onChange={(event) => setCameraPrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Rules Prompt</span><textarea value={rulesPrompt} onChange={(event) => setRulesPrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Asset Rule Prompt</span><textarea value={assetRulePrompt} onChange={(event) => setAssetRulePrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Temporal Prompt</span><textarea value={temporalPrompt} onChange={(event) => setTemporalPrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Prompt Format</span><textarea value={promptFormatPrompt} onChange={(event) => setPromptFormatPrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Global Prompt</span><textarea value={globalPrompt} onChange={(event) => setGlobalPrompt(event.currentTarget.value)} rows={3} /></label>
        </section>
        <section className="template-drawer-section">
          <h3>Temporal 策略</h3>
          <div className="template-drawer-check-row">
            <label><input type="checkbox" checked={segmentEnabled} onChange={(event) => setSegmentEnabled(event.currentTarget.checked)} /> 启用分段</label>
            <label><input type="checkbox" checked={handoff} onChange={(event) => setHandoff(event.currentTarget.checked)} /> 启用帧传递</label>
          </div>
          <label>
            <span>默认分段秒数</span>
            <input type="number" min={5} max={60} value={segment} onChange={(event) => setSegment(Number(event.currentTarget.value) || 15)} />
          </label>
        </section>
        </>
        )}

        {activeTab === 'assets' && (
        <section className="template-drawer-section">
          <h3>固定素材</h3>
          <div className="template-asset-editor-list">
            {assets.map((asset, index) => {
              const previewUrl = asset.thumbnail_url || asset.url;
              return (
                <div className="template-asset-editor-row" key={`${asset.asset_type}-${index}`}>
                  <div className="template-asset-editor-thumb">
                    {previewUrl ? <img src={previewUrl} alt="" /> : <span>暂无</span>}
                  </div>
                  <select
                    value={asset.asset_type}
                    onChange={(event) => setAssets((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, asset_type: event.currentTarget.value as TemplateAssetType } : item
                    )))}
                  >
                    {assetTypes.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
                  </select>
                  <input
                    value={asset.label}
                    onChange={(event) => setAssets((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, label: event.currentTarget.value } : item
                    )))}
                    placeholder="素材名称"
                  />
                  <input
                    value={asset.url}
                    onChange={(event) => setAssets((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, url: event.currentTarget.value } : item
                    )))}
                    placeholder="素材 URL"
                  />
                  <input
                    value={asset.thumbnail_url}
                    onChange={(event) => setAssets((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, thumbnail_url: event.currentTarget.value } : item
                    )))}
                    placeholder="缩略图 URL"
                  />
                  <input
                    value={asset.reference_image_id}
                    onChange={(event) => setAssets((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, reference_image_id: event.currentTarget.value } : item
                    )))}
                    placeholder="ReferenceImage ID"
                  />
                  <small>{asset.reference_image_id ? '来源：参考图资产' : previewUrl ? '来源：外部素材 URL' : '来源：待补充'}</small>
                  <button
                    type="button"
                    onClick={() => setAssets((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    删除
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="template-drawer-secondary"
            onClick={() => setAssets((current) => [
              ...current,
              { asset_type: 'other', label: '', url: '', thumbnail_url: '', reference_image_id: '', sort_order: current.length + 1, status: 'active' },
            ])}
          >
            增加素材
          </button>
        </section>
        )}

        {activeTab === 'rules' && (
        <section className="template-drawer-section">
          <div className="template-section-title-row">
            <h3>规则集合 <small>{ruleCount} 条</small></h3>
            <button type="button" className="template-drawer-secondary" onClick={() => startRuleBuilder(null)}>
              + 新增规则（LLM）
            </button>
          </div>
          {renderModuleBuilderPanel('rule')}
          {ruleTypes.map((rule) => {
            const indexedRules = ruleDrafts
              .map((draft, index) => ({ draft, index }))
              .filter((item) => item.draft.rule_type === rule.key);
            const activeCount = indexedRules.filter((item) => item.draft.status === 'active' && item.draft.content.trim()).length;
            return (
            <div className="template-rule-editor-block" key={rule.key}>
              <div className="template-rule-editor-head">
                <span>{rule.label} · {activeCount}/{indexedRules.length} 启用</span>
                <small>默认 P{rule.key === 'suggest' ? 60 : 90}</small>
                <button type="button" onClick={() => addRuleDraft(rule.key)}>新增规则</button>
                <button type="button" onClick={() => startRuleBuilder(rule.key)}>LLM 生成本类规则</button>
              </div>
              {indexedRules.length === 0 ? (
                <p className="template-rule-editor-empty">暂无规则，点击新增规则。</p>
              ) : indexedRules.map(({ draft, index }) => (
                <div className="template-rule-editor-row" key={`${draft.rule_type}-${index}`}>
                  <select
                    value={draft.status}
                    onChange={(event) => updateRuleDraft(index, { status: event.currentTarget.value })}
                    aria-label={`${rule.label} 启停状态`}
                  >
                    <option value="active">启用</option>
                    <option value="disabled">停用</option>
                  </select>
                  <label>
                    <span>优先级</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={draft.priority}
                      onChange={(event) => updateRuleDraft(index, { priority: Number(event.currentTarget.value) || 1 })}
                    />
                  </label>
                  <textarea
                    aria-label={`${rule.label} 规则内容`}
                    value={draft.content}
                    onChange={(event) => updateRuleDraft(index, { content: event.currentTarget.value })}
                    rows={2}
                    placeholder="输入单条规则"
                  />
                  <button
                    type="button"
                    onClick={() => setRuleDrafts((current) => current.filter((_, ruleIndex) => ruleIndex !== index))}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          );
          })}
        </section>
        )}

        <footer className="template-drawer-actions">
          <button type="button" disabled title="下一批接入模板变更记录">查看变更记录</button>
          <button type="button" onClick={handleClose}>取消</button>
          <button type="button" className="is-primary" onClick={handleSubmit} disabled={saving || !name.trim()}>
            {saving ? '保存中...' : '保存为新版本'}
          </button>
        </footer>
      </aside>
    </div>
  );
}
