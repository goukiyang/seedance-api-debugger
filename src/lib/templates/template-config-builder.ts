import {
  createMuskChatCompletion,
  type MuskApiSettings,
} from '@/lib/integrations/musk';
import {
  DEFAULT_MODULE_BUILDER_RULES,
  VIDEO_PROMPT_FORMAT_REQUIREMENTS,
  type ModuleBuilderRule,
  type ResolvedModuleBuilderType,
} from '@/lib/templates/module-builder';
import type {
  SerializedGenerationTemplate,
  SerializedTemplateAsset,
  SerializedTemplatePromptBlock,
  SerializedTemplateRule,
  TemplateAssetType,
  TemplateModuleBindings,
  TemplatePromptBlockType,
  TemplateRuleType,
} from '@/lib/templates/workbench';

export const DEFAULT_TEMPLATE_CONFIG_RULES = [
  '不要把模板配置生成成纯说明文字，必须输出可保存的结构化模板草稿。',
  '必须生成 templateDraft、defaultParams、modulePlan、promptBlocks、rules、assetBindings、temporal。',
  '必须包含 prompt_format 模块，并直接采用现有视频生成 skills 的提示词格式要求。',
  '如果缺少模板用途、目标视频类型或必要素材信息，必须先追问，不要直接生成。',
  '规则必须区分 MUST / FORBID / SUGGEST / CONTEXT，并标注 injectionMode 与 priority。',
  '素材必须判断是角色、Logo、风格、产品、反例还是其他。',
  '输出结果必须能保存为模板草稿或模板新版本。',
].join('\n');

export type TemplateConfigModulePlanItem = {
  moduleType: ResolvedModuleBuilderType;
  source: 'new' | 'existing' | 'builtin';
  name: string;
  request?: string;
  moduleId?: string;
};

export type TemplateConfigRule = ModuleBuilderRule;

export type TemplateConfigAssetBinding = {
  assetType: TemplateAssetType;
  label: string;
  referenceImageId?: string | null;
  url?: string | null;
  thumbnailUrl?: string | null;
  usage?: string | null;
  metadata?: Record<string, unknown>;
};

export type TemplateConfigDraft = {
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
  modulePlan: TemplateConfigModulePlanItem[];
  promptBlocks: Partial<Record<TemplatePromptBlockType, string>>;
  rules: TemplateConfigRule[];
  assetBindings: TemplateConfigAssetBinding[];
  temporal: {
    enabled: boolean;
    segment: number;
    handoff: boolean;
  };
  promptFormat: Record<string, unknown>;
  planStrategy: Record<string, unknown>;
  validationChecklist: string[];
  missingInputs: string[];
};

export type TemplateConfigAgentResponse = {
  needsClarification: boolean;
  questions?: string[];
  draft?: TemplateConfigDraft;
  raw?: unknown;
};

export type TemplateConfigGenerateInput = {
  template?: SerializedGenerationTemplate | null;
  intent: string;
  sessionRules: string;
  contextAssetIds?: string[];
};

export type TemplateConfigGenerateResult = TemplateConfigAgentResponse & {
  model: string | null;
  usage: unknown;
  validationErrors: string[];
};

export type TemplateConfigTemplatePayload = {
  template_key?: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'archived';
  version: string;
  defaults: TemplateConfigDraft['defaultParams'];
  module_bindings: TemplateModuleBindings;
  temporal: TemplateConfigDraft['temporal'];
  assets: SerializedTemplateAsset[];
  rules: SerializedTemplateRule[];
  prompts: SerializedTemplatePromptBlock[];
};

const VALID_MODULE_TYPES = new Set<ResolvedModuleBuilderType>([
  'character',
  'logo',
  'style',
  'camera',
  'rule',
  'asset_rule',
  'temporal',
  'prompt_format',
]);

const VALID_ASSET_TYPES = new Set<TemplateAssetType>([
  'character',
  'logo',
  'style',
  'product',
  'negative',
  'other',
]);

const RULE_TYPE_MAP: Record<TemplateConfigRule['ruleType'], TemplateRuleType> = {
  MUST: 'must',
  FORBID: 'forbid',
  SUGGEST: 'suggest',
  CONTEXT: 'context',
};

