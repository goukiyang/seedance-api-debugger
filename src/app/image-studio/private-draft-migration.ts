type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}
function fields(value: RecordValue) {
  const author = record(value.authorDefinition), base = record(author?.baseFields);
  return { context: value.context, authorContext: author?.context, authorPrompt: author?.templatePrompt,
    baseContext: base?.context, basePrompt: base?.templatePrompt, recipeInstruction: record(value.recipe)?.instruction,
    draftRecipeInstruction: record(record(value.draft)?.recipe)?.instruction };
}
function sensitive(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
export function withoutLegacyPrivateFields<T extends RecordValue>(value: T): T {
  const result: RecordValue = { ...value };
  delete result.context;
  const recipe = record(value.recipe);
  if (recipe) result.recipe = { ...recipe, instruction: '' };
  const draft = record(value.draft), draftRecipe = record(draft?.recipe);
  if (draft && draftRecipe) result.draft = { ...draft, recipe: { ...draftRecipe, instruction: '' } };
  const author = record(value.authorDefinition);
  if (author) {
    const clean = { ...author };
    delete clean.context; delete clean.templatePrompt;
    const base = record(author.baseFields);
    if (base) { clean.baseFields = { ...base }; delete (clean.baseFields as RecordValue).context; delete (clean.baseFields as RecordValue).templatePrompt; }
    result.authorDefinition = clean;
  }
  return result as T;
}
export function readLegacyPrivateDraft(key: string) {
  const raw = localStorage.getItem(key), value = raw ? record(JSON.parse(raw)) : null;
  if (!value) return null;
  const found = fields(value);
  if (!Object.values(found).some(sensitive)) return null;
  return { key, found, context: typeof found.authorContext === 'string' ? found.authorContext
    : typeof found.context === 'string' ? found.context : typeof found.recipeInstruction === 'string' ? found.recipeInstruction
      : typeof found.draftRecipeInstruction === 'string' ? found.draftRecipeInstruction
        : typeof found.baseContext === 'string' ? found.baseContext : undefined,
  prompt: typeof found.authorPrompt === 'string' ? found.authorPrompt : typeof found.basePrompt === 'string' ? found.basePrompt : undefined };
}
export type LegacyPrivateDraft = NonNullable<ReturnType<typeof readLegacyPrivateDraft>>;

// Keep only already-present legacy fields until their encrypted replacement is acknowledged.
export function retainLegacyPrivateDraft(key: string, next: RecordValue) {
  const raw = localStorage.getItem(key), old = raw ? record(JSON.parse(raw)) : null;
  if (!old) return next;
  const original = fields(old), author = { ...record(next.authorDefinition) }, base = { ...record(author.baseFields) };
  const result = { ...next };
  if (sensitive(original.recipeInstruction)) result.recipe = { ...record(next.recipe), instruction: original.recipeInstruction };
  if (sensitive(original.draftRecipeInstruction)) {
    const draft = record(next.draft);
    result.draft = { ...draft, recipe: { ...record(draft?.recipe), instruction: original.draftRecipeInstruction } };
  }
  if (sensitive(original.context)) result.context = original.context;
  if (sensitive(original.authorContext)) author.context = original.authorContext;
  if (sensitive(original.authorPrompt)) author.templatePrompt = original.authorPrompt;
  if (sensitive(original.baseContext)) base.context = original.baseContext;
  if (sensitive(original.basePrompt)) base.templatePrompt = original.basePrompt;
  if (Object.keys(base).length) author.baseFields = base;
  if (Object.keys(author).length) result.authorDefinition = author;
  return result;
}
export function acknowledgeLegacyPrivateDraft(original: LegacyPrivateDraft, saved: { prompt: string; context: string }) {
  const raw = localStorage.getItem(original.key), value = raw ? record(JSON.parse(raw)) : null;
  if (!value) return true;
  const current = fields(value);
  if (Object.keys(original.found).some(key => current[key as keyof typeof current] !== original.found[key as keyof typeof current])) return false;
  if (value.context === saved.context) delete value.context;
  const recipe = record(value.recipe);
  if (recipe?.instruction === saved.context) recipe.instruction = '';
  const draftRecipe = record(record(value.draft)?.recipe);
  if (draftRecipe?.instruction === saved.context) draftRecipe.instruction = '';
  const author = record(value.authorDefinition), base = record(author?.baseFields);
  if (author) {
    if (author.context === saved.context) delete author.context;
    if (author.templatePrompt === saved.prompt) delete author.templatePrompt;
  }
  if (base) {
    if (base.context === saved.context) delete base.context;
    if (base.templatePrompt === saved.prompt) delete base.templatePrompt;
  }
  localStorage.setItem(original.key, JSON.stringify(value));
  return !Object.values(fields(value)).some(sensitive);
}
