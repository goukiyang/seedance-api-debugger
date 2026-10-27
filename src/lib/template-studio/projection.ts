import type { StudioRunSnapshot, StudioTemplateRecipe } from './types';
import { transformPrivateVideoRun } from './private-storage.server';
import { isPrivatePromptError } from '@/lib/security/private-prompts.server';

export function publicRecipe(recipe: StudioTemplateRecipe | null) {
  return recipe ? { instruction: '', fields: recipe.fields.map(field => ({
    key: field.key, label: field.label, type: field.type,
    ...('required' in field ? { required: field.required } : {}),
    ...('maxLength' in field ? { maxLength: field.maxLength } : {}),
    ...('options' in field ? { options: [...field.options] } : {}),
    ...('min' in field ? { min: field.min } : {}), ...('max' in field ? { max: field.max } : {}),
    ...('defaultValue' in field ? { defaultValue: field.defaultValue } : {}),
  })) as StudioTemplateRecipe['fields'], assetSlots: recipe.assetSlots.map(slot => ({
    key: slot.key, label: slot.label, role: slot.role, types: [...slot.types], required: slot.required, maxItems: slot.maxItems,
  })), defaultParameters: recipe.defaultParameters } : null;
}

export function userInputPrompt(snapshot: StudioRunSnapshot) {
  return [
    ...(snapshot.recipe?.fields || []).flatMap(field => snapshot.input.values[field.key] === undefined ? [] : [`${field.label}: ${String(snapshot.input.values[field.key])}`]),
    snapshot.input.draftPrompt,
  ].filter(Boolean).join('\n\n');
}

// Catch direct repetition, including whitespace/punctuation disguises. Paraphrases cannot be guaranteed.
export function containsPrivateContext(text: string, snapshot: StudioRunSnapshot) {
  const separators = new RegExp('[\\s\\p{P}\\p{S}]', 'gu');
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(separators, '');
  const output = normalize(text);
  const contexts = [snapshot.privateContext?.global, snapshot.privateContext?.module, snapshot.recipe?.instruction];
  return contexts.some(value => {
    if (!value?.trim()) return false;
    const context = normalize(value);
    if (context.length < 8) return output.includes(context) && context.length > 0;
    const width = Math.min(24, context.length);
    for (let i = 0; i <= context.length - width; i++) if (output.includes(context.slice(i, i + width))) return true;
    return false;
  });
}

export function visibleRunPrompt(row: { id: string; draft_id: string; prompt: string | null; mode: string; snapshot_json: string }) {
  let snapshot: StudioRunSnapshot;
  try { snapshot = transformPrivateVideoRun(JSON.parse(row.snapshot_json) as StudioRunSnapshot, row.id, row.draft_id, false); }
  catch (error) {
    // Unchecked text stays hidden, but media rows do not depend on a working prompt key.
    if (isPrivatePromptError(error)) return null;
    throw error;
  }
  // Old direct runs combined hidden instructions into the public prompt. Never return that legacy field.
  const prompt = row.mode === 'direct' && !snapshot.privateContext ? userInputPrompt(snapshot) : row.prompt;
  return prompt && !containsPrivateContext(prompt, snapshot) ? prompt : null;
}

export function publicRunSnapshot(snapshot: StudioRunSnapshot): StudioRunSnapshot {
  return {
    ...(snapshot.llmModel ? { llmModel: snapshot.llmModel } : {}),
    input: { name: snapshot.input.name, groupName: snapshot.input.groupName,
      values: snapshot.input.values, draftPrompt: snapshot.input.draftPrompt },
    templateVersion: snapshot.templateVersion ? { templateId: snapshot.templateVersion.templateId,
      templateSource: snapshot.templateVersion.templateSource, versionId: snapshot.templateVersion.versionId,
      versionNumber: snapshot.templateVersion.versionNumber, templateName: snapshot.templateVersion.templateName,
      sourceRevision: snapshot.templateVersion.sourceRevision } : null,
    recipe: publicRecipe(snapshot.recipe),
    prompt: '',
    parameters: snapshot.parameters,
    assets: snapshot.assets.map(asset => ({ assetId: asset.assetId, role: asset.role, type: asset.type, slotKey: asset.slotKey })),
    owner: { userId: snapshot.owner.userId, username: snapshot.owner.username, displayName: snapshot.owner.displayName,
      avatarUrl: snapshot.owner.avatarUrl, accountType: snapshot.owner.accountType },
    ...(snapshot.sourceRunId ? { sourceRunId: snapshot.sourceRunId } : {}),
  };
}