const PROMPT_KEYS: TemplatePromptBlockType[] = [
  'character',
  'logo',
  'style',
  'camera',
  'rules',
  'asset_rule',
  'temporal',
  'prompt_format',
  'global',
];

const MODULE_BINDING_MAP: Record<ResolvedModuleBuilderType, keyof TemplateModuleBindings> = {
  character: 'character',
  logo: 'logo',
  style: 'style',
  camera: 'camera',
  rule: 'rules',
  asset_rule: 'asset_rule',
  temporal: 'temporal',
  prompt_format: 'prompt_format',
};

function stripJsonFence(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) return trimmed.slice(firstObject, lastObject + 1);
  return trimmed;
}

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function cleanStringOrNull(value: unknown) {
  const text = cleanString(value);
  return text || null;
}

function cleanStatus(value: unknown): 'draft' | 'active' | 'archived' {
  return value === 'active' || value === 'archived' ? value : 'draft';
}

function cleanNumber(value: unknown, fallback: number | null, min = 1, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function cleanBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function cleanStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function cleanRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeModuleType(value: unknown): ResolvedModuleBuilderType | null {
  const raw = cleanString(value);
  return VALID_MODULE_TYPES.has(raw as ResolvedModuleBuilderType) ? raw as ResolvedModuleBuilderType : null;
}

function normalizeModulePlan(value: unknown): TemplateConfigModulePlanItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const source = cleanRecord(item);
      const moduleType = normalizeModuleType(source.moduleType);
      const name = cleanString(source.name);
      if (!moduleType || !name) return null;
      const planSource = source.source === 'existing' || source.source === 'builtin' ? source.source : 'new';
      const normalized: TemplateConfigModulePlanItem = {
        moduleType,
        source: planSource,
        name,
        request: cleanString(source.request) || undefined,
        moduleId: cleanString(source.moduleId) || undefined,
      };
      return normalized;
    })
    .filter((item): item is TemplateConfigModulePlanItem => Boolean(item));
}

function normalizeRules(value: unknown): TemplateConfigRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const source = cleanRecord(item);
      const ruleType = cleanString(source.ruleType).toUpperCase();
      const injectionMode = cleanString(source.injectionMode);
      const content = cleanString(source.content);
      if (!['MUST', 'FORBID', 'SUGGEST', 'CONTEXT'].includes(ruleType)) return null;
      if (!['prompt_required', 'context_only', 'validation_only'].includes(injectionMode)) return null;
      if (!content) return null;
      return {
        ruleType: ruleType as TemplateConfigRule['ruleType'],
        injectionMode: injectionMode as TemplateConfigRule['injectionMode'],
        target: cleanString(source.target, 'global'),
        content,
        priority: cleanNumber(source.priority, 80, 1, 100) || 80,
      };
    })
    .filter((item): item is TemplateConfigRule => Boolean(item));
}

function normalizePromptBlocks(value: unknown): Partial<Record<TemplatePromptBlockType, string>> {
  const source = cleanRecord(value);
  const promptBlocks: Partial<Record<TemplatePromptBlockType, string>> = {};
  PROMPT_KEYS.forEach((key) => {
    const text = cleanString(source[key]);
    if (text) promptBlocks[key] = text;
  });
  return promptBlocks;
}

function normalizeAssetBindings(value: unknown): TemplateConfigAssetBinding[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const source = cleanRecord(item);
      const assetTypeRaw = cleanString(source.assetType || source.asset_type);
      const assetType = VALID_ASSET_TYPES.has(assetTypeRaw as TemplateAssetType)
        ? assetTypeRaw as TemplateAssetType
        : 'other';
      const label = cleanString(source.label);
      if (!label) return null;
      const normalized: TemplateConfigAssetBinding = {
        assetType,
        label,
        referenceImageId: cleanStringOrNull(source.referenceImageId || source.reference_image_id),
        url: cleanStringOrNull(source.url),
        thumbnailUrl: cleanStringOrNull(source.thumbnailUrl || source.thumbnail_url),
        usage: cleanStringOrNull(source.usage),
        metadata: cleanRecord(source.metadata),
      };
      return normalized;
    })
    .filter((item): item is TemplateConfigAssetBinding => Boolean(item));
}

