import type {
  StudioAssetInput,
  StudioAssetRole,
  StudioAssetType,
  StudioJsonValue,
  StudioTemplateField,
  StudioTemplateRecipe,
} from './types';

export const TEMPLATE_STUDIO_LIMITS = {
  name: 120,
  groupName: 80,
  description: 2000,
  instruction: 12000,
  prompt: 12000,
  llmInput: 24000,
  llmOutput: 16000,
  jsonBytes: 64 * 1024,
  fields: 24,
  slots: 8,
  options: 30,
  assets: 12,
  activeLlmRunsPerUser: 1,
  llmRequestsPerUserWindow: 5,
  llmRequestWindowMs: 10 * 60 * 1000,
  maxPendingLlmRuns: 50,
} as const;

const assetRoles = new Set<StudioAssetRole>(['reference', 'first', 'last']);
const assetTypes = new Set<StudioAssetType>(['image', 'video', 'audio']);
const generationModes = new Set(['all_in_one_reference', 'first_last_frame', 'smart_multi_frame']);
const ratios = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const resolutions = new Set(['480p', '720p', '1080p']);
const parameterKeys = new Set([
  'provider', 'engine', 'model', 'generationMode', 'generation_mode', 'mode',
  'ratio', 'duration', 'resolution', 'seed', 'generateAudio', 'generate_audio',
  'returnLastFrame', 'return_last_frame', 'watermark', 'draft', 'h3LoraId',
  'h3_lora_id', 'loraId', 'lora_id', 'presetId', 'preset_id',
]);
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

export class StudioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioValidationError';
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StudioValidationError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string, max: number, options: { trim?: boolean; required?: boolean } = {}) {
  if (typeof value !== 'string') throw new StudioValidationError(`${label}必须是文本`);
  const result = options.trim ? value.trim() : value;
  if (options.required && !result.trim()) throw new StudioValidationError(`${label}不能为空`);
  if (result.length > max) throw new StudioValidationError(`${label}不能超过 ${max} 个字符`);
  return result;
}

function safeJsonValue(value: unknown, depth = 0): StudioJsonValue {
  if (depth > 8) throw new StudioValidationError('数据嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > 4000) throw new StudioValidationError('单个文本字段不能超过 4000 个字符');
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 100) throw new StudioValidationError('数组项目过多');
    return value.map((item) => safeJsonValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, StudioJsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) throw new StudioValidationError('对象包含不允许的字段');
      if (key.length > 64) throw new StudioValidationError('对象字段名过长');
      output[key] = safeJsonValue(child, depth + 1);
    }
    return output;
  }
  throw new StudioValidationError('包含不支持的数据类型');
}

function boundedRecord(value: unknown, label: string, maxBytes: number) {
  const record = objectRecord(value, label);
  const normalized = safeJsonValue(record);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new StudioValidationError(`${label}必须是对象`);
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > maxBytes) {
    throw new StudioValidationError(`${label}数据过大`);
  }
  return normalized as Record<string, StudioJsonValue>;
}

