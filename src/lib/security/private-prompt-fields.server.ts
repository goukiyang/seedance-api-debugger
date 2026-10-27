import 'server-only';
import { canonicalPrivateBinding, inspectPrivatePrompt, isStoredPrivatePrompt, PrivatePromptError,
  readPrivatePrompt, writePrivatePrompt, privatePromptPolicy, type PrivateBinding, type PrivateOrigin } from './private-prompts.server';

export type PrivateField = { field: string; origins: PrivateOrigin[] };
const provenance = new WeakMap<object, Map<string, PrivateOrigin[]>>();
const stored = new WeakMap<object, object>();
const definitionKinds = new Set(['image-module', 'image-preset', 'skill', 'video-template', 'video-template-version', 'video-module-context']);

export function privateFieldBinding(raw: unknown, kind: string, id: string, field: string, origins: PrivateOrigin[]): PrivateBinding | null {
  if (isStoredPrivatePrompt(raw)) {
    const envelope = inspectPrivatePrompt(raw);
    if (envelope.binding.kind !== kind || envelope.binding.id !== id || envelope.binding.field !== field) throw new PrivatePromptError();
    return canonicalPrivateBinding({ kind, id, field, origins: envelope.binding.origins });
  }
  return origins.length ? canonicalPrivateBinding({ kind, id, field, origins }) : null;
}
export function privateFieldOrigins(value: object, field: string): PrivateOrigin[] {
  return provenance.get(value)?.get(field) || [];
}
export function privateStoredValue<T extends object>(value: T): T {
  return (stored.get(value) || value) as T;
}

// Call only at explicit business read boundaries, never as a global Prisma extension.
export function readPrivateFields<T extends object>(value: T, kind: string, id: string, fields: PrivateField[]): T {
  const result = { ...value }, originals = value as Record<string, unknown>, target = result as Record<string, unknown>;
  const origins = new Map<string, PrivateOrigin[]>();
  for (const spec of fields) {
    const binding = privateFieldBinding(originals[spec.field], kind, id, spec.field, spec.origins);
    target[spec.field] = readPrivatePrompt(originals[spec.field], binding);
    if (binding) origins.set(spec.field, binding.origins);
  }
  provenance.set(result, origins); stored.set(result, value);
  return result;
}
export function writePrivateFields<T extends object>(value: T, kind: string, id: string, fields: PrivateField[]): T {
  const result = { ...value }, source = value as Record<string, unknown>, target = result as Record<string, unknown>;
  for (const spec of fields) {
    if (typeof source[spec.field] !== 'string') throw new PrivatePromptError();
    const origins = spec.origins.length ? spec.origins : privateFieldOrigins(value, spec.field);
    if (!origins.length && source[spec.field] && definitionKinds.has(kind) && privatePromptPolicy()) throw new PrivatePromptError();
    target[spec.field] = writePrivatePrompt(source[spec.field] as string, origins.length ? { kind, id, field: spec.field, origins } : null);
  }
  return result;
}
export function transferPrivateOrigins(source: object, target: object, fields: string[]) {
  const map = new Map(provenance.get(target));
  for (const field of fields) {
    const origins = privateFieldOrigins(source, field);
    if (origins.length) map.set(field, origins);
  }
  provenance.set(target, map);
}
export function transferPrivateFieldOrigin(source: object, field: string, target: object, targetField: string) {
  const map = new Map(provenance.get(target));
  const origins = privateFieldOrigins(source, field);
  if (origins.length) map.set(targetField, origins);
  provenance.set(target, map);
}
