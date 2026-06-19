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

export type TemplateContextCardMode = 'force' | 'reference';

export type TemplateContextCardBoundImage = {
  source: 'reference_album' | 'upload_history' | 'template_asset' | 'manual';
  id: string | null;
  reference_image_id: string | null;
  asset_id: string | null;
  label: string;
  url: string | null;
  thumbnail_url: string | null;
};

export type TemplateContextCard = {
  id: string;
  title: string;
  content: string;
  mode: TemplateContextCardMode;
  enabled: boolean;
  sort_order: number;
  bound_image: TemplateContextCardBoundImage | null;
  llm_reference: string;
  legacy_block_type?: TemplatePromptBlockType;
  auto_save_status?: 'idle' | 'saving' | 'saved' | 'error';
};

export type TemplateModuleBindings = {
  character?: string;
  logo?: string;
  style?: string;
  camera?: string;
  rules?: string;
  asset_rule?: string;
  temporal?: string;
  prompt_format?: string;
  module_usage?: TemplateModuleUsageMap;
  context_cards?: TemplateContextCard[];
};

export type TemplateModuleKey = 'character' | 'logo' | 'style' | 'camera';
export type TemplateModuleUsage = 'required' | 'reference';
export type TemplateModuleUsageMap = Partial<Record<TemplateModuleKey, TemplateModuleUsage>>;

const TEMPLATE_MODULE_KEYS: TemplateModuleKey[] = ['character', 'logo', 'style', 'camera'];

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
  const bindings: TemplateModuleBindings = {
    character: stringOrUndefined(object.character),
    logo: stringOrUndefined(object.logo),
    style: stringOrUndefined(object.style),
    camera: stringOrUndefined(object.camera),
    rules: stringOrUndefined(object.rules),
    asset_rule: stringOrUndefined(object.asset_rule),
    temporal: stringOrUndefined(object.temporal),
    prompt_format: stringOrUndefined(object.prompt_format),
  };
  const moduleUsage = normalizeModuleUsage(object.module_usage, bindings);
  const contextCards = normalizeContextCards(object.context_cards);
  return {
    ...bindings,
    ...(Object.keys(moduleUsage).length > 0 ? { module_usage: moduleUsage } : {}),
    ...(contextCards.length > 0 ? { context_cards: contextCards } : {}),
  };
}

