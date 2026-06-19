import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type {
  ModuleBuilderDraft,
  ModuleBuilderRule,
  ResolvedModuleBuilderType,
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

export const TEMPLATE_MODULE_LIBRARY_KEY = 'template_module_library_v1';

export type TemplateModuleScope = 'template' | 'global';
export type TemplateModuleStatus = 'draft' | 'active' | 'archived';

export type TemplateModuleVersion = {
  version: number;
  created_at: string;
  created_by: string;
  content: ModuleBuilderDraft;
  admin_modified: boolean;
  diff_summary: string[];
  session_rules: string | null;
  prompt_format_source?: string | null;
};

export type TemplateModuleLibraryItem = {
  id: string;
  module_type: ResolvedModuleBuilderType;
  name: string;
  category: string;
  scope: TemplateModuleScope;
  status: TemplateModuleStatus;
  current_version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  source: {
    template_id: string;
    template_name: string;
    agent_run_id?: string | null;
    source_rules?: string | null;
  };
  versions: TemplateModuleVersion[];
};

export type TemplateModuleLibrary = {
  version: 1;
  modules: TemplateModuleLibraryItem[];
  updated_at: string;
};

export type BuildTemplateModuleLibraryItemInput = {
  draft: ModuleBuilderDraft;
  template: SerializedGenerationTemplate;
  actorUserId: string;
  sessionRules?: string | null;
  agentRunId?: string | null;
  scope?: TemplateModuleScope;
  status?: TemplateModuleStatus;
  category?: string;
  existingModule?: TemplateModuleLibraryItem | null;
  adminModified?: boolean;
  diffSummary?: string[];
};

export type TemplateModulePatch = {
  name: string;
  description: string | null;
  status: string;
  version: string;
  defaults: SerializedGenerationTemplate['defaults'];
  module_bindings: TemplateModuleBindings;
  temporal: SerializedGenerationTemplate['temporal'];
  assets: SerializedTemplateAsset[];
  rules: SerializedTemplateRule[];
  prompts: SerializedTemplatePromptBlock[];
};

const RULE_TYPE_MAP: Record<ModuleBuilderRule['ruleType'], TemplateRuleType> = {
  MUST: 'must',
  FORBID: 'forbid',
  SUGGEST: 'suggest',
  CONTEXT: 'context',
};

type TemplateModuleBindingTextKey = Exclude<keyof TemplateModuleBindings, 'module_usage' | 'context_cards'>;

const MODULE_BINDING_MAP: Record<ResolvedModuleBuilderType, TemplateModuleBindingTextKey> = {
  character: 'character',
  logo: 'logo',
  style: 'style',
  camera: 'camera',
  rule: 'rules',
  asset_rule: 'asset_rule',
  temporal: 'temporal',
  prompt_format: 'prompt_format',
};

const PROMPT_BLOCK_MAP: Record<ResolvedModuleBuilderType, TemplatePromptBlockType> = {
  character: 'character',
  logo: 'logo',
  style: 'style',
  camera: 'camera',
  rule: 'rules',
  asset_rule: 'asset_rule',
  temporal: 'temporal',
  prompt_format: 'prompt_format',
};

const MODULE_CATEGORY_MAP: Record<ResolvedModuleBuilderType, string> = {
  character: '角色设定',
  logo: 'Logo / 品牌规范',
  style: '风格参考',
  camera: '镜头语言',
  rule: '规则限制',
  asset_rule: '素材规则',
  temporal: 'Temporal 分段',
  prompt_format: '提示词格式',
};

function nowIso() {
  return new Date().toISOString();
}

function stableModuleId(draft: ModuleBuilderDraft, templateId: string) {
  const hash = crypto
    .createHash('sha1')
    .update(`${templateId}:${draft.moduleType}:${draft.moduleName}`)
    .digest('hex')
    .slice(0, 10);
  return `mod_${draft.moduleType}_${hash}`;
}

function safeString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeLibrary(value: unknown): TemplateModuleLibrary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, modules: [], updated_at: nowIso() };
  }
  const source = value as Partial<TemplateModuleLibrary>;
  return {
    version: 1,
    modules: Array.isArray(source.modules)
      ? source.modules.map(normalizeLibraryItem).filter((item): item is TemplateModuleLibraryItem => Boolean(item))
      : [],
    updated_at: safeString(source.updated_at) || nowIso(),
  };
}

