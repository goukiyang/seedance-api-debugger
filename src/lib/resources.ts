import path from 'path';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import type { GenerationDraftPatch } from '@/lib/generation-draft';

export type ResourceCategory = 'image_collection' | 'brand_asset' | 'prompt_template' | 'example_case' | 'other';

export interface ResourceReference {
  url: string;
  name: string;
  role: string;
  thumbnailUrl: string | null;
}

export interface ResourceDescriptor {
  id: string;
  name: string;
  resourceType: string;
  category: ResourceCategory;
  previewUrl: string | null;
  summary: string;
  promptText: string | null;
  parameters: GenerationDraftPatch | null;
  references: ResourceReference[];
  loadSummary: string[];
  honestyNote: string | null;
  createdAt: string;
  updatedAt: string;
}

type RawContent = Record<string, unknown>;

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCategory(resourceType: string): ResourceCategory {
  const value = resourceType.trim().toLowerCase();
  if (['image', 'images', 'image_collection', 'image-collection', 'shared_image', 'public_image', 'reference_image'].includes(value)) {
    return 'image_collection';
  }
  if (['brand', 'brand_asset', 'brand-assets', 'logo', 'style_guide'].includes(value)) {
    return 'brand_asset';
  }
  if (['prompt', 'prompt_template', 'template', 'prompt-template'].includes(value)) {
    return 'prompt_template';
  }
  if (['example', 'case', 'example_case', 'finished_example', 'finished_examples'].includes(value)) {
    return 'example_case';
  }
  return 'other';
}

function parseJsonDescription(description: string | null): RawContent | null {
  const value = normalizeText(description);
  if (!value) return null;
  if (!(value.startsWith('{') && value.endsWith('}'))) return null;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as RawContent) : null;
  } catch {
    return null;
  }
}

function pickFirstText(content: RawContent | null, keys: string[]): string | null {
  if (!content) return null;
  for (const key of keys) {
    const value = normalizeText(content[key]);
    if (value) return value;
  }
  return null;
}

function normalizeParameters(content: RawContent | null): GenerationDraftPatch | null {
  const raw = content?.parameters;
  if (!raw || typeof raw !== 'object') return null;

  const params = raw as Record<string, unknown>;
  const next: GenerationDraftPatch = {};

  const generationMode = params.generationMode ?? params.generation_mode;
  if (generationMode === 'all_in_one_reference' || generationMode === 'first_last_frame' || generationMode === 'smart_multi_frame') {
    next.generationMode = generationMode;
  }

  const ratio = params.ratio;
  if (ratio === '21:9' || ratio === '16:9' || ratio === '4:3' || ratio === '1:1' || ratio === '3:4' || ratio === '9:16') {
    next.ratio = ratio;
  }

  const duration = params.duration;
  if (typeof duration === 'number' && duration >= 4 && duration <= 15) {
    next.duration = duration as GenerationDraftPatch['duration'];
  }

  const resolution = params.resolution;
  if (resolution === '480p' || resolution === '720p') {
    next.resolution = resolution;
  }

  if (typeof params.seed === 'number') next.seed = params.seed;
  if (typeof params.generateAudio === 'boolean') next.generateAudio = params.generateAudio;
  if (typeof params.generate_audio === 'boolean') next.generateAudio = params.generate_audio;
  if (typeof params.returnLastFrame === 'boolean') next.returnLastFrame = params.returnLastFrame;
  if (typeof params.return_last_frame === 'boolean') next.returnLastFrame = params.return_last_frame;
  if (typeof params.watermark === 'boolean') next.watermark = params.watermark;

  return Object.keys(next).length > 0 ? next : null;
}

function normalizeReferenceItem(item: unknown, fallbackName: string): ResourceReference | null {
  if (typeof item === 'string') {
    const url = normalizeText(item);
    if (!url) return null;
    return {
      url,
      name: fallbackName,
      role: 'reference_image',
      thumbnailUrl: url,
    };
  }

  if (!item || typeof item !== 'object') return null;

  const value = item as Record<string, unknown>;
  const url = normalizeText(value.url ?? value.originalUrl ?? value.original_url);
  if (!url) return null;

  return {
    url,
    name: normalizeText(value.name) ?? fallbackName,
    role: normalizeText(value.role) ?? 'reference_image',
    thumbnailUrl: normalizeText(value.thumbnailUrl ?? value.thumbnail_url ?? value.previewUrl ?? value.preview_url) ?? url,
  };
}

function buildReferences(
  content: RawContent | null,
  previewUrl: string | null,
  category: ResourceCategory,
  name: string,
): { references: ResourceReference[]; usedFallbackPreview: boolean } {
  const referencesInput = content?.references ?? content?.images ?? content?.assets;
  const rawItems = Array.isArray(referencesInput) ? referencesInput : [];
  const references = rawItems
    .map((item, index) => normalizeReferenceItem(item, `${name} ${index + 1}`))
    .filter((item): item is ResourceReference => Boolean(item));

  if (references.length > 0) {
    return { references, usedFallbackPreview: false };
  }

  if (previewUrl && (category === 'image_collection' || category === 'brand_asset' || category === 'example_case')) {
    return {
      references: [{
        url: previewUrl,
        name,
        role: category === 'brand_asset' ? 'reference_image' : 'reference_image',
        thumbnailUrl: previewUrl,
      }],
      usedFallbackPreview: true,
    };
  }

  return { references: [], usedFallbackPreview: false };
}

