import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { isStoredPrivatePrompt, inspectPrivatePrompt, openPrivatePrompt, sealPrivatePrompt, privatePromptIndex,
  privatePromptPolicy, PrivatePromptError, type PrivateBinding } from './private-prompts.server';

// Explicit columns prevent a migration from changing business identity, billing or timestamps.
const columns = {
  ImageStudioModule: ['prompt', 'context'],
  ImageStudioPreset: ['prompt', 'context'],
  ImageStudioTask: ['prompt', 'context', 'snapshot_json'],
  VideoStudioTemplate: ['recipe_json'],
  VideoStudioTemplateVersion: ['recipe_json'],
  VideoStudioDraft: ['template_snapshot_json'],
  VideoStudioRun: ['snapshot_json', 'prompt'],
  PlatformSetting: ['value_json'],
  OperationLog: ['detail'],
  VideoTask: ['prompt', 'final_prompt_snapshot', 'template_studio_snapshot_json'],
  GenerationTaskSnapshot: ['prompt_raw', 'prompt_rendered'],
} as const;
const guardColumns = {
  ImageStudioModule: ['owner_id', 'source_preset_id', 'revision', 'updated_at'],
  ImageStudioPreset: ['owner_id', 'updated_at'],
  ImageStudioTask: ['owner_id', 'module_id', 'source_preset_id', 'updated_at'],
  VideoStudioTemplate: ['owner_user_id', 'revision', 'updated_at'],
  VideoStudioTemplateVersion: ['template_id', 'created_at'],
  VideoStudioDraft: ['owner_user_id', 'source_template_id', 'source_version_id', 'revision', 'updated_at'],
  VideoStudioRun: ['owner_user_id', 'draft_id', 'updated_at'],
  PlatformSetting: ['key', 'updated_by', 'updated_at'],
  OperationLog: ['operator_id', 'action', 'target_type', 'target_id', 'created_at'],
  VideoTask: ['owner_user_id', 'user_id', 'source_metadata_json', 'snapshot_id', 'updated_at'],
  GenerationTaskSnapshot: ['task_id', 'workspace_id', 'created_at'],
} as const;
export type PrivateMigrationTable = keyof typeof columns;
export type PrivateMigrationCell = { column: string; path: Array<string | number>; binding: PrivateBinding; sealedValue?: string };
type Row = Record<string, unknown> & { id: string };
export type PrivateMigrationRow = {
  table: PrivateMigrationTable; id: string; expected: Record<string, string | null>;
  replacement: Record<string, string | null>;
  guards: Record<string, string | number | bigint | Date | null>;
};
const preparedRows = new WeakMap<PrivateMigrationRow, string>();
const preparedManifests = new WeakMap<PrivateMigrationRow, string>();
const stable = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { bigint: String(item) } : item);
export type PrivateMigrationPlan = {
  policyRevision: string; inventoryId: string; rows: PrivateMigrationRow[]; digest: string;
};
const fail = (): never => { throw new PrivatePromptError(); };
function allowed(table: PrivateMigrationTable, column: string) {
  return Object.hasOwn(columns, table) && (columns[table] as readonly string[]).includes(column);
}
function checkedPath(root: unknown, segments: Array<string | number>) {
  if (!segments.length || segments.length > 16) return fail();
  let parent = root;
  for (const key of segments.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(String(key))
      || !Object.hasOwn(parent, key)) return fail();
    parent = (parent as Record<string | number, unknown>)[key];
  }
  const key = segments[segments.length - 1];
  if (!parent || typeof parent !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(String(key))
    || !Object.hasOwn(parent, key)) return fail();
  return { parent: parent as Record<string | number, unknown>, key };
}

