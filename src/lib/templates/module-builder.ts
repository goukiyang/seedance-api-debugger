import type { SerializedGenerationTemplate } from '@/lib/templates/workbench';
import {
  createMuskChatCompletion,
  type MuskApiSettings,
} from '@/lib/integrations/musk';

export type ModuleBuilderType =
  | 'auto'
  | 'character'
  | 'logo'
  | 'style'
  | 'camera'
  | 'rule'
  | 'asset_rule'
  | 'temporal'
  | 'prompt_format';

export type ResolvedModuleBuilderType = Exclude<ModuleBuilderType, 'auto'>;
export type ModuleBuilderRuleType = 'MUST' | 'FORBID' | 'SUGGEST' | 'CONTEXT';
export type ModuleBuilderInjectionMode = 'prompt_required' | 'context_only' | 'validation_only';

export type ModuleBuilderRule = {
  ruleType: ModuleBuilderRuleType;
  injectionMode: ModuleBuilderInjectionMode;
  target: string;
  content: string;
  priority: number;
};

export type ModuleBuilderDraft = {
  moduleType: ResolvedModuleBuilderType;
  moduleName: string;
  promptBlock: Record<string, unknown>;
  rules: ModuleBuilderRule[];
  injectionMode: ModuleBuilderInjectionMode;
  priority: number;
  target?: string;
  assetBinding?: Record<string, unknown> | null;
};

export type ModuleBuilderAgentResponse = {
  needsClarification: boolean;
  questions?: string[];
  draft?: ModuleBuilderDraft;
  raw?: unknown;
};

export type ModuleBuilderGenerateInput = {
  template: SerializedGenerationTemplate;
  moduleType: ModuleBuilderType;
  intent: string;
  sessionRules: string;
  contextAssetIds?: string[];
};