function buildSummary(description: string | null, content: RawContent | null, category: ResourceCategory): string {
  const summary = pickFirstText(content, ['summary', 'description', 'notes']);
  if (summary) return summary;

  const plainDescription = normalizeText(description);
  if (!plainDescription) {
    if (category === 'prompt_template') return 'Prompt template resource.';
    if (category === 'brand_asset') return 'Brand asset resource.';
    if (category === 'example_case') return 'Finished example resource.';
    return 'Shared generation resource.';
  }
  return plainDescription;
}

function buildPromptText(description: string | null, content: RawContent | null, category: ResourceCategory): string | null {
  const structuredPrompt = pickFirstText(content, ['prompt', 'template', 'promptText', 'prompt_text']);
  if (structuredPrompt) return structuredPrompt;

  const plainDescription = normalizeText(description);
  if ((category === 'prompt_template' || category === 'example_case') && plainDescription) {
    return plainDescription;
  }

  return null;
}

function buildHonestyNote(category: ResourceCategory, usedFallbackPreview: boolean, hasStructuredContent: boolean, promptText: string | null, parameters: GenerationDraftPatch | null): string | null {
  if (usedFallbackPreview) {
    return 'This resource currently loads its preview image as a single workspace reference because no richer reference list is stored yet.';
  }
  if (!hasStructuredContent && category === 'prompt_template' && promptText) {
    return 'This template currently uses the description field as prompt text.';
  }
  if (!hasStructuredContent && category === 'example_case' && promptText && !parameters) {
    return 'This example currently contributes prompt text only because no structured parameters are stored yet.';
  }
  return null;
}

function buildLoadSummary(category: ResourceCategory, references: ResourceReference[], promptText: string | null, parameters: GenerationDraftPatch | null): string[] {
  const summary: string[] = [];
  if (references.length > 0) {
    summary.push(`${references.length} reference image${references.length > 1 ? 's' : ''}`);
  }
  if (promptText) {
    summary.push(category === 'prompt_template' ? 'prompt template text' : 'prompt text');
  }
  if (parameters && Object.keys(parameters).length > 0) {
    summary.push('generation settings');
  }
  if (summary.length === 0) {
    summary.push('resource context');
  }
  return summary;
}

export function describeResource(resource: {
  id: string;
  name: string;
  resource_type: string;
  preview_url: string | null;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}): ResourceDescriptor {
  const category = normalizeCategory(resource.resource_type);
  const content = parseJsonDescription(resource.description);
  const promptText = buildPromptText(resource.description, content, category);
  const parameters = normalizeParameters(content);
  const { references, usedFallbackPreview } = buildReferences(content, resource.preview_url, category, resource.name);
  const summary = buildSummary(resource.description, content, category);
  const honestyNote = buildHonestyNote(category, usedFallbackPreview, Boolean(content), promptText, parameters);

  return {
    id: resource.id,
    name: resource.name,
    resourceType: resource.resource_type,
    category,
    previewUrl: resource.preview_url,
    summary,
    promptText,
    parameters,
    references,
    loadSummary: buildLoadSummary(category, references, promptText, parameters),
    honestyNote,
    createdAt: resource.created_at.toISOString(),
    updatedAt: resource.updated_at.toISOString(),
  };
}

export async function listVisibleResourceDescriptors(user: SessionUser): Promise<ResourceDescriptor[]> {
  const resources = await prisma.sharedResource.findMany({
    where: user.role === 'admin'
      ? { status: 'active' }
      : {
          status: 'active',
          OR: [
            { visibility_scope: 'all_users' },
            {
              visibility_scope: 'specific_users',
              scoped_users: { some: { user_id: user.id } },
            },
          ],
        },
    orderBy: [{ updated_at: 'desc' }, { created_at: 'desc' }],
  });

  return resources.map(describeResource);
}

export async function getVisibleResourceDescriptor(resourceId: string, user: SessionUser): Promise<ResourceDescriptor | null> {
  const resource = await prisma.sharedResource.findFirst({
    where: user.role === 'admin'
      ? { id: resourceId, status: 'active' }
      : {
          id: resourceId,
          status: 'active',
          OR: [
            { visibility_scope: 'all_users' },
            {
              visibility_scope: 'specific_users',
              scoped_users: { some: { user_id: user.id } },
            },
          ],
        },
  });

  return resource ? describeResource(resource) : null;
}

export function guessFileNameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const candidate = path.basename(parsed.pathname);
    return candidate && candidate !== '/' ? decodeURIComponent(candidate) : fallback;
  } catch {
    return fallback;
  }
}