function isTemplateModuleLibraryItem(value: unknown): value is TemplateModuleLibraryItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Partial<TemplateModuleLibraryItem>;
  return Boolean(source.id && source.module_type && source.name && Array.isArray(source.versions));
}

function normalizeLibraryItem(value: unknown): TemplateModuleLibraryItem | null {
  if (!isTemplateModuleLibraryItem(value)) return null;
  return {
    ...value,
    category: safeString(value.category) || MODULE_CATEGORY_MAP[value.module_type] || '未分类',
  };
}

function promptBlockToText(value: Record<string, unknown>) {
  const parts = Object.entries(value)
    .map(([key, item]) => {
      if (typeof item === 'string' && item.trim()) return `${key}: ${item.trim()}`;
      if (item && typeof item === 'object') return `${key}: ${JSON.stringify(item)}`;
      return '';
    })
    .filter(Boolean);
  return parts.join('\n');
}

function inferAssetType(draft: ModuleBuilderDraft): TemplateAssetType {
  if (draft.moduleType === 'logo') return 'logo';
  if (draft.moduleType === 'style') return 'style';
  if (draft.moduleType === 'character') return 'character';
  const raw = safeString(draft.assetBinding?.assetType || draft.assetBinding?.type).toLowerCase();
  if (raw === 'logo' || raw === 'style' || raw === 'product' || raw === 'negative' || raw === 'other') return raw;
  return 'other';
}

function detectDiffSummary(previous: ModuleBuilderDraft | null, next: ModuleBuilderDraft, provided?: string[]) {
  if (provided?.length) return provided;
  if (!previous) return ['新增模块草稿'];
  const changes: string[] = [];
  if (previous.moduleName !== next.moduleName) changes.push('模块名称有调整');
  if (previous.moduleType !== next.moduleType) changes.push('模块类型有调整');
  if (JSON.stringify(previous.promptBlock) !== JSON.stringify(next.promptBlock)) changes.push('PromptBlock 有调整');
  if (JSON.stringify(previous.rules) !== JSON.stringify(next.rules)) changes.push('规则列表有调整');
  return changes.length ? changes : ['管理员确认，无结构变更'];
}

export function buildTemplateModuleLibraryItem(input: BuildTemplateModuleLibraryItemInput): TemplateModuleLibraryItem {
  const now = nowIso();
  const existing = input.existingModule || null;
  const previous = existing?.versions[existing.versions.length - 1]?.content || null;
  const version = existing ? existing.current_version + 1 : 1;
  const id = existing?.id || stableModuleId(input.draft, input.template.id);
  const nextVersion: TemplateModuleVersion = {
    version,
    created_at: now,
    created_by: input.actorUserId,
    content: input.draft,
    admin_modified: input.adminModified === true,
    diff_summary: detectDiffSummary(previous, input.draft, input.diffSummary),
    session_rules: input.sessionRules?.trim() || null,
    prompt_format_source: input.draft.moduleType === 'prompt_format' ? 'video_generation_skills' : null,
  };

  return {
    id,
    module_type: input.draft.moduleType,
    name: input.draft.moduleName,
    category: input.category?.trim() || existing?.category || MODULE_CATEGORY_MAP[input.draft.moduleType],
    scope: input.scope || existing?.scope || 'template',
    status: input.status || existing?.status || 'active',
    current_version: version,
    created_by: existing?.created_by || input.actorUserId,
    updated_by: input.actorUserId,
    created_at: existing?.created_at || now,
    updated_at: now,
    source: {
      template_id: input.template.id,
      template_name: input.template.name,
      agent_run_id: input.agentRunId || existing?.source.agent_run_id || null,
      source_rules: input.sessionRules?.trim() || existing?.source.source_rules || null,
    },
    versions: [...(existing?.versions || []), nextVersion],
  };
}

