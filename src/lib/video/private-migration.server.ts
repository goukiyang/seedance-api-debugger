import 'server-only';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { privateOrigin, privatePromptPolicy, inspectPrivatePrompt, isStoredPrivatePrompt, openPrivatePrompt, sealPrivatePrompt, PrivatePromptError, type PrivateBinding } from '@/lib/security/private-prompts.server';
import { preparePrivateMigrationRow, type PrivateMigrationCell, type PrivateMigrationRow } from '@/lib/security/private-prompt-migration.server';
import { MULTIVIEW_ROTATION_PRESET } from './multiview-generation-contract';
import { readMultiviewPrivateTaskMarker } from './multiview-task-privacy';

const currentKey = 'multiview_rotation_preset_v1:current';
const versionPrefix = 'multiview_rotation_preset_v1:version:';
const fail = (): never => { throw new PrivatePromptError(); };
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export async function preparePrivateVideoTaskMigration(db: PrismaClient, ids: string[], options: { rotateBodyKey?: boolean } = {}) {
  if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)) return fail();
  const tasks = await db.videoTask.findMany({ where: { id: { in: ids } } });
  if (tasks.length !== ids.length) return fail();
  const origin = privateOrigin('multiview-preset', MULTIVIEW_ROTATION_PRESET.id);
  if (ids.length && !origin) return fail();
  const rows: PrivateMigrationRow[] = [];
  let unchangedRows = 0;
  for (const task of tasks) {
    if (!readMultiviewPrivateTaskMarker(task)) return fail();
    const cells = ['prompt', 'final_prompt_snapshot'].filter(field => typeof task[field as 'prompt' | 'final_prompt_snapshot'] === 'string')
      .map(field => ({ column: field, path: [], binding: { kind: 'video-task', id: task.id, field, origins: [origin!] } }));
    const prepared = preparePrivateMigrationRow('VideoTask', task, cells, options);
    if (prepared) rows.push(prepared); else unchangedRows++;
    if (task.snapshot_id) {
      const snapshot = await db.generationTaskSnapshot.findUnique({ where: { id: task.snapshot_id } });
      if (!snapshot || snapshot.task_id && snapshot.task_id !== task.id) return fail();
      const next = preparePrivateMigrationRow('GenerationTaskSnapshot', snapshot, ['prompt_raw', 'prompt_rendered'].map(field => ({
        column: field, path: [], binding: { kind: 'video-generation-snapshot', id: snapshot.id, field, origins: [origin!] },
      })), options);
      if (next) rows.push(next); else unchangedRows++;
    }
  }
  return { rows, unchangedRows };
}

// Immutable versions are the authority. Every existing mirror must be inventoried before migration.
export async function prepareMultiviewPrivateMigration(db: PrismaClient, selection: { settingIds: string[]; receiptIds: string[] }, options: { rotateBodyKey?: boolean } = {}) {
  for (const ids of Object.values(selection)) if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => !id)) return fail();
  const settings = await db.platformSetting.findMany({ where: { OR: [{ key: currentKey }, { key: { startsWith: versionPrefix } }] } });
  const receipts = await db.operationLog.findMany({ where: { action: 'multiview_rotation_preset_save' } });
  if (settings.length !== selection.settingIds.length || settings.some(row => !selection.settingIds.includes(row.id))
    || receipts.length !== selection.receiptIds.length || receipts.some(row => !selection.receiptIds.includes(row.id))) return fail();
  const origin = privateOrigin('multiview-preset', MULTIVIEW_ROTATION_PRESET.id);
  if (!origin) return fail();
  const origins = [origin];
  const authorities = new Map<string, { original: Record<string, any>; sealed: string; binding: PrivateBinding }>();
  for (const row of settings.filter(row => row.key.startsWith(versionPrefix))) {
    const value = JSON.parse(row.value_json);
    const preset = value?.preset;
    if (!record(preset) || preset.id !== MULTIVIEW_ROTATION_PRESET.id || typeof preset.version !== 'string'
      || row.key !== versionPrefix + preset.version || typeof preset.prompt !== 'string'
      || preset.version !== `1.0.${value.revision}` || authorities.has(preset.version)) return fail();
    const binding = { kind: 'multiview-preset-version', id: `${preset.id}:${preset.version}`, field: 'prompt', origins };
    const plain = isStoredPrivatePrompt(preset.prompt) ? openPrivatePrompt(preset.prompt, binding) : preset.prompt;
    const keep = isStoredPrivatePrompt(preset.prompt) && (!options.rotateBodyKey || inspectPrivatePrompt(preset.prompt).keyId === privatePromptPolicy()?.keys.body.active);
    const sealed = keep ? preset.prompt : sealPrivatePrompt(plain, binding);
    authorities.set(preset.version, { original: preset, sealed, binding });
  }
  function presetCell(preset: unknown, column: string, path: Array<string | number>): PrivateMigrationCell {
    if (!record(preset)) return fail();
    const authority = authorities.get(preset.version);
    // Preserve the existing strict equality contract, including non-sensitive defaults and source image.
    if (!authority || JSON.stringify(preset) !== JSON.stringify(authority.original)) return fail();
    return { column, path: [...path, 'prompt'], binding: authority.binding, sealedValue: authority.sealed };
  }
  const rows: PrivateMigrationRow[] = [];
  let unchangedRows = 0;
  for (const row of settings) {
    const prepared = preparePrivateMigrationRow('PlatformSetting', row, [presetCell(JSON.parse(row.value_json).preset, 'value_json', ['preset'])]);
    if (prepared) rows.push(prepared); else unchangedRows++;
  }
  for (const row of receipts) {
    if (!row.detail || row.target_type !== 'MultiviewRotationPreset' || row.target_id !== MULTIVIEW_ROTATION_PRESET.id) return fail();
    const value = JSON.parse(row.detail), mutationId = value?.receipt?.mutationId;
    const expectedId = `multiview-preset-save-${createHash('sha256').update(JSON.stringify([row.operator_id, mutationId])).digest('hex')}`;
    if (typeof mutationId !== 'string' || row.id !== expectedId || value.receipt.state !== 'saved' || typeof value.requestHash !== 'string') return fail();
    const binding = { kind: 'multiview-receipt', id: row.id, field: 'requestHash', origins };
    const plainHash = isStoredPrivatePrompt(value.requestHash) ? openPrivatePrompt(value.requestHash, binding) : value.requestHash;
    if (!/^[a-f0-9]{64}$/.test(plainHash)) return fail();
    const keepHash = isStoredPrivatePrompt(value.requestHash) && (!options.rotateBodyKey || inspectPrivatePrompt(value.requestHash).keyId === privatePromptPolicy()?.keys.body.active);
    const sealedHash = keepHash ? value.requestHash : sealPrivatePrompt(plainHash, binding);
    const cells: PrivateMigrationCell[] = [presetCell(value.receipt.preset, 'detail', ['receipt', 'preset']),
      { column: 'detail', path: ['requestHash'], binding, sealedValue: sealedHash }];
    if (value.install) {
      const raw = value.install.requestHash;
      if (typeof raw !== 'string' || (isStoredPrivatePrompt(raw) ? openPrivatePrompt(raw, binding) : raw) !== plainHash) return fail();
      cells.push({ column: 'detail', path: ['install', 'requestHash'], binding, sealedValue: sealedHash });
    }
    const prepared = preparePrivateMigrationRow('OperationLog', row, cells);
    if (prepared) rows.push(prepared); else unchangedRows++;
  }
  return { rows, unchangedRows, versions: authorities.size };
}