function normalizeField(value: unknown): StudioTemplateField {
  const input = objectRecord(value, '模板字段');
  const key = boundedText(input.key, '字段 key', 48, { trim: true, required: true });
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) throw new StudioValidationError('字段 key 格式无效');
  const label = boundedText(input.label, '字段名称', 80, { trim: true, required: true });
  const required = input.required === true;
  const type = input.type;
  if (type === 'text' || type === 'textarea') {
    const maxLength = input.maxLength === undefined ? undefined : Number(input.maxLength);
    if (maxLength !== undefined && (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 4000)) {
      throw new StudioValidationError(`字段 ${label} 的长度限制无效`);
    }
    const defaultValue = input.defaultValue === undefined ? undefined : boundedText(input.defaultValue, `${label}默认值`, maxLength || 1000);
    return { key, label, type, required, ...(maxLength ? { maxLength } : {}), ...(defaultValue !== undefined ? { defaultValue } : {}) };
  }
  if (type === 'select') {
    if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > TEMPLATE_STUDIO_LIMITS.options) {
      throw new StudioValidationError(`字段 ${label} 的选项数量无效`);
    }
    const options = input.options.map((item) => boundedText(item, `${label}选项`, 120, { trim: true, required: true }));
    if (new Set(options).size !== options.length) throw new StudioValidationError(`字段 ${label} 有重复选项`);
    const defaultValue = input.defaultValue === undefined ? undefined : boundedText(input.defaultValue, `${label}默认值`, 120);
    if (defaultValue !== undefined && !options.includes(defaultValue)) throw new StudioValidationError(`字段 ${label} 的默认值不在选项内`);
    return { key, label, type, required, options, ...(defaultValue !== undefined ? { defaultValue } : {}) };
  }
  if (type === 'number') {
    const min = input.min === undefined ? undefined : Number(input.min);
    const max = input.max === undefined ? undefined : Number(input.max);
    const defaultValue = input.defaultValue === undefined ? undefined : Number(input.defaultValue);
    if ([min, max, defaultValue].some((item) => item !== undefined && !Number.isFinite(item))) {
      throw new StudioValidationError(`字段 ${label} 的数值范围无效`);
    }
    if (min !== undefined && max !== undefined && min > max) throw new StudioValidationError(`字段 ${label} 的最小值大于最大值`);
    if (defaultValue !== undefined && ((min !== undefined && defaultValue < min) || (max !== undefined && defaultValue > max))) {
      throw new StudioValidationError(`字段 ${label} 的默认值超出范围`);
    }
    return { key, label, type, required, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(defaultValue !== undefined ? { defaultValue } : {}) };
  }
  if (type === 'toggle') {
    if (input.defaultValue !== undefined && typeof input.defaultValue !== 'boolean') throw new StudioValidationError(`字段 ${label} 的默认值无效`);
    return { key, label, type, ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue as boolean } : {}) };
  }
  throw new StudioValidationError(`字段 ${label} 的类型不受支持`);
}

export function normalizeRecipe(value: unknown): StudioTemplateRecipe {
  const input = objectRecord(value, 'recipe');
  const instruction = boundedText(input.instruction, '模板要求', TEMPLATE_STUDIO_LIMITS.instruction, { trim: true, required: true });
  if (!Array.isArray(input.fields) || input.fields.length > TEMPLATE_STUDIO_LIMITS.fields) throw new StudioValidationError('模板字段数量无效');
  const fields = input.fields.map(normalizeField);
  if (new Set(fields.map((field) => field.key)).size !== fields.length) throw new StudioValidationError('模板字段 key 不能重复');
  if (!Array.isArray(input.assetSlots) || input.assetSlots.length > TEMPLATE_STUDIO_LIMITS.slots) throw new StudioValidationError('素材槽位数量无效');
  const slotKeys = new Set<string>();
  const assetSlots = input.assetSlots.map((value) => {
    const slot = objectRecord(value, '素材槽位');
    const key = boundedText(slot.key, '素材槽位 key', 48, { trim: true, required: true });
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || slotKeys.has(key)) throw new StudioValidationError('素材槽位 key 无效或重复');
    slotKeys.add(key);
    const label = boundedText(slot.label, '素材槽位名称', 80, { trim: true, required: true });
    if (!assetRoles.has(slot.role as StudioAssetRole) || !Array.isArray(slot.types) || !slot.types.length) throw new StudioValidationError(`素材槽位 ${label} 配置无效`);
    const types = slot.types.map((type) => {
      if (!assetTypes.has(type as StudioAssetType)) throw new StudioValidationError(`素材槽位 ${label} 的类型无效`);
      return type as StudioAssetType;
    });
    if ((slot.role === 'first' || slot.role === 'last') && types.some((type) => type !== 'image')) {
      throw new StudioValidationError('首帧和尾帧只支持图片');
    }
    const maxItems = slot.maxItems === undefined ? (slot.role === 'reference' ? TEMPLATE_STUDIO_LIMITS.assets : 1) : Number(slot.maxItems);
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > TEMPLATE_STUDIO_LIMITS.assets || (slot.role !== 'reference' && maxItems > 1)) {
      throw new StudioValidationError(`素材槽位 ${label} 的数量上限无效`);
    }
    return { key, label, role: slot.role as StudioAssetRole, types, required: slot.required === true, maxItems };
  });
  return {
    instruction,
    fields,
    assetSlots,
    defaultParameters: normalizeParameters(input.defaultParameters ?? {}),
  };
}

