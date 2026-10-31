export type StudioPersonalPromptState = 'recorded' | 'legacy-personal' | 'unknown';
export type StudioPersonalPromptProjection = {
  personalPromptState: StudioPersonalPromptState;
  personalPrompt?: string;
};

const PRIVATE_PROMPT_FORMAT = 'private-prompt.v1';
const PRIVATE_PROMPT_FORMAT_MARKER = /["']format["']\s*:\s*["']private-prompt\.v1["']/;

function privatePromptEnvelope(value: unknown) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).format === PRIVATE_PROMPT_FORMAT);
}

export function isEncryptedStudioPersonalPrompt(value: unknown): boolean {
  if (privatePromptEnvelope(value)) return true;
  if (typeof value !== 'string') return false;
  const text = value.trimStart();
  if (text.startsWith('ppenc:')) return true;
  if (!text.startsWith('{')) return false;
  try { return privatePromptEnvelope(JSON.parse(text)); }
  catch { return PRIVATE_PROMPT_FORMAT_MARKER.test(text); }
}

export function hasMixedStudioPersonalPrompt(snapshot: Record<string, unknown>) {
  return ['sharedLive', 'sharedSourceRevision', 'sharedSourceOwnerId', 'templatePrompt',
    'restoredSettings', 'restoredSource'].some(field => Object.hasOwn(snapshot, field));
}

export function studioPersonalPromptProjection(snapshot: Record<string, unknown>): StudioPersonalPromptProjection {
  if (Object.hasOwn(snapshot, 'personalPrompt')) {
    return typeof snapshot.personalPrompt === 'string' && !isEncryptedStudioPersonalPrompt(snapshot.personalPrompt)
      ? { personalPromptState: 'recorded', personalPrompt: snapshot.personalPrompt }
      : { personalPromptState: 'unknown' };
  }
  if (!hasMixedStudioPersonalPrompt(snapshot) && typeof snapshot.prompt === 'string'
    && !isEncryptedStudioPersonalPrompt(snapshot.prompt)) {
    return { personalPromptState: 'legacy-personal', personalPrompt: snapshot.prompt };
  }
  return { personalPromptState: 'unknown' };
}