export type ModuleBuilderGenerateResult = ModuleBuilderAgentResponse & {
  model: string | null;
  usage: unknown;
  validationErrors: string[];
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

const VALID_RULE_TYPES = new Set<ModuleBuilderRuleType>(['MUST', 'FORBID', 'SUGGEST', 'CONTEXT']);
const VALID_INJECTION_MODES = new Set<ModuleBuilderInjectionMode>([
  'prompt_required',
  'context_only',
  'validation_only',
]);

export const DEFAULT_MODULE_BUILDER_RULES = [
  '不要只生成自然语言描述，必须输出结构化模块。',
  '必须区分 prompt_required / context_only / validation_only。',
  '必须区分 MUST / FORBID / SUGGEST / CONTEXT。',
  '如果是图片素材，必须判断它是角色、Logo、风格、镜头、产品还是反例。',
  '如果缺少关键信息，必须先追问，不要直接生成。',
  '输出结果必须可保存为系统模块。',
].join('\n');

export const VIDEO_PROMPT_FORMAT_REQUIREMENTS = [
  '首行创意名标题必须使用“最多两个中文字符 + 三位数字”的格式，例如 (弹力001)。',
  '正文必须先写整段视频总体要求，再给出具体分镜。',
  '每个分镜必须包含：时间 / 景别 / 运镜 / 内容。',
  '分镜时间必须连续、不重叠，并结束在目标总时长。',
  '内容写可拍画面，不写抽象评价。',
  '默认使用正向画面描述，必要限制只放在总述的“限制”字段。',
  '结尾必须包含 (end)。',
].join('\n');

export function resolveModuleBuilderType(intent: string, selectedType: ModuleBuilderType): ResolvedModuleBuilderType {
  if (selectedType !== 'auto') return selectedType;
  const text = intent.toLowerCase();
  if (/提示词|prompt|格式|分镜|景别|运镜/.test(text)) return 'prompt_format';
  if (/logo|标志|字标|品牌露出/.test(text)) return 'logo';
  if (/角色|人物|ip|吉祥物|兔|猫|形象/.test(text)) return 'character';
  if (/风格|质感|色彩|调色|材质|氛围/.test(text)) return 'style';
  if (/镜头|景别|运镜|推入|拉远|横移|跟随/.test(text)) return 'camera';
  if (/素材|图片|参考图|反例|绑定/.test(text)) return 'asset_rule';
  if (/时间|分段|temporal|段落|节奏/.test(text)) return 'temporal';
  return 'rule';
}

export function buildModuleBuilderSystemPrompt(options?: {
  moduleType?: ModuleBuilderType;
  defaultRules?: string;
  sessionRules?: string;
}) {
  const defaultRules = options?.defaultRules?.trim() || DEFAULT_MODULE_BUILDER_RULES;
  const sessionRules = options?.sessionRules?.trim();

  return [
    '你是 Module Builder Agent，负责把管理员对话转换成可保存的模板模块草稿。',
    '你必须只输出 JSON，不要输出 Markdown、解释或额外自然语言。',
    '如果信息不足，输出 {"needsClarification":true,"questions":["..."]}。',
    '如果信息足够，输出 {"needsClarification":false,"moduleType":"...","moduleName":"...","promptBlock":{},"rules":[],"injectionMode":"...","priority":90}。',
    'moduleType 只能是 character、logo、style、camera、rule、asset_rule、temporal、prompt_format。',
    'rules 每项必须包含 ruleType、injectionMode、target、content、priority。',
    'ruleType 只能是 MUST、FORBID、SUGGEST、CONTEXT。',
    'injectionMode 只能是 prompt_required、context_only、validation_only。',
    '提示词格式模块必须遵守现有视频生成 skills 的提示词格式：创意名编号、总体要求、连续分镜、景别、运镜、内容、(end)。',
    options?.moduleType ? `当前管理员选择的模块类型：${options.moduleType}` : '',
    '系统默认生成规则：',
    defaultRules,
    sessionRules ? '本次生成规则：' : '',
    sessionRules || '',
  ].filter(Boolean).join('\n');
}

export function buildModuleBuilderUserPrompt(input: ModuleBuilderGenerateInput) {
  const templateContext = {
    id: input.template.id,
    name: input.template.name,
    version: input.template.version,
    module_bindings: input.template.module_bindings,
    temporal: input.template.temporal,
    active_rules: input.template.rules.filter((rule) => rule.status === 'active'),
    active_assets: input.template.assets.filter((asset) => asset.status === 'active').map((asset) => ({
      id: asset.id,
      type: asset.asset_type,
      label: asset.label,
      reference_image_id: asset.reference_image_id,
    })),
    prompts: input.template.prompts.filter((prompt) => prompt.status === 'active'),
  };

  return JSON.stringify({
    task: 'generate_module_draft',
    selectedModuleType: input.moduleType,
    resolvedModuleType: resolveModuleBuilderType(input.intent, input.moduleType),
    adminIntent: input.intent,
    sessionRules: input.sessionRules,
    contextAssetIds: input.contextAssetIds || [],
    templateContext,
    videoPromptFormatRequirements: VIDEO_PROMPT_FORMAT_REQUIREMENTS,
  }, null, 2);
}

function stripJsonFence(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    return trimmed.slice(firstObject, lastObject + 1);
  }
  return trimmed;
}

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizePriority(value: unknown, fallback = 80) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(1, Math.round(number)));
}

function normalizePromptBlock(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim()) return { content: value.trim() };
  return {};
}

function normalizeRule(value: unknown): ModuleBuilderRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const ruleType = String(source.ruleType || '').toUpperCase();
  const injectionMode = String(source.injectionMode || '');
  const content = cleanString(source.content);
  if (!VALID_RULE_TYPES.has(ruleType as ModuleBuilderRuleType)) return null;
  if (!VALID_INJECTION_MODES.has(injectionMode as ModuleBuilderInjectionMode)) return null;
  if (!content) return null;
  return {
    ruleType: ruleType as ModuleBuilderRuleType,
    injectionMode: injectionMode as ModuleBuilderInjectionMode,
    target: cleanString(source.target, 'global'),
    content,
    priority: normalizePriority(source.priority),
  };
}

