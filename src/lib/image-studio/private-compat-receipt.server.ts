import 'server-only';
import { inspectPrivatePrompt, isStoredPrivatePrompt, openPrivatePrompt, privateOrigin, privatePromptState,
  PrivatePromptError, type PrivateBinding, type PrivateOrigin } from '@/lib/security/private-prompts.server';

const prefix = 'studio_shared_compat_receipt_v1:';
const fail = (): never => { throw new PrivatePromptError(); };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

// These retired migration receipts contain full before-images, including global context.
// They are not ordinary template DTOs. Preserve exact bytes and require all source rights.
export function historicalStudioReceiptBinding(key: string, raw: string): PrivateBinding {
  if (!key.startsWith(prefix) || key.length === prefix.length) return fail();
  if (isStoredPrivatePrompt(raw)) {
    const binding = inspectPrivatePrompt(raw).binding;
    if (binding.kind !== 'image-compat-receipt' || binding.id !== key || binding.field !== 'value_json') return fail();
    openPrivatePrompt(raw, binding);
    return binding;
  }
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !record(value.before) || !record(value.before.module)
    || !record(value.afterModule) || typeof value.presetId !== 'string'
    || typeof value.requestId !== 'string' || typeof value.beforeHash !== 'string') return fail();
  const origins: PrivateOrigin[] = [];
  const add = (origin: PrivateOrigin | null) => { if (!origin) return fail(); origins.push(origin); };
  add(privateOrigin('image-preset', value.presetId));
  for (const definition of [value.before.module, value.afterModule]) {
    if (typeof definition.id !== 'string' || typeof definition.owner_id !== 'string') return fail();
    if (definition.source_preset_id !== null && definition.source_preset_id !== undefined && typeof definition.source_preset_id !== 'string') return fail();
    add(typeof definition.source_preset_id === 'string' && definition.source_preset_id
      ? privateOrigin('image-preset', definition.source_preset_id)
      : privateOrigin('image-module', definition.id, definition.owner_id));
  }
  // The archived settings and task snapshots may include shared global/mixed-author inputs.
  // The full archive remains administrator-managed; it never grants a copier extra rights.
  add(privateOrigin('image-global', 'gpt_image_studio_v1'));
  return { kind: 'image-compat-receipt', id: key, field: 'value_json', origins };
}

export function readHistoricalStudioCompatibilityReceipt(key: string, stored: string) {
  const binding = historicalStudioReceiptBinding(key, stored);
  if (!isStoredPrivatePrompt(stored) && privatePromptState() === 'encrypted-required') return fail();
  const raw = isStoredPrivatePrompt(stored) ? openPrivatePrompt(stored, binding) : stored;
  return { binding, raw, value: JSON.parse(raw) as Record<string, unknown> };
}