function normalizeModuleUsage(value: unknown, bindings: TemplateModuleBindings): TemplateModuleUsageMap {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return TEMPLATE_MODULE_KEYS.reduce<TemplateModuleUsageMap>((acc, key) => {
    if (!bindings[key]) return acc;
    acc[key] = source[key] === 'reference' ? 'reference' : 'required';
    return acc;
  }, {});
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

function normalizeContextCardMode(value: unknown): TemplateContextCardMode {
  return value === 'reference' ? 'reference' : 'force';
}

export const CONTEXT_CARD_LABELS: Record<TemplatePromptBlockType, string> = {
  character: '角色设定',
  logo: '品牌标识',
  style: '视觉风格',
  camera: '镜头语言',
  rules: '生成规则',
  asset_rule: '素材规则',
  temporal: '分段节奏',
  prompt_format: '提示词格式',
  global: '全局补充',
};

const CODE_TITLE_LABELS: Record<string, string> = {
  asset_rule: '素材规则',
  brand_ip: '品牌角色',
  brand_logo: '品牌标识',
  camera: '镜头语言',
  character: '角色设定',
  fast_motion: '快节奏镜头',
  global: '全局补充',
  logo: '品牌标识',
  prompt_format: '提示词格式',
  rules: '生成规则',
  style: '视觉风格',
  tech_brand: '科技风格',
  temporal: '分段节奏',
};

function titleKey(value: string) {
  return value.trim().toLowerCase().replace(/[\s/-]+/g, '_').replace(/^_+|_+$/g, '');
}

function translateTitleWords(value: string) {
  return value
    .replace(/brand/gi, '品牌')
    .replace(/logo/gi, '标识')
    .replace(/style/gi, '风格')
    .replace(/camera/gi, '镜头')
    .replace(/prompt/gi, '提示词')
    .replace(/rules?/gi, '规则')
    .replace(/global/gi, '全局')
    .replace(/\bip\b/gi, '角色')
    .replace(/[_/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2')
    .replace(/角色角色/g, '角色')
    .trim();
}

function isCodeLikeTitle(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const hasChinese = /[\u3400-\u9fff]/.test(trimmed);
  const hasCodeSeparator = /[_./:-]/.test(trimmed);
  const asciiOnly = /^[a-z0-9\s_.:/-]+$/i.test(trimmed);
  return (asciiOnly && !hasChinese) || (hasCodeSeparator && asciiOnly);
}

export function normalizeContextCardTitle(
  value: string | null | undefined,
  blockType?: TemplatePromptBlockType,
  fallbackIndex = 1,
) {
  const raw = (value || '').trim();
  const fallback = blockType ? CONTEXT_CARD_LABELS[blockType] : `上下文卡片 ${fallbackIndex}`;
  if (!raw) return fallback;

  const directLabel = CODE_TITLE_LABELS[titleKey(raw)];
  if (directLabel) return directLabel;

  const translated = translateTitleWords(raw);
  if (translated && translated !== raw) {
    const translatedLabel = CODE_TITLE_LABELS[titleKey(translated)];
    if (translatedLabel) return translatedLabel;
    if (!/[a-z]/i.test(translated)) return translated;
  }

  if (isCodeLikeTitle(raw) || /[a-z]/i.test(raw)) return fallback;
  return raw;
}

function normalizeContextCardBoundImage(value: unknown): TemplateContextCardBoundImage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const label = stringOrNull(object.label) || '绑定图片';
  const url = stringOrNull(object.url);
  const thumbnailUrl = stringOrNull(object.thumbnail_url);
  const referenceImageId = stringOrNull(object.reference_image_id);
  const assetId = stringOrNull(object.asset_id);
  const id = stringOrNull(object.id) || referenceImageId || assetId;
  if (!id && !url && !thumbnailUrl) return null;
  const rawSource = stringOrNull(object.source);
  const source = rawSource === 'reference_album' || rawSource === 'upload_history' || rawSource === 'manual'
    ? rawSource
    : 'template_asset';
  return {
    source,
    id,
    reference_image_id: referenceImageId,
    asset_id: assetId,
    label,
    url,
    thumbnail_url: thumbnailUrl,
  };
}

function normalizeContextCards(value: unknown): TemplateContextCard[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<TemplateContextCard[]>((cards, item, index) => {
      const object = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const content = stringOrNull(object.content) || '';
      const rawTitle = stringOrNull(object.title);
      const rawId = stringOrNull(object.id);
      if (!content && !rawTitle && !rawId) return cards;
      const legacyBlockType = object.legacy_block_type ? normalizePromptBlockType(object.legacy_block_type) : undefined;
      const title = normalizeContextCardTitle(rawTitle, legacyBlockType, index + 1);
      cards.push({
        id: rawId || `context-card-${index + 1}`,
        title,
        content,
        mode: normalizeContextCardMode(object.mode),
        enabled: typeof object.enabled === 'boolean' ? object.enabled : true,
        sort_order: normalizeSortOrder(object.sort_order, index + 1),
        bound_image: normalizeContextCardBoundImage(object.bound_image),
        llm_reference: stringOrNull(object.llm_reference) || '',
        legacy_block_type: legacyBlockType,
      });
      return cards;
    }, [])
    .sort((a, b) => a.sort_order - b.sort_order);
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

function contextCardId(blockType: string, index: number) {
  return `card-${blockType}-${index + 1}`;
}

function contextCardModeForBlock(blockType: TemplatePromptBlockType, bindings: TemplateModuleBindings): TemplateContextCardMode {
  if (blockType === 'style' || blockType === 'asset_rule') return 'reference';
  if (blockType === 'character' || blockType === 'logo' || blockType === 'camera') {
    const usage = bindings.module_usage?.[blockType as TemplateModuleKey];
    return usage === 'reference' ? 'reference' : 'force';
  }
  return 'force';
}

function findBoundImageForBlock(blockType: TemplatePromptBlockType, assets: SerializedTemplateAsset[]): TemplateContextCardBoundImage | null {
  const assetType = blockType === 'asset_rule' ? 'product' : blockType;
  const asset = assets.find((item) => item.status === 'active' && item.asset_type === assetType)
    || (blockType === 'global' ? null : assets.find((item) => item.status === 'active' && (item.thumbnail_url || item.url || item.reference_image_id)));
  if (!asset) return null;
  return {
    source: 'template_asset',
    id: asset.id || asset.reference_image_id || asset.url || null,
    reference_image_id: asset.reference_image_id,
    asset_id: null,
    label: asset.label,
    url: asset.url,
    thumbnail_url: asset.thumbnail_url,
  };
}

function buildContextCardsFromLegacy(
  bindings: TemplateModuleBindings,
  prompts: SerializedTemplatePromptBlock[],
  assets: SerializedTemplateAsset[],
  rules: SerializedTemplateRule[],
): TemplateContextCard[] {
  const activePrompts = prompts.filter((prompt) => prompt.status === 'active' && prompt.content.trim());
  const cards = activePrompts.map((prompt, index) => {
    const bindingValue = bindings[prompt.block_type as keyof TemplateModuleBindings];
    const title = normalizeContextCardTitle(
      typeof bindingValue === 'string' ? bindingValue : null,
      prompt.block_type,
      index + 1,
    );
    return {
      id: contextCardId(prompt.block_type, index),
      title,
      content: prompt.content,
      mode: contextCardModeForBlock(prompt.block_type, bindings),
      enabled: true,
      sort_order: prompt.sort_order || index + 1,
      bound_image: findBoundImageForBlock(prompt.block_type, assets),
      llm_reference: '由旧模板结构自动转换，可展开后按当前模板目标调整。',
      legacy_block_type: prompt.block_type,
    };
  });

  if (!cards.some((card) => card.title === CONTEXT_CARD_LABELS.rules) && rules.length > 0) {
    cards.push({
      id: contextCardId('rules', cards.length),
      title: CONTEXT_CARD_LABELS.rules,
      content: rules
        .filter((rule) => rule.status === 'active')
        .map((rule) => `${rule.rule_type.toUpperCase()}：${rule.content}`)
        .join('\n'),
      mode: 'force',
      enabled: true,
      sort_order: cards.length + 1,
      bound_image: null,
      llm_reference: '由旧规则列表自动合并。',
      legacy_block_type: 'rules',
    });
  }

  return cards.sort((a, b) => a.sort_order - b.sort_order);
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
  const moduleBindings = normalizeModuleBindings(template.module_bindings_json);
  const assets = (template.assets || []).map((asset) => ({
    id: asset.id,
    asset_type: normalizeAssetType(asset.asset_type),
    label: asset.label,
    url: asset.url,
    thumbnail_url: asset.thumbnail_url,
    reference_image_id: asset.reference_image_id,
    sort_order: asset.sort_order,
    status: asset.status,
    metadata: parseJsonObject(asset.metadata_json),
  }));
  const rules = (template.rules || []).map((rule) => ({
    id: rule.id,
    rule_type: normalizeRuleType(rule.rule_type),
    content: rule.content,
    priority: rule.priority,
    sort_order: rule.sort_order,
    status: rule.status,
  }));
  const prompts = (template.prompts || []).map((prompt) => ({
    id: prompt.id,
    block_type: normalizePromptBlockType(prompt.block_type),
    content: prompt.content,
    sort_order: prompt.sort_order,
    status: prompt.status,
  }));
  const contextCards = moduleBindings.context_cards?.length
    ? moduleBindings.context_cards
    : buildContextCardsFromLegacy(moduleBindings, prompts, assets, rules);

  return {
    id: template.id,
    template_key: template.template_key,
    name: template.name,
    description: template.description,
    status: template.status,
    version: template.version,
    module_bindings: {
      ...moduleBindings,
      context_cards: contextCards,
    },
    temporal: normalizeTemporal(template.temporal_json),
    defaults: {
      ratio: template.default_ratio,
      duration: template.default_duration,
      resolution: template.default_resolution,
    },
    assets,
    rules,
    prompts,
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
