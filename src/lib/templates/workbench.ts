export type TemplateRuleType = 'must' | 'forbid' | 'suggest' | 'context';
export type TemplateAssetType = 'character' | 'logo' | 'style' | 'product' | 'negative' | 'other';
export type TemplatePromptBlockType =
  | 'character'
  | 'logo'
  | 'style'
  | 'camera'
  | 'rules'
  | 'asset_rule'
  | 'temporal'
  | 'prompt_format'
  | 'global';

export type TemplateModuleBindings = {
  character?: string;
  logo?: string;
  style?: string;
  camera?: string;
  rules?: string;
  asset_rule?: string;
  temporal?: string;
  prompt_format?: string;
};

export type TemplateTemporalConfig = {
  enabled: boolean;
  segment: number;
  handoff: boolean;
};

export type SerializedTemplateAsset = {
  id?: string;
  asset_type: TemplateAssetType;
  label: string;
  url: string | null;
  thumbnail_url: string | null;
  reference_image_id: string | null;
  sort_order: number;
  status: string;
  metadata: Record<string, unknown>;
};

export type SerializedTemplateRule = {
  id?: string;
  rule_type: TemplateRuleType;
  content: string;
  priority: number;
  sort_order: number;
  status: string;
};

export type SerializedTemplatePromptBlock = {
  id?: string;
  block_type: TemplatePromptBlockType;
  content: string;
  sort_order: number;
  status: string;
};