function normalizeTemporal(value: unknown): TemplateConfigDraft['temporal'] {
  const source = cleanRecord(value);
  return {
    enabled: cleanBoolean(source.enabled, true),
    segment: cleanNumber(source.segment, 15, 5, 60) || 15,
    handoff: cleanBoolean(source.handoff, false),
  };
}

function normalizeDraft(value: unknown): TemplateConfigDraft | null {
  const source = cleanRecord(value);
  const templateDraftSource = cleanRecord(source.templateDraft);
  const name = cleanString(templateDraftSource.name);
  if (!name) return null;

  const defaultParamsSource = cleanRecord(source.defaultParams);
  const draft: TemplateConfigDraft = {
    templateDraft: {
      name,
      description: cleanStringOrNull(templateDraftSource.description),
      status: cleanStatus(templateDraftSource.status),
      version: cleanString(templateDraftSource.version, 'v1'),
      template_key: cleanString(templateDraftSource.template_key) || undefined,
    },
    defaultParams: {
      ratio: cleanStringOrNull(defaultParamsSource.ratio),
      duration: cleanNumber(defaultParamsSource.duration, null, 1, 120),
      resolution: cleanStringOrNull(defaultParamsSource.resolution),
    },
    modulePlan: normalizeModulePlan(source.modulePlan),
    promptBlocks: normalizePromptBlocks(source.promptBlocks),
    rules: normalizeRules(source.rules),
    assetBindings: normalizeAssetBindings(source.assetBindings),
    temporal: normalizeTemporal(source.temporal),
    promptFormat: cleanRecord(source.promptFormat),
    planStrategy: cleanRecord(source.planStrategy),
    validationChecklist: cleanStringArray(source.validationChecklist),
    missingInputs: cleanStringArray(source.missingInputs),
  };

  if (!draft.promptBlocks.prompt_format) {
    draft.promptBlocks.prompt_format = VIDEO_PROMPT_FORMAT_REQUIREMENTS;
  }
  if (!draft.modulePlan.some((item) => item.moduleType === 'prompt_format')) {
    draft.modulePlan.push({
      moduleType: 'prompt_format',
      source: 'builtin',
      name: '通用视频提示词格式',
    });
  }
  return draft;
}

export function parseTemplateConfigAgentResponse(content: string): TemplateConfigAgentResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch {
    throw new Error('LLM 未返回可解析 JSON');
  }
  const source = cleanRecord(parsed);
  if (source.needsClarification === true) {
    return {
      needsClarification: true,
      questions: cleanStringArray(source.questions),
      raw: parsed,
    };
  }
  const draftSource = source.draft && typeof source.draft === 'object' && !Array.isArray(source.draft)
    ? source.draft
    : source;
  const draft = normalizeDraft(draftSource);
  return { needsClarification: false, draft: draft || undefined, raw: parsed };
}

export function validateTemplateConfigDraft(draft: TemplateConfigDraft | null | undefined) {
  const errors: string[] = [];
  if (!draft) return ['缺少结构化模板草稿'];
  if (!draft.templateDraft.name.trim()) errors.push('模板名称不能为空');
  if (!draft.modulePlan.length) errors.push('至少需要一个模块规划');
  if (!draft.modulePlan.some((item) => item.moduleType === 'prompt_format')) errors.push('必须包含提示词格式模块');
  if (!draft.promptBlocks.prompt_format?.trim()) errors.push('必须包含提示词格式 PromptBlock');
  if (!draft.rules.length) errors.push('至少需要一条规则');
  return errors;
}

export function templateConfigDraftToTemplatePayload(draft: TemplateConfigDraft): TemplateConfigTemplatePayload {
  const module_bindings = draft.modulePlan.reduce<TemplateModuleBindings>((bindings, item) => {
    const key = MODULE_BINDING_MAP[item.moduleType];
    bindings[key] = item.moduleId || item.name;
    return bindings;
  }, {});

  return {
    template_key: draft.templateDraft.template_key,
    name: draft.templateDraft.name,
    description: draft.templateDraft.description,
    status: draft.templateDraft.status,
    version: draft.templateDraft.version,
    defaults: draft.defaultParams,
    module_bindings,
    temporal: draft.temporal,
    assets: draft.assetBindings.map((asset, index) => ({
      asset_type: asset.assetType,
      label: asset.label,
      url: asset.url || null,
      thumbnail_url: asset.thumbnailUrl || null,
      reference_image_id: asset.referenceImageId || null,
      sort_order: index + 1,
      status: 'active',
      metadata: {
        usage: asset.usage || null,
        ...asset.metadata,
      },
    })),
    rules: draft.rules.map((rule, index) => ({
      rule_type: RULE_TYPE_MAP[rule.ruleType],
      content: rule.content,
      priority: rule.priority,
      sort_order: index + 1,
      status: 'active',
    })),
    prompts: PROMPT_KEYS
      .map((key, index) => ({
        block_type: key,
        content: draft.promptBlocks[key] || '',
        sort_order: index + 1,
        status: 'active',
      }))
      .filter((item) => item.content.trim()),
  };
}