// The plan contains private source values. Keep it in process memory; only its keyed digest is printable.
export function preparePrivateMigrationRow(table: PrivateMigrationTable, row: Row, cells: PrivateMigrationCell[], options: { rotateBodyKey?: boolean } = {}): PrivateMigrationRow | null {
  if (!row.id || !cells.length || !Object.hasOwn(columns, table)) return fail();
  const expected: Record<string, string | null> = {}, replacement: Record<string, string | null> = {};
  const json = new Map<string, unknown>(), seen = new Set<string>();
  for (const cell of cells) {
    if (!allowed(table, cell.column)) return fail();
    const location = JSON.stringify([cell.column, cell.path]);
    if (seen.has(location)) return fail();
    seen.add(location);
    const raw = row[cell.column];
    if (typeof raw !== 'string') return fail();
    expected[cell.column] = raw;
    if (!(cell.column in replacement)) replacement[cell.column] = raw;
    let plain: unknown = raw;
    let target: ReturnType<typeof checkedPath> | undefined;
    if (cell.path.length) {
      if (!json.has(cell.column)) json.set(cell.column, JSON.parse(raw));
      target = checkedPath(json.get(cell.column), cell.path);
      plain = target.parent[target.key];
    }
    if (typeof plain !== 'string') return fail();
    if (isStoredPrivatePrompt(plain)) {
      // A matching prefix alone is not proof: authenticate existing cells on reruns too.
      const decoded = openPrivatePrompt(plain, cell.binding);
      const next = cell.sealedValue ?? (options.rotateBodyKey && inspectPrivatePrompt(plain).keyId !== privatePromptPolicy()?.keys.body.active
        ? sealPrivatePrompt(decoded, cell.binding) : plain);
      if (openPrivatePrompt(next, cell.binding) !== decoded) return fail();
      if (target) target.parent[target.key] = next;
      else replacement[cell.column] = next;
      continue;
    }
    const encrypted = cell.sealedValue ?? sealPrivatePrompt(plain, cell.binding);
    if (openPrivatePrompt(encrypted, cell.binding) !== plain) return fail();
    if (target) target.parent[target.key] = encrypted;
    else replacement[cell.column] = encrypted;
  }
  for (const [column, value] of Array.from(json.entries())) {
    const original = JSON.parse(expected[column] as string);
    if (JSON.stringify(value) !== JSON.stringify(original)) replacement[column] = JSON.stringify(value);
  }
  if (Object.keys(expected).every(column => expected[column] === replacement[column])) return null;
  const guards: PrivateMigrationRow['guards'] = {};
  for (const column of guardColumns[table]) {
    if (!Object.hasOwn(row, column)) return fail();
    const value = row[column];
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint' && !(value instanceof Date)) return fail();
    guards[column] = value;
  }
  const result = { table, id: row.id, expected, replacement, guards };
  preparedRows.set(result, stable(result));
  // Bind the approved source and transformation, not random nonces generated during preparation.
  // This permits a fresh process to reproduce the same plan digest without persisting plaintext plans.
  preparedManifests.set(result, stable({ table, id: row.id, expected, guards, cells: cells.map(cell => ({
    column: cell.column, path: cell.path, binding: cell.binding,
    keyId: cell.sealedValue ? inspectPrivatePrompt(cell.sealedValue).keyId : privatePromptPolicy()?.keys.body.active,
  })) }));
  return result;
}

function planDigest(policyRevision: string, inventoryId: string, rows: PrivateMigrationRow[]) {
  return privatePromptIndex('migration-manifest', stable({ policyRevision, inventoryId,
    rows: rows.map(row => preparedManifests.get(row) ?? fail()) }));
}
export function preparePrivateMigrationPlan(inventoryId: string, rows: PrivateMigrationRow[]): PrivateMigrationPlan {
  const policy = privatePromptPolicy();
  if (!policy || !/^[A-Za-z0-9_.:-]{1,240}$/.test(inventoryId) || rows.length > 2000) return fail();
  const seen = new Set<string>();
  for (const row of rows) {
    if (preparedRows.get(row) !== stable(row)) return fail();
    const key = JSON.stringify([row.table, row.id]);
    if (seen.has(key) || !row.id || !Object.keys(row.expected).length) return fail();
    seen.add(key);
    if (Object.keys(row.expected).sort().join(',') !== Object.keys(row.replacement).sort().join(',')) return fail();
    for (const column of Object.keys(row.expected)) {
      if (!allowed(row.table, column) || typeof row.expected[column] !== 'string'
        || typeof row.replacement[column] !== 'string') return fail();
    }
  }
  return { policyRevision: policy.revision, inventoryId, rows,
    digest: planDigest(policy.revision, inventoryId, rows) };
}

export async function executePrivateMigrationPlan(db: PrismaClient, plan: PrivateMigrationPlan,
  authorization: { inventoryId: string; planDigest: string; restoreId: string; policyRevision: string }) {
  const policy = privatePromptPolicy();
  const checked = preparePrivateMigrationPlan(plan.inventoryId, plan.rows);
  if (!policy || policy.state !== 'encrypted-write' || !policy.activation
    || checked.digest !== plan.digest || authorization.planDigest !== plan.digest
    || authorization.inventoryId !== plan.inventoryId || authorization.policyRevision !== plan.policyRevision
    || policy.revision !== plan.policyRevision || policy.activation.inventoryId !== plan.inventoryId
    || policy.activation.restoreId !== authorization.restoreId) return fail();
  const rows = structuredClone(plan.rows);
  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const row of rows) {
      const names = Object.keys(row.expected).sort();
      const changes = names.map(name => `"${name}" = ?`).join(', ');
      const conditions = names.map(name => `"${name}" IS ?`).join(' AND ');
      const guards = Object.keys(row.guards);
      const guardConditions = guards.map(name => `"${name}" IS ?`).join(' AND ');
      // Identifiers come only from the fixed allowlist above; every data value is bound.
      const count = await tx.$executeRawUnsafe(`UPDATE "${row.table}" SET ${changes} WHERE "id" = ? AND ${conditions} AND ${guardConditions}`,
        ...names.map(name => row.replacement[name]), row.id, ...names.map(name => row.expected[name]), ...guards.map(name => row.guards[name]));
      if (count !== 1) return fail();
    }
    const currentPolicy = privatePromptPolicy();
    if (currentPolicy?.revision !== policy.revision || currentPolicy.state !== policy.state
      || currentPolicy.activation?.writerFenceId !== policy.activation?.writerFenceId) return fail();
  }, { maxWait: 5000, timeout: 30000 });
  return { inventoryId: plan.inventoryId, digest: plan.digest, changedRows: plan.rows.length };
}