export function normalizeParameters(value: unknown) {
  const input = boundedRecord(value, 'parameters', 8192);
  const result: Record<string, StudioJsonValue> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!parameterKeys.has(key) && !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) throw new StudioValidationError(`参数名 ${key} 无效`);
    if (key === 'provider' || key === 'engine') {
      if (typeof item !== 'string' || !['seedance', 'h3'].includes(item)) throw new StudioValidationError(`${key} 参数无效`);
      result[key] = item;
    } else if (key === 'generationMode' || key === 'generation_mode' || key === 'mode') {
      if (typeof item !== 'string' || !generationModes.has(item)) throw new StudioValidationError(`${key} 参数无效`);
      result[key] = item;
    } else if (key === 'ratio') {
      if (typeof item !== 'string' || !ratios.has(item)) throw new StudioValidationError('ratio 参数无效');
      result[key] = item;
    } else if (key === 'resolution') {
      if (typeof item !== 'string' || !resolutions.has(item)) throw new StudioValidationError('resolution 参数无效');
      result[key] = item;
    } else if (key === 'model' || key === 'h3LoraId' || key === 'h3_lora_id' || key === 'loraId' || key === 'lora_id' || key === 'presetId' || key === 'preset_id') {
      result[key] = boundedText(item, key, 160, { trim: true, required: true });
    } else if (key === 'duration') {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 4 || item > 30) throw new StudioValidationError('duration 参数必须为 4 到 30 秒的整数');
      result[key] = item;
    } else if (key === 'seed') {
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < -1) throw new StudioValidationError('seed 参数必须是 -1 或非负安全整数');
      result[key] = item;
    } else if (['generateAudio', 'generate_audio', 'returnLastFrame', 'return_last_frame', 'watermark', 'draft'].includes(key)) {
      if (typeof item !== 'boolean') throw new StudioValidationError(`${key} 参数必须是布尔值`);
      result[key] = item;
    } else {
      // Provider-specific settings are preserved; the generation handoff validates what it can consume.
      result[key] = item;
    }
  }
  return result;
}

export function normalizeValues(
  value: unknown,
  recipe: StudioTemplateRecipe | null,
  options: { mode?: 'strict' | 'draft' } = {},
) {
  const allowIncomplete = options.mode === 'draft';
  const values = boundedRecord(value, 'values', 16 * 1024);
  if (Object.keys(values).length > TEMPLATE_STUDIO_LIMITS.fields) throw new StudioValidationError('填写字段过多');
  const fields = new Map((recipe?.fields || []).map((field) => [field.key, field]));
  for (const [key, item] of Object.entries(values)) {
    if (recipe && !fields.has(key)) throw new StudioValidationError(`字段 ${key} 不属于当前模板版本`);
    const field = fields.get(key);
    if (!field) continue;
    if (field.type === 'text' || field.type === 'textarea') {
      if (typeof item !== 'string' || item.length > (field.maxLength || 4000)) throw new StudioValidationError(`字段 ${field.label} 的内容无效`);
    } else if (field.type === 'select') {
      if (typeof item !== 'string' || (item === '' ? !allowIncomplete : !field.options.includes(item))) {
        throw new StudioValidationError(`字段 ${field.label} 的选项无效`);
      }
    } else if (field.type === 'number') {
      if (item === '' && allowIncomplete) continue;
      if (typeof item !== 'number' || !Number.isFinite(item)
        || (allowIncomplete && Math.abs(item) > Number.MAX_SAFE_INTEGER)
        || (!allowIncomplete && ((field.min !== undefined && item < field.min) || (field.max !== undefined && item > field.max)))) {
        throw new StudioValidationError(`字段 ${field.label} 的数值无效`);
      }
    } else if (typeof item !== 'boolean') {
      throw new StudioValidationError(`字段 ${field.label} 的开关值无效`);
    }
  }
  if (recipe && !allowIncomplete) {
    for (const field of recipe.fields) {
      if ('required' in field && field.required && (values[field.key] === undefined || values[field.key] === null || values[field.key] === '')) {
        throw new StudioValidationError(`请填写${field.label}`);
      }
    }
  }
  return values;
}