export function buildTemplateConfigSystemPrompt(options?: {
  defaultRules?: string;
  sessionRules?: string;
}) {
  const defaultRules = options?.defaultRules?.trim() || DEFAULT_TEMPLATE_CONFIG_RULES;
  const sessionRules = options?.sessionRules?.trim();
  return [
    '你是 Template Config Agent，负责把管理员对话转换成可保存的模板配置草稿。',
    '你必须只输出 JSON，不要输出 Markdown、解释或额外自然语言。',
    '如果信息不足，输出 {"needsClarification":true,"questions":["..."]}。',
    '如果信息足够，输出 {"needsClarification":false,"templateDraft":{},"defaultParams":{},"modulePlan":[],"promptBlocks":{},"rules":[],"assetBindings":[],"temporal":{},"promptFormat":{},"planStrategy":{},"validationChecklist":[],"missingInputs":[]}。',
    'modulePlan.moduleType 只能是 character、logo、style、camera、rule、asset_rule、temporal、prompt_format。',
    'promptBlocks 必须尽量拆成 character、logo、style、camera、rules、asset_rule、temporal、prompt_format、global。',
    '提示词格式模块必须直接采用现有视频生成 skills 的格式要求。',
    '现有视频生成 skills 的提示词格式要求：',
    VIDEO_PROMPT_FORMAT_REQUIREMENTS,
    '模块生成默认规则：',
    DEFAULT_MODULE_BUILDER_RULES,
    '模板配置默认规则：',
    defaultRules,
    sessionRules ? '本次生成规则：' : '',
    sessionRules || '',
  ].filter(Boolean).join('\n');
}

export function buildTemplateConfigUserPrompt(input: TemplateConfigGenerateInput) {
  const templateContext = input.template ? {
    id: input.template.id,
    name: input.template.name,
    description: input.template.description,
    version: input.template.version,
    module_bindings: input.template.module_bindings,
    temporal: input.template.temporal,
    defaults: input.template.defaults,
    active_rules: input.template.rules.filter((rule) => rule.status === 'active'),
    active_assets: input.template.assets.filter((asset) => asset.status === 'active').map((asset) => ({
      id: asset.id,
      type: asset.asset_type,
      label: asset.label,
      reference_image_id: asset.reference_image_id,
    })),
    prompts: input.template.prompts.filter((prompt) => prompt.status === 'active'),
  } : null;

  return JSON.stringify({
    task: input.template ? 'generate_template_config_patch' : 'generate_new_template_config',
    adminIntent: input.intent,
    sessionRules: input.sessionRules,
    contextAssetIds: input.contextAssetIds || [],
    templateContext,
    requiredVideoPromptFormat: VIDEO_PROMPT_FORMAT_REQUIREMENTS,
  }, null, 2);
}

export async function generateTemplateConfigDraftWithLlm(params: {
  settings: MuskApiSettings;
  input: TemplateConfigGenerateInput;
}): Promise<TemplateConfigGenerateResult> {
  const completion = await createMuskChatCompletion({
    settings: params.settings,
    messages: [
      { role: 'system', content: buildTemplateConfigSystemPrompt({ sessionRules: params.input.sessionRules }) },
      { role: 'user', content: buildTemplateConfigUserPrompt(params.input) },
    ],
    temperature: 0.2,
  });
  const parsed = parseTemplateConfigAgentResponse(completion.content);
  const validationErrors = parsed.needsClarification ? [] : validateTemplateConfigDraft(parsed.draft);
  return {
    ...parsed,
    model: completion.model,
    usage: completion.usage,
    validationErrors,
  };
}
