import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export class LocalImageError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export function requireThat(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new LocalImageError(code, status);
}
export function identifier(value: unknown): string {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value), 'INVALID_ID');
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT');
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: string[]) {
  requireThat(Object.keys(value).every(key => allowed.includes(key)), 'UNKNOWN_FIELD');
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { requireThat(Number.isSafeInteger(value), 'INTEGER_REQUIRED'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const row = object(value);
  return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}';
}
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// Adapted from this website's integrations/codex.ts; credentials remain independent.
export const tokenHash = (value: string) => 'sha256:' + sha256(value.trim());
export function tokenMatches(token: string, expected: string) {
  const actual = Buffer.from(tokenHash(token)); const saved = Buffer.from(expected);
  return actual.length === saved.length && timingSafeEqual(actual, saved);
}
export function newCredential(kind: 'caller' | 'worker', id: string) {
  return `local${kind === 'caller' ? 'c' : 'w'}_${identifier(id)}.${randomBytes(32).toString('base64url')}`;
}
export function credentialId(token: string, kind: 'caller' | 'worker') {
  const prefix = kind === 'caller' ? 'localc_' : 'localw_';
  requireThat(token.startsWith(prefix) && token.length < 240, 'INVALID_TOKEN', 401);
  const parts = token.slice(prefix.length).split('.');
  requireThat(parts.length === 2 && /^[A-Za-z0-9_-]{43}$/.test(parts[1]), 'INVALID_TOKEN', 401);
  return identifier(parts[0]);
}
export const isolationRoot = () => path.resolve(process.cwd(), 'storage', 'comfy03-isolated');
export const isolationDatabaseUrl = () => 'file:' + path.join(isolationRoot(), 'site.db').replace(/\\/g, '/');
export function assertIsolatedEnvironment() {
  // Deliberately no production override. A future production release needs a separate reviewed gate.
  requireThat(process.env.COMFY03_ENVIRONMENT === 'isolated-test'
    && process.env.DATABASE_URL === isolationDatabaseUrl(), 'PRODUCTION_ADMISSION_DISABLED', 503);
}
export type Field = { type: string; required?: boolean; default?: unknown; minimum?: number; maximum?: number;
  multipleOf?: number; minLength?: number; maxLength?: number; enum?: unknown[] };
export type Profile = Record<string, unknown> & {
  capability: string; executionProfileId: string; modelId: string; workflowSha256: string;
  parameterSchema: { fields: Record<string, Field>; allowedDimensions: number[][]; maxPixels: number };
};
export const PUBLIC_KEYS = ['capability', 'modelId', 'modelVersion', 'workflowId', 'workflowVersion',
  'workflowSha256', 'executionProfileId', 'environmentRevision', 'parameterSchemaVersion'];
export function publicProfile(profile: Profile) { return Object.fromEntries(PUBLIC_KEYS.map(key => [key, profile[key]])); }
export function parameters(profile: Profile, input: unknown) {
  const values = object(input); fields(values, Object.keys(profile.parameterSchema.fields));
  const result: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(profile.parameterSchema.fields)) {
    const value = values[key] === undefined ? rule.default : values[key];
    if (value === undefined) { requireThat(!rule.required, 'MISSING_PARAMETER'); continue; }
    if (rule.type === 'string') {
      requireThat(typeof value === 'string', 'PARAMETER_TYPE');
      requireThat(Array.from(value).length >= (rule.minLength ?? 0) && Array.from(value).length <= (rule.maxLength ?? 10000), 'PARAMETER_LENGTH');
    } else {
      requireThat(rule.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value), 'PARAMETER_TYPE');
      requireThat(value >= (rule.minimum ?? 0) && value <= (rule.maximum ?? Number.MAX_SAFE_INTEGER)
        && (!rule.multipleOf || value % rule.multipleOf === 0), 'PARAMETER_RANGE');
    }
    requireThat(!rule.enum || rule.enum.includes(value), 'PARAMETER_ENUM'); result[key] = value;
  }
  requireThat(profile.parameterSchema.allowedDimensions.some(([w, h]) => w === result.width && h === result.height), 'DIMENSION_COMBINATION');
  return result;
}
