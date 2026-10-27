import 'server-only';
import { privateOrigin, type PrivateOrigin } from '@/lib/security/private-prompts.server';
import { readPrivateFields, writePrivateFields, privateFieldOrigins, transferPrivateOrigins } from '@/lib/security/private-prompt-fields.server';
import { normalizeRecipe } from './validation';
import type { StudioTemplateRecipe, StudioRunSnapshot } from './types';
import { readPrivateCredential, writePrivateCredential } from '@/lib/security/private-credentials.server';

export function videoTemplateOrigins(id: string, ownerId?: string): PrivateOrigin[] {
  const origin = privateOrigin('video-template', id, ownerId);
  return origin ? [origin] : [];
}
export function readPrivateVideoRecipe(raw: string, kind: string, id: string, origins: PrivateOrigin[]) {
  const recipe = readPrivateFields(JSON.parse(raw) as StudioTemplateRecipe, kind, id, [{ field: 'instruction', origins }]);
  const result = normalizeRecipe(recipe);
  result.instruction = recipe.instruction;
  transferPrivateOrigins(recipe, result, ['instruction']);
  return result;
}
export function writePrivateVideoRecipe(recipe: StudioTemplateRecipe, kind: string, id: string, origins: PrivateOrigin[]) {
  return JSON.stringify(writePrivateFields(recipe, kind, id, [{ field: 'instruction',
    origins: privateFieldOrigins(recipe, 'instruction').length ? privateFieldOrigins(recipe, 'instruction') : origins }]));
}

const runFields = ['global', 'module', 'instruction', 'prompt'] as const;
export function privateVideoRunOrigins(snapshot: StudioRunSnapshot, draftId?: string) {
  const origins = runFields.flatMap(field => privateFieldOrigins(snapshot, field));
  if (draftId) {
    const global = snapshot.privateContext ? privateOrigin('video-global', 'video_studio_context_v1') : null;
    const moduleOrigin = snapshot.privateContext ? privateOrigin('video-module-context', draftId) : null;
    if (global) origins.push(global);
    if (moduleOrigin) origins.push(moduleOrigin);
    if (snapshot.templateVersion?.templateSource === 'studio') origins.push(...videoTemplateOrigins(snapshot.templateVersion.templateId));
  }
  return Array.from(new Map(origins.map(origin => [JSON.stringify(origin), origin])).values());
}
export function transformPrivateVideoRun(snapshot: StudioRunSnapshot, id: string, draftId: string, write: boolean) {
  const global = privateOrigin('video-global', 'video_studio_context_v1');
  const moduleOrigin = privateOrigin('video-module-context', draftId);
  const recipe = snapshot.templateVersion?.templateSource === 'studio' ? videoTemplateOrigins(snapshot.templateVersion.templateId) : [];
  const origins = {
    global: global ? [global] : [], module: moduleOrigin ? [moduleOrigin] : recipe,
    instruction: recipe, prompt: snapshot.privateContext ? [] : recipe,
  };
  const values: Record<string, string> = {};
  if (snapshot.privateContext) { values.global = snapshot.privateContext.global; values.module = snapshot.privateContext.module; }
  if (snapshot.recipe) values.instruction = snapshot.recipe.instruction;
  values.prompt = snapshot.prompt;
  const fields = runFields.filter(field => field in values).map(field => ({ field,
    origins: privateFieldOrigins(snapshot, field).length ? privateFieldOrigins(snapshot, field) : origins[field] }));
  const transformed = write ? writePrivateFields(values, 'video-run', id, fields) : readPrivateFields(values, 'video-run', id, fields);
  const result: StudioRunSnapshot = { ...snapshot,
    ...(snapshot.privateContext ? { privateContext: { ...snapshot.privateContext, global: transformed.global, module: transformed.module } } : {}),
    recipe: snapshot.recipe ? { ...snapshot.recipe, instruction: transformed.instruction } : null, prompt: transformed.prompt };
  if (snapshot.privateProvider) {
    if (snapshot.privateProvider.kind !== 'musk') throw new Error('受保护发送配置无法读取');
    const settings = snapshot.privateProvider.settings;
    result.privateProvider = { kind: 'musk', settings: { enabled: settings.enabled, base_url: settings.base_url,
      default_model: settings.default_model, api_key: write
        ? writePrivateCredential(settings.api_key, `video-run:${id}:musk`, 'api_key')
        : readPrivateCredential(settings.api_key, `video-run:${id}:musk`, 'api_key') } };
  }
  if (!write) transferPrivateOrigins(transformed, result, [...runFields]);
  return result;
}