export function parseTemplateModuleLibrary(value: string | null | undefined): TemplateModuleLibrary {
  if (!value) return { version: 1, modules: [], updated_at: nowIso() };
  try {
    return normalizeLibrary(JSON.parse(value));
  } catch {
    return { version: 1, modules: [], updated_at: nowIso() };
  }
}

export async function getTemplateModuleLibrary(
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const setting = await client.platformSetting.findUnique({ where: { key: TEMPLATE_MODULE_LIBRARY_KEY } });
  return parseTemplateModuleLibrary(setting?.value_json);
}

export function upsertTemplateModuleInLibrary(
  library: TemplateModuleLibrary,
  item: TemplateModuleLibraryItem,
): TemplateModuleLibrary {
  const modules = library.modules.filter((moduleItem) => moduleItem.id !== item.id);
  modules.unshift(item);
  return { version: 1, modules, updated_at: nowIso() };
}

export async function saveTemplateModuleLibrary(
  library: TemplateModuleLibrary,
  updatedBy: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  await client.platformSetting.upsert({
    where: { key: TEMPLATE_MODULE_LIBRARY_KEY },
    update: {
      value_json: JSON.stringify(library),
      updated_by: updatedBy,
    },
    create: {
      key: TEMPLATE_MODULE_LIBRARY_KEY,
      value_json: JSON.stringify(library),
      updated_by: updatedBy,
    },
  });
}

export function buildTemplateModulePatch(
  template: SerializedGenerationTemplate,
  moduleItem: TemplateModuleLibraryItem,
): TemplateModulePatch {
  const currentVersion = moduleItem.versions[moduleItem.versions.length - 1];
  const draft = currentVersion.content;
  const bindingKey = MODULE_BINDING_MAP[draft.moduleType];
  const promptContent = promptBlockToText(draft.promptBlock);
  const nextPrompts = [
    ...template.prompts,
    {
      block_type: PROMPT_BLOCK_MAP[draft.moduleType],
      content: promptContent,
      sort_order: template.prompts.length + 1,
      status: 'active',
    },
  ];
  const nextRules = [
    ...template.rules,
    ...draft.rules.map((rule, index) => ({
      rule_type: RULE_TYPE_MAP[rule.ruleType],
      content: rule.content,
      priority: rule.priority,
      sort_order: template.rules.length + index + 1,
      status: 'active',
    })),
  ];
  const nextAssets = [...template.assets];
  const assetId = safeString(draft.assetBinding?.assetId || draft.assetBinding?.referenceImageId);

  if (draft.assetBinding && (assetId || Object.keys(draft.assetBinding).length > 0)) {
    nextAssets.push({
      asset_type: inferAssetType(draft),
      label: safeString(draft.assetBinding.label) || draft.moduleName,
      url: safeString(draft.assetBinding.url) || null,
      thumbnail_url: safeString(draft.assetBinding.thumbnailUrl || draft.assetBinding.thumbnail_url) || null,
      reference_image_id: assetId || null,
      sort_order: template.assets.length + 1,
      status: 'active',
      metadata: {
        module_id: moduleItem.id,
        module_type: draft.moduleType,
        usage: safeString(draft.assetBinding.usage) || null,
        assetBinding: draft.assetBinding,
      },
    });
  }

  return {
    name: template.name,
    description: template.description,
    status: template.status,
    version: template.version,
    defaults: template.defaults,
    module_bindings: {
      ...template.module_bindings,
      [bindingKey]: moduleItem.id,
    },
    temporal: template.temporal,
    assets: nextAssets,
    rules: nextRules,
    prompts: nextPrompts,
  };
}
