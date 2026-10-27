import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { studioDefinitionOrigins } from './private-storage.server';
import { privateOrigin, inspectPrivatePrompt, isStoredPrivatePrompt, PrivatePromptError, type PrivateOrigin } from '@/lib/security/private-prompts.server';
import { preparePrivateMigrationRow, type PrivateMigrationCell, type PrivateMigrationRow } from '@/lib/security/private-prompt-migration.server';

type Selection = { modules: string[]; presets: string[]; tasks: string[] };
function cell(raw: unknown, column: string, path: Array<string | number>, kind: string, id: string,
  field: string, origins: PrivateOrigin[]): PrivateMigrationCell[] {
  if (isStoredPrivatePrompt(raw)) {
    const binding = inspectPrivatePrompt(raw).binding;
    if (binding.kind !== kind || binding.id !== id || binding.field !== field) throw new PrivatePromptError();
    return [{ column, path, binding }];
  }
  return origins.length ? [{ column, path, binding: { kind, id, field, origins } }] : [];
}
const one = (origin: PrivateOrigin | null) => origin ? [origin] : [];

// Only inventoried IDs are selected. No account-wide sweep or implicit inclusion of new tasks.
export async function prepareImagePrivateMigration(db: PrismaClient, selection: Selection, options: { rotateBodyKey?: boolean } = {}) {
  const rows: PrivateMigrationRow[] = [];
  let unchangedRows = 0, unclassifiedRows = 0;
  for (const ids of Object.values(selection)) {
    if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)) throw new PrivatePromptError();
  }
  for (const type of ['modules', 'presets'] as const) {
    const ids = selection[type];
    const originals = type === 'modules'
      ? await db.imageStudioModule.findMany({ where: { id: { in: ids } } })
      : await db.imageStudioPreset.findMany({ where: { id: { in: ids } } });
    if (originals.length !== ids.length) throw new PrivatePromptError();
    const kind = type === 'modules' ? 'image-module' : 'image-preset';
    for (const original of originals) {
      const origins = studioDefinitionOrigins(kind, original);
      const cells = ['prompt', 'context'].flatMap(field => cell(original[field as 'prompt' | 'context'], field, [], kind, original.id, field, origins));
      if (!cells.length) { unclassifiedRows++; continue; }
      const next = preparePrivateMigrationRow(type === 'modules' ? 'ImageStudioModule' : 'ImageStudioPreset', original, cells, options);
      if (next) rows.push(next); else unchangedRows++;
    }
  }
  const tasks = await db.imageStudioTask.findMany({ where: { id: { in: selection.tasks } } });
  if (tasks.length !== selection.tasks.length) throw new PrivatePromptError();
  for (const task of tasks) {
    const snapshot = task.snapshot_json ? JSON.parse(task.snapshot_json) as Record<string, unknown> : null;
    const global = one(privateOrigin('image-global', 'gpt_image_studio_v1'));
    const presetId = task.source_preset_id || (typeof snapshot?.sourcePresetId === 'string' ? snapshot.sourcePresetId : null);
    const moduleId = task.module_id || (typeof snapshot?.moduleId === 'string' ? snapshot.moduleId : null);
    const moduleOrigins = one(presetId ? privateOrigin('image-preset', presetId) : moduleId ? privateOrigin('image-module', moduleId) : null);
    const skills = Array.isArray(snapshot?.skills) ? snapshot.skills : [];
    const skillOrigins = skills.flatMap(value => value && typeof value.id === 'string' ? one(privateOrigin('skill', value.id)) : []);
    if (((presetId || moduleId) && !moduleOrigins.length && !isStoredPrivatePrompt(task.context))
      || skills.some(value => value && typeof value.id === 'string' && !privateOrigin('skill', value.id)
        && typeof value.prompt === 'string' && !isStoredPrivatePrompt(value.prompt))) {
      unclassifiedRows++; continue;
    }
    const combined = [...global, ...moduleOrigins, ...skillOrigins];
    const cells = [
      ...cell(task.context, 'context', [], 'image-task', task.id, 'context', combined),
      ...cell(task.prompt, 'prompt', [], 'image-task', task.id, 'prompt', moduleOrigins),
    ];
    if (snapshot) {
      for (const field of ['globalContext', 'moduleContext', 'templatePrompt', 'prompt', 'effectiveContext', 'inputFingerprint']) {
        if (typeof snapshot[field] !== 'string') continue;
        const origins = field === 'globalContext' ? global : ['moduleContext', 'templatePrompt', 'prompt'].includes(field) ? moduleOrigins : combined;
        cells.push(...cell(snapshot[field], 'snapshot_json', [field], 'image-task-snapshot', task.id, field, origins));
      }
      skills.forEach((value, index) => {
        if (!value || typeof value.id !== 'string') return;
        const origins = one(privateOrigin('skill', value.id));
        for (const field of ['prompt', 'promptVersion']) {
          if (typeof value[field] !== 'string') continue;
          cells.push(...cell(value[field], 'snapshot_json', ['skills', index, field], 'image-task-skill', `${task.id}:${index}`, field, origins));
        }
      });
    }
    if (!cells.length) { unclassifiedRows++; continue; }
    const next = preparePrivateMigrationRow('ImageStudioTask', task, cells, options);
    if (next) rows.push(next); else unchangedRows++;
  }
  return { rows, unchangedRows, unclassifiedRows };
}