export function normalizeAssets(value: unknown, recipe: StudioTemplateRecipe | null = null, requireRequiredSlots = false): StudioAssetInput[] {
  if (!Array.isArray(value) || value.length > TEMPLATE_STUDIO_LIMITS.assets) throw new StudioValidationError('素材数量无效');
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const slots = recipe?.assetSlots || [];
  const assets = value.map((item) => {
    const input = objectRecord(item, '素材');
    const assetId = boundedText(input.assetId, 'assetId', 120, { trim: true, required: true });
    if (seen.has(assetId)) throw new StudioValidationError('同一素材不能重复添加');
    seen.add(assetId);
    if (!assetRoles.has(input.role as StudioAssetRole) || !assetTypes.has(input.type as StudioAssetType)) throw new StudioValidationError('素材角色或类型无效');
    if ((input.role === 'first' || input.role === 'last') && input.type !== 'image') throw new StudioValidationError('首帧和尾帧只支持图片');
    let slotKey: string | undefined;
    if (input.slotKey !== undefined) {
      slotKey = boundedText(input.slotKey, '素材槽位 key', 48, { trim: true, required: true });
      const slot = slots.find((entry) => entry.key === slotKey);
      if (!slot || slot.role !== input.role || !slot.types.includes(input.type as StudioAssetType)) throw new StudioValidationError('素材与所选槽位不匹配');
    } else if (slots.length) {
      const matching = slots.filter((slot) => slot.role === input.role && slot.types.includes(input.type as StudioAssetType));
      if (matching.length !== 1) throw new StudioValidationError(matching.length ? '该素材需要指定 slotKey' : '素材不属于当前模板的可用槽位');
      slotKey = matching[0].key;
    }
    if (slotKey) {
      const slot = slots.find((entry) => entry.key === slotKey)!;
      const count = (counts.get(slotKey) || 0) + 1;
      if (count > (slot.maxItems || 1)) throw new StudioValidationError(`素材槽位 ${slot.label} 已达到数量上限`);
      counts.set(slotKey, count);
    }
    return { assetId, role: input.role as StudioAssetInput['role'], type: input.type as StudioAssetInput['type'], ...(slotKey ? { slotKey } : {}) };
  });
  if (requireRequiredSlots) {
    const missing = slots.find((slot) => slot.required && !counts.get(slot.key));
    if (missing) throw new StudioValidationError(`请为“${missing.label}”选择素材`);
  }
  return assets;
}

export function normalizeName(value: unknown) {
  return boundedText(value, '名称', TEMPLATE_STUDIO_LIMITS.name, { trim: true, required: true });
}

export function normalizeGroupName(value: unknown) {
  return boundedText(value, '分组', TEMPLATE_STUDIO_LIMITS.groupName, { trim: true, required: true });
}

export function normalizeDescription(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  return boundedText(value, '说明', TEMPLATE_STUDIO_LIMITS.description);
}

export function normalizePrompt(value: unknown) {
  return boundedText(value, '提示词', TEMPLATE_STUDIO_LIMITS.prompt);
}

export function parseJsonRecord(value: string, label: string): Record<string, StudioJsonValue> {
  try {
    return boundedRecord(JSON.parse(value), label, TEMPLATE_STUDIO_LIMITS.jsonBytes);
  } catch (error) {
    if (error instanceof StudioValidationError) throw error;
    throw new StudioValidationError(`${label}快照无法读取`);
  }
}

export function parseJsonArray<T>(value: string, label: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('not array');
    return parsed as T[];
  } catch {
    throw new StudioValidationError(`${label}快照无法读取`);
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
