import type { StudioRunSnapshot, StudioTemplateRecipe } from './types';

export function publicRecipe(recipe: StudioTemplateRecipe | null) {
  return recipe ? { ...recipe, instruction: '' } : null;
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

export function visibleRunPrompt(row: { prompt: string | null; mode: string; snapshot_json: string }) {
  const snapshot = JSON.parse(row.snapshot_json) as StudioRunSnapshot;
  // Old direct runs combined hidden instructions into the public prompt. Never return that legacy field.
  const prompt = row.mode === 'direct' && !snapshot.privateContext ? userInputPrompt(snapshot) : row.prompt;
  return prompt && !containsPrivateContext(prompt, snapshot) ? prompt : null;
}

export function publicRunSnapshot(snapshot: StudioRunSnapshot): StudioRunSnapshot {
  return {
    input: snapshot.input,
    templateVersion: snapshot.templateVersion,
    recipe: publicRecipe(snapshot.recipe),
    prompt: '',
    parameters: snapshot.parameters,
    assets: snapshot.assets,
    owner: snapshot.owner,
    ...(snapshot.sourceRunId ? { sourceRunId: snapshot.sourceRunId } : {}),
  };
}
