import 'server-only';
import { privateOrigin, privatePromptPolicy, PrivatePromptError, type PrivateOrigin } from '@/lib/security/private-prompts.server';
import { privateFieldOrigins, privateStoredValue, readPrivateFields, writePrivateFields, transferPrivateFieldOrigin } from '@/lib/security/private-prompt-fields.server';
import { requirePrivatePromptRequest } from '@/lib/security/private-prompt-request.server';

type Definition = { id: string; owner_id?: string; source_preset_id?: string | null; prompt: string; context: string };
type Kind = 'image-module' | 'image-preset';

export function studioDefinitionOrigins(kind: Kind, row: Pick<Definition, 'id' | 'owner_id' | 'source_preset_id'>): PrivateOrigin[] {
  // A workspace copied from another template never becomes that template's author.
  const source = row.source_preset_id ? privateOrigin('image-preset', row.source_preset_id) : null;
  if (row.source_preset_id && !source && privatePromptPolicy()) throw new PrivatePromptError();
  if (source) return [source];
  const own = privateOrigin(kind, row.id, row.owner_id);
  return own ? [own] : [];
}
export function readPrivateStudioDefinition<T extends Definition>(kind: Kind, row: T): T {
  if (privateStoredValue(row) !== row) return row;
  const origins = studioDefinitionOrigins(kind, row);
  return readPrivateFields(row, kind, row.id, ['prompt', 'context'].map(field => ({ field, origins })));
}
export function writePrivateStudioDefinition<T extends Definition>(kind: Kind, row: T, source?: Pick<Definition, 'prompt' | 'context'>): T {
  return writePrivateFields(row, kind, row.id, ['prompt', 'context'].map(field => ({ field,
    origins: source && privateFieldOrigins(source, field).length ? privateFieldOrigins(source, field) : studioDefinitionOrigins(kind, row) })));
}

export async function protectStudioDefinitionPatch<T extends Partial<Pick<Definition, 'prompt' | 'context'>>>(
  kind: Kind, current: Definition, patch: T, actorId: string, privateEdit = false,
): Promise<T> {
  const next = { ...patch };
  const stored = privateStoredValue(current);
  for (const field of ['prompt', 'context'] as const) {
    if (patch[field] === undefined) continue;
    const origins = privateFieldOrigins(current, field);
    // Ordinary DTOs deliberately contain blanks, including for verified authors.
    // Only the explicit private editor may replace a protected field.
    if (origins.length && !privateEdit) { next[field] = stored[field]; continue; }
    if (patch[field] === current[field]) { next[field] = stored[field]; continue; }
    if (origins.length) await requirePrivatePromptRequest(actorId, origins);
    const sealed = writePrivateFields({ [field]: patch[field] }, kind, current.id, [{ field, origins }]);
    next[field] = sealed[field] as T[typeof field];
  }
  return next;
}

type TaskCopy = { id: string; owner_id: string; module_id?: string | null; source_preset_id?: string | null; prompt: string; context: string; snapshot_json: string | null };
const taskSnapshots = new WeakMap<object, Record<string, unknown>>();
export function readPrivateImageTaskSnapshot(task: TaskCopy) {
  const decoded = transformPrivateImageTask(task, false);
  return taskSnapshots.get(decoded) || {};
}
export function privateImageTaskOrigins(task: TaskCopy) {
  const origins = privateFieldOrigins(task, 'context');
  const promptOrigins = privateFieldOrigins(task, 'prompt');
  const snapshot = task.snapshot_json ? JSON.parse(task.snapshot_json) as Record<string, unknown> : null;
  const skills = Array.isArray(snapshot?.skills) ? snapshot.skills.flatMap(skill => {
    const origin = skill && typeof skill.id === 'string' ? privateOrigin('skill', skill.id) : null;
    return origin ? [origin] : [];
  }) : [];
  if (origins.length || promptOrigins.length) return [...origins, ...promptOrigins, ...skills];
  const global = privateOrigin('image-global', 'gpt_image_studio_v1');
  const source = task.source_preset_id ? privateOrigin('image-preset', task.source_preset_id)
    : task.module_id ? privateOrigin('image-module', task.module_id) : null;
  return [...(global ? [global] : []), ...(source ? [source] : []), ...skills];
}
export function transformPrivateImageTask<T extends TaskCopy>(task: T, write: boolean): T {
  if (!write && privateStoredValue(task) !== task) return task;
  const snapshot = task.snapshot_json ? JSON.parse(task.snapshot_json) as Record<string, unknown> : null;
  const global = privateOrigin('image-global', 'gpt_image_studio_v1');
  const sourceId = task.source_preset_id || (typeof snapshot?.sourcePresetId === 'string' ? snapshot.sourcePresetId : null);
  const moduleId = task.module_id || (typeof snapshot?.moduleId === 'string' ? snapshot.moduleId : null);
  const source = sourceId ? privateOrigin('image-preset', sourceId) : moduleId ? privateOrigin('image-module', moduleId) : null;
  const globalOrigins = global ? [global] : [];
  const moduleOrigins = source ? [source] : [];
  const skillOrigins = Array.isArray(snapshot?.skills) ? snapshot.skills.flatMap(skill => {
    const origin = skill && typeof skill.id === 'string' ? privateOrigin('skill', skill.id) : null;
    return origin ? [origin] : [];
  }) : [];
  const inherited = privateFieldOrigins(task, 'context');
  const combined = inherited.length ? inherited : [...globalOrigins, ...moduleOrigins, ...skillOrigins];
  const operation = write ? writePrivateFields : readPrivateFields;
  const result = operation(task, 'image-task', task.id, [
    { field: 'context', origins: combined },
    { field: 'prompt', origins: moduleOrigins },
  ]);
  if (snapshot) {
    const fields = ['globalContext', 'moduleContext', 'templatePrompt', 'prompt', 'effectiveContext', 'inputFingerprint']
      .filter(field => typeof snapshot[field] === 'string').map(field => ({ field,
        origins: field === 'globalContext' ? globalOrigins : ['moduleContext', 'templatePrompt', 'prompt'].includes(field) ? moduleOrigins : combined }));
    const transformed = operation(snapshot, 'image-task-snapshot', task.id, fields);
    if (Array.isArray(snapshot.skills)) transformed.skills = snapshot.skills.map((value, index) => {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string') return value;
      const origin = privateOrigin('skill', value.id);
      return operation(value, 'image-task-skill', `${task.id}:${index}`, ['prompt', 'promptVersion']
        .filter(field => typeof value[field] === 'string').map(field => ({ field, origins: origin ? [origin] : [] })));
    });
    result.snapshot_json = JSON.stringify(transformed);
    if (!write) {
      taskSnapshots.set(result, transformed);
      transferPrivateFieldOrigin(transformed, 'effectiveContext', result, 'context');
    }
  }
  return result;
}