function normalizeDraft(raw: Record<string, unknown>): ModuleBuilderDraft | null {
  const moduleType = cleanString(raw.moduleType);
  const moduleName = cleanString(raw.moduleName);
  const promptBlock = normalizePromptBlock(raw.promptBlock);
  const rules = Array.isArray(raw.rules)
    ? raw.rules.map(normalizeRule).filter((rule): rule is ModuleBuilderRule => Boolean(rule))
    : [];
  const injectionMode = cleanString(raw.injectionMode, rules[0]?.injectionMode || '');

  if (!VALID_MODULE_TYPES.has(moduleType as ResolvedModuleBuilderType)) return null;
  if (!VALID_INJECTION_MODES.has(injectionMode as ModuleBuilderInjectionMode)) return null;
  if (!moduleName || Object.keys(promptBlock).length === 0 || rules.length === 0) return null;

  return {
    moduleType: moduleType as ResolvedModuleBuilderType,
    moduleName,
    promptBlock,
    rules,
    injectionMode: injectionMode as ModuleBuilderInjectionMode,
    priority: normalizePriority(raw.priority, Math.max(...rules.map((rule) => rule.priority), 80)),
    target: cleanString(raw.target) || undefined,
    assetBinding: raw.assetBinding && typeof raw.assetBinding === 'object' && !Array.isArray(raw.assetBinding)
      ? raw.assetBinding as Record<string, unknown>
      : null,
  };
}

export function parseModuleBuilderAgentResponse(content: string): ModuleBuilderAgentResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch {
    throw new Error('LLM 未返回可解析 JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM 返回 JSON 不是对象');
  }

  const source = parsed as Record<string, unknown>;
  if (source.needsClarification === true) {
    const questions = Array.isArray(source.questions)
      ? source.questions.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
      : [];
    return { needsClarification: true, questions, raw: parsed };
  }

  const draftSource = source.draft && typeof source.draft === 'object' && !Array.isArray(source.draft)
    ? source.draft as Record<string, unknown>
    : source;
  const draft = normalizeDraft(draftSource);
  if (!draft) return { needsClarification: false, raw: parsed };
  return { needsClarification: false, draft, raw: parsed };
}

export function validateModuleBuilderDraft(draft: ModuleBuilderDraft | null | undefined) {
  const errors: string[] = [];
  if (!draft) return ['缺少结构化模块草稿'];
  if (!VALID_MODULE_TYPES.has(draft.moduleType)) errors.push('moduleType 不合法');
  if (!draft.moduleName.trim()) errors.push('moduleName 不能为空');
  if (!draft.promptBlock || typeof draft.promptBlock !== 'object') errors.push('promptBlock 必须是对象');
  if (!VALID_INJECTION_MODES.has(draft.injectionMode)) errors.push('injectionMode 不合法');
  if (!Number.isFinite(draft.priority) || draft.priority < 1 || draft.priority > 100) errors.push('priority 必须在 1-100');
  if (!Array.isArray(draft.rules) || draft.rules.length === 0) {
    errors.push('rules 至少需要一条规则');
  } else {
    draft.rules.forEach((rule, index) => {
      if (!VALID_RULE_TYPES.has(rule.ruleType)) errors.push(`rules[${index}].ruleType 不合法`);
      if (!VALID_INJECTION_MODES.has(rule.injectionMode)) errors.push(`rules[${index}].injectionMode 不合法`);
      if (!rule.target.trim()) errors.push(`rules[${index}].target 不能为空`);
      if (!rule.content.trim()) errors.push(`rules[${index}].content 不能为空`);
      if (!Number.isFinite(rule.priority) || rule.priority < 1 || rule.priority > 100) errors.push(`rules[${index}].priority 必须在 1-100`);
    });
  }
  return errors;
}

export async function generateModuleBuilderDraftWithLlm(params: {
  settings: MuskApiSettings;
  input: ModuleBuilderGenerateInput;
}): Promise<ModuleBuilderGenerateResult> {
  const completion = await createMuskChatCompletion({
    settings: params.settings,
    messages: [
      {
        role: 'system',
        content: buildModuleBuilderSystemPrompt({
          moduleType: params.input.moduleType,
          defaultRules: DEFAULT_MODULE_BUILDER_RULES,
          sessionRules: params.input.sessionRules,
        }),
      },
      { role: 'user', content: buildModuleBuilderUserPrompt(params.input) },
    ],
    temperature: 0.2,
  });
  const parsed = parseModuleBuilderAgentResponse(completion.content);
  const validationErrors = parsed.needsClarification ? [] : validateModuleBuilderDraft(parsed.draft);

  return {
    ...parsed,
    model: completion.model,
    usage: completion.usage,
    validationErrors,
  };
}
