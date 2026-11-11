import { CONFIG } from './vocabulary';
/** Serializable definitions. Editing a label never changes its ID. */
export type FusionScope = 'builtin' | 'private' | 'shared';
export type FusionGenerationKind = 'trait' | 'source' | 'concept' | 'mechanism' | 'personality' | 'equipment' | 'signature' | 'entity' | 'physique' | 'body-card';
type FusionDefinition = {
  id: string; version: string; enabled: boolean; scope: FusionScope; ownerId: string | null;
  nameZh: string; nameEn: string; descriptionZh: string; descriptionEn: string;
  aliases: string[]; tags: string[]; sortOrder: number;
};
export type FusionCategory = FusionDefinition & {
  group: 'fusion' | 'body' | 'extra'; multi: boolean; randomMax: number; generationKind: FusionGenerationKind;
  legacyId?: string; exclusive?: string[]; incompatible?: [string, string][];
};
export type FusionTermData = { group?: string;
  source?: { shape: string; shapeEn: string; anchor: string; anchorEn: string; root: string };
  concept?: { prop: string; propEn: string; mood: string; moodEn: string; suffix: string };
  bodyTraits?: Array<{ id: string; zh: string; en: string }>;
};
export type FusionTerm = FusionDefinition & { categoryId: string; legacyValue?: string; data?: FusionTermData };
export type FusionCatalogue = { version: string; categories: FusionCategory[]; terms: FusionTerm[] };
export const FUSION_CATALOGUE_VERSION = 'builtin-1';
export const builtinCategoryId = (id: string) => `dimension:${id}`;
export const builtinTermId = (categoryId: string, value: string) => `builtin:${categoryId}:${encodeURIComponent(value)}`;
export const isExtensionId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, max: number) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
const strings = (value: unknown, max: number) => Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every(item => text(item, 700));
export const FUSION_BODY_TRAIT_IDS = ['headRatio', 'silhouette', 'stature', 'build', 'torsoLength', 'armLength', 'legLength', 'shoulderHips', 'headBody', 'exaggeration', 'deformation', 'distribution', 'shoulderFeet', 'center', 'symmetry', 'headScale'];
export function validateCatalogueTerm(category: FusionCategory, term: FusionTerm): void {
  const data = term.data;
  if (data !== undefined) {
    if (!record(data) || Object.keys(data).some(key => !['group', 'source', 'concept', 'bodyTraits'].includes(key)) || data.group !== undefined && !text(data.group, 100)) throw new Error('词条语义字段无效。');
    for (const [kind, keys] of [['source', ['shape', 'shapeEn', 'anchor', 'anchorEn', 'root']], ['concept', ['prop', 'propEn', 'mood', 'moodEn', 'suffix']]] as const) {
      const value = data[kind];
      if (value !== undefined && (!record(value) || Object.keys(value).some(key => !(keys as readonly string[]).includes(key)) || keys.some(key => !text((value as Record<string, unknown>)[key], 2000)))) throw new Error('母体/跨界词条须补齐中英生成语义。');
    }
    if (data.bodyTraits !== undefined && (!Array.isArray(data.bodyTraits) || !data.bodyTraits.length || data.bodyTraits.length > 16 || new Set(data.bodyTraits.map(value => value.id)).size !== data.bodyTraits.length || data.bodyTraits.some(value => !record(value) || !FUSION_BODY_TRAIT_IDS.includes(value.id as string) || !text(value.zh, 2000) || !text(value.en, 4000)))) throw new Error('身形词条须映射有效的身形属性和中英描述。');
  }
  if (category.generationKind === 'trait') return;
  if (category.generationKind === 'body-card') {
    if (term.scope !== 'builtin' && !data?.bodyTraits?.length) throw new Error('新增身形词条须填写身形属性语义。');
    return;
  }
  const dimension = CONFIG.find(dimension => dimension.id === category.generationKind);
  if (!dimension || !data?.group || !(dimension.tags as readonly string[]).includes(data.group)) throw new Error('新增专属词条须指定原类别范围。');
  if (category.generationKind === 'source' && !data.source || category.generationKind === 'concept' && !data.concept) throw new Error('新增母体或跨界词条须补齐专属生成语义。');
}
function definition(value: unknown): FusionDefinition {
  if (!record(value) || !text(value.id, 700) || !text(value.version, 120) || typeof value.enabled !== 'boolean'
    || !['builtin', 'private', 'shared'].includes(String(value.scope)) || !(value.ownerId === null || text(value.ownerId, 120))
    || value.scope === 'builtin' && value.ownerId !== null || value.scope === 'private' && value.ownerId === null
    || !text(value.nameZh, 100) || !text(value.nameEn, 180) || !text(value.descriptionZh, 2000) || !text(value.descriptionEn, 4000)
    || !strings(value.aliases, 30) || !strings(value.tags, 30) || !Number.isSafeInteger(value.sortOrder)
    || value.scope !== 'builtin' && !isExtensionId(value.id as string)) throw new Error('词库定义格式无效，请保留当前内容并刷新目录。');
  return { id: value.id as string, version: value.version as string, enabled: value.enabled, scope: value.scope as FusionScope, ownerId: value.ownerId as string | null,
    nameZh: value.nameZh as string, nameEn: value.nameEn as string, descriptionZh: value.descriptionZh as string, descriptionEn: value.descriptionEn as string,
    aliases: [...value.aliases as string[]], tags: [...value.tags as string[]], sortOrder: value.sortOrder as number };
}
export function parseFusionCatalogue(input: unknown): FusionCatalogue {
  if (!record(input) || !text(input.version, 120) || !Array.isArray(input.categories) || !Array.isArray(input.terms)
    || input.categories.length > 500 || input.terms.length > 20000) throw new Error('词库快照格式无效，请保留当前内容并刷新目录。');
  const categories: FusionCategory[] = input.categories.map(value => {
    const base = definition(value);
    if (!record(value) || !['fusion', 'body', 'extra'].includes(String(value.group)) || typeof value.multi !== 'boolean'
      || !Number.isInteger(value.randomMax) || Number(value.randomMax) < 1 || Number(value.randomMax) > 100
      || !['trait', 'source', 'concept', 'mechanism', 'personality', 'equipment', 'signature', 'entity', 'physique', 'body-card'].includes(String(value.generationKind))
      || base.scope !== 'builtin' && (value.generationKind !== 'trait' || value.legacyId !== undefined) || value.legacyId !== undefined && !text(value.legacyId, 100)
      || value.exclusive !== undefined && !strings(value.exclusive, 200)
      || value.incompatible !== undefined && (!Array.isArray(value.incompatible) || value.incompatible.length > 200 || value.incompatible.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(id => !text(id, 700))))) throw new Error('词库类别规则无效。');
    return { ...base, group: value.group as FusionCategory['group'], multi: value.multi, randomMax: Number(value.randomMax), generationKind: value.generationKind as FusionGenerationKind,
      ...(value.legacyId !== undefined ? { legacyId: value.legacyId as string } : {}), ...(value.exclusive !== undefined ? { exclusive: [...value.exclusive as string[]] } : {}),
      ...(value.incompatible !== undefined ? { incompatible: (value.incompatible as [string, string][]).map(pair => [...pair] as [string, string]) } : {}) };
  });
  const ids = new Set(categories.map(category => category.id));
  if (ids.size !== categories.length) throw new Error('词库类别 ID 重复。');
  const terms: FusionTerm[] = input.terms.map(value => {
    const base = definition(value);
    if (!record(value) || typeof value.categoryId !== 'string' || !ids.has(value.categoryId) || value.legacyValue !== undefined && !text(value.legacyValue, 180)) throw new Error('词库词条归属无效。');
    const term: FusionTerm = { ...base, categoryId: value.categoryId, ...(value.legacyValue !== undefined ? { legacyValue: value.legacyValue as string } : {}), ...(value.data !== undefined ? { data: structuredClone(value.data) as FusionTermData } : {}) };
    validateCatalogueTerm(categories.find(category => category.id === term.categoryId)!, term);
    return term;
  });
  if (new Set(terms.map(term => term.id)).size !== terms.length) throw new Error('词库词条 ID 重复。');
  return { version: input.version as string, categories, terms };
}