export type SerializedGenerationTemplate = {
  id: string;
  template_key: string;
  name: string;
  description: string | null;
  status: string;
  version: string;
  module_bindings: TemplateModuleBindings;
  temporal: TemplateTemporalConfig;
  defaults: {
    ratio: string | null;
    duration: number | null;
    resolution: string | null;
  };
  assets: SerializedTemplateAsset[];
  rules: SerializedTemplateRule[];
  prompts: SerializedTemplatePromptBlock[];
  created_by: string;
  updated_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type TemplateRecord = {
  id: string;
  template_key: string;
  name: string;
  description: string | null;
  status: string;
  version: string;
  module_bindings_json: string;
  temporal_json: string;
  default_ratio: string | null;
  default_duration: number | null;
  default_resolution: string | null;
  created_by: string;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  assets?: Array<{
    id: string;
    asset_type: string;
    label: string;
    url: string | null;
    thumbnail_url: string | null;
    reference_image_id: string | null;
    sort_order: number;
    status: string;
    metadata_json: string | null;
  }>;
  rules?: Array<{
    id: string;
    rule_type: string;
    content: string;
    priority: number;
    sort_order: number;
    status: string;
  }>;
  prompts?: Array<{
    id: string;
    block_type: string;
    content: string;
    sort_order: number;
    status: string;
  }>;
};

export const TEMPLATE_INCLUDE = {
  assets: { orderBy: [{ sort_order: 'asc' as const }, { created_at: 'asc' as const }] },
  rules: { orderBy: [{ rule_type: 'asc' as const }, { sort_order: 'asc' as const }] },
  prompts: { orderBy: [{ sort_order: 'asc' as const }, { block_type: 'asc' as const }] },
};

const DEFAULT_TEMPORAL: TemplateTemporalConfig = { enabled: true, segment: 15, handoff: false };

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeModuleBindings(value: unknown): TemplateModuleBindings {
  const source = typeof value === 'string' ? parseJsonObject(value) : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const object = source as Record<string, unknown>;
  return {
    character: stringOrUndefined(object.character),
    logo: stringOrUndefined(object.logo),
    style: stringOrUndefined(object.style),
    camera: stringOrUndefined(object.camera),
    rules: stringOrUndefined(object.rules),
    asset_rule: stringOrUndefined(object.asset_rule),
    temporal: stringOrUndefined(object.temporal),
    prompt_format: stringOrUndefined(object.prompt_format),
  };
}

function normalizeTemporal(value: unknown): TemplateTemporalConfig {
  const source = typeof value === 'string' ? parseJsonObject(value) : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return DEFAULT_TEMPORAL;
  const object = source as Record<string, unknown>;
  const segment = Number(object.segment);
  return {
    enabled: typeof object.enabled === 'boolean' ? object.enabled : DEFAULT_TEMPORAL.enabled,
    segment: Number.isFinite(segment) && segment > 0 ? Math.min(60, Math.max(5, Math.round(segment))) : DEFAULT_TEMPORAL.segment,
    handoff: typeof object.handoff === 'boolean' ? object.handoff : DEFAULT_TEMPORAL.handoff,
  };
}

function stringOrUndefined(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeStatus(value: unknown, fallback = 'active') {
  return value === 'draft' || value === 'active' || value === 'archived' ? value : fallback;
}

function normalizeItemStatus(value: unknown) {
  return value === 'disabled' || value === 'archived' ? value : 'active';
}

function normalizeRuleType(value: unknown): TemplateRuleType {
  return value === 'forbid' || value === 'suggest' || value === 'context' ? value : 'must';
}

function normalizeAssetType(value: unknown): TemplateAssetType {
  return value === 'logo' || value === 'style' || value === 'product' || value === 'negative' || value === 'other'
    ? value
    : 'character';
}

function normalizePromptBlockType(value: unknown): TemplatePromptBlockType {
  return value === 'logo'
    || value === 'style'
    || value === 'camera'
    || value === 'rules'
    || value === 'asset_rule'
    || value === 'temporal'
    || value === 'prompt_format'
    || value === 'global'
    ? value
    : 'character';
}

function normalizeSortOrder(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function normalizePriority(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.round(parsed))) : 50;
}

export function normalizeTemplateKey(value: unknown, fallbackName: string) {
  const raw = typeof value === 'string' && value.trim() ? value : fallbackName;
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'template';
}

export function serializeGenerationTemplate(template: TemplateRecord): SerializedGenerationTemplate {
  return {
    id: template.id,
    template_key: template.template_key,
    name: template.name,
    description: template.description,
    status: template.status,
    version: template.version,
    module_bindings: normalizeModuleBindings(template.module_bindings_json),
    temporal: normalizeTemporal(template.temporal_json),
    defaults: {
      ratio: template.default_ratio,
      duration: template.default_duration,
      resolution: template.default_resolution,
    },
    assets: (template.assets || []).map((asset) => ({
      id: asset.id,
      asset_type: normalizeAssetType(asset.asset_type),
      label: asset.label,
      url: asset.url,
      thumbnail_url: asset.thumbnail_url,
      reference_image_id: asset.reference_image_id,
      sort_order: asset.sort_order,
      status: asset.status,
      metadata: parseJsonObject(asset.metadata_json),
    })),
    rules: (template.rules || []).map((rule) => ({
      id: rule.id,
      rule_type: normalizeRuleType(rule.rule_type),
      content: rule.content,
      priority: rule.priority,
      sort_order: rule.sort_order,
      status: rule.status,
    })),
    prompts: (template.prompts || []).map((prompt) => ({
      id: prompt.id,
      block_type: normalizePromptBlockType(prompt.block_type),
      content: prompt.content,
      sort_order: prompt.sort_order,
      status: prompt.status,
    })),
    created_by: template.created_by,
    updated_by: template.updated_by,
    created_at: template.created_at,
    updated_at: template.updated_at,
  };
}

export function buildTemplateWritePayload(body: Record<string, unknown>, userId: string) {
  const name = stringOrNull(body.name);
  if (!name) throw new Error('模板名称不能为空');
  const moduleBindings = normalizeModuleBindings(body.module_bindings);
  const temporal = normalizeTemporal(body.temporal);
  return {
    data: {
      template_key: normalizeTemplateKey(body.template_key, name),
      name,
      description: stringOrNull(body.description),
      status: normalizeStatus(body.status),
      version: stringOrNull(body.version) || 'v1',
      module_bindings_json: JSON.stringify(moduleBindings),
      temporal_json: JSON.stringify(temporal),
      default_ratio: stringOrNull(body.defaults && typeof body.defaults === 'object' ? (body.defaults as Record<string, unknown>).ratio : body.default_ratio),
      default_duration: numberOrNull(body.defaults && typeof body.defaults === 'object' ? (body.defaults as Record<string, unknown>).duration : body.default_duration),
      default_resolution: stringOrNull(body.defaults && typeof body.defaults === 'object' ? (body.defaults as Record<string, unknown>).resolution : body.default_resolution),
      updated_by: userId,
    },
    assets: normalizeAssets(body.assets),
    rules: normalizeRules(body.rules),
    prompts: normalizePrompts(body.prompts),
  };
}

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function normalizeAssets(value: unknown): SerializedTemplateAsset[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const object = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const label = stringOrNull(object.label);
      if (!label) return null;
      return {
        asset_type: normalizeAssetType(object.asset_type),
        label,
        url: stringOrNull(object.url),
        thumbnail_url: stringOrNull(object.thumbnail_url),
        reference_image_id: stringOrNull(object.reference_image_id),
        sort_order: normalizeSortOrder(object.sort_order, index + 1),
        status: normalizeItemStatus(object.status),
        metadata: parseJsonObject(typeof object.metadata === 'string' ? object.metadata : JSON.stringify(object.metadata || {})),
      };
    })
    .filter((item): item is SerializedTemplateAsset => Boolean(item));
}

function normalizeRules(value: unknown): SerializedTemplateRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const object = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const content = stringOrNull(object.content);
      if (!content) return null;
      return {
        rule_type: normalizeRuleType(object.rule_type),
        content,
        priority: normalizePriority(object.priority),
        sort_order: normalizeSortOrder(object.sort_order, index + 1),
        status: normalizeItemStatus(object.status),
      };
    })
    .filter((item): item is SerializedTemplateRule => Boolean(item));
}

function normalizePrompts(value: unknown): SerializedTemplatePromptBlock[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const object = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const content = stringOrNull(object.content);
      if (!content) return null;
      return {
        block_type: normalizePromptBlockType(object.block_type),
        content,
        sort_order: normalizeSortOrder(object.sort_order, index + 1),
        status: normalizeItemStatus(object.status),
      };
    })
    .filter((item): item is SerializedTemplatePromptBlock => Boolean(item));
}
