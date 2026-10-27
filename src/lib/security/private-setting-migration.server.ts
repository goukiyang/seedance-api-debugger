import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { privateOrigin, inspectPrivatePrompt, isStoredPrivatePrompt, PrivatePromptError, type PrivateOrigin } from './private-prompts.server';
import { preparePrivateMigrationRow, type PrivateMigrationCell, type PrivateMigrationRow } from './private-prompt-migration.server';
import { historicalStudioReceiptBinding } from '@/lib/image-studio/private-compat-receipt.server';

const credentialsKey = (key: string) => ['musk_api_v1', 'image_generation_api_v1', 'banana_image_api_v1', 'image_generation_channels_v1'].includes(key)
  || key.startsWith('image_generation_legacy_model_api_v1:') || key.startsWith('image_generation_channel_version_v1:');
const one = (origin: PrivateOrigin | null) => origin ? [origin] : [];

export async function preparePrivateSettingMigration(db: PrismaClient, settingIds: string[], options: { rotateBodyKey?: boolean } = {}) {
  if (settingIds.length > 1000 || new Set(settingIds).size !== settingIds.length || settingIds.some(id => typeof id !== 'string' || !id)) throw new PrivatePromptError();
  const originals = await db.platformSetting.findMany({ where: { id: { in: settingIds } } });
  if (originals.length !== settingIds.length) throw new PrivatePromptError();
  const rows: PrivateMigrationRow[] = [];
  let unchangedRows = 0, unclassifiedRows = 0;
  for (const row of originals) {
    if (row.key.startsWith('studio_shared_compat_receipt_v1:')) {
      const binding = historicalStudioReceiptBinding(row.key, row.value_json);
      const prepared = preparePrivateMigrationRow('PlatformSetting', row,
        [{ column: 'value_json', path: [], binding }], options);
      if (prepared) rows.push(prepared); else unchangedRows++;
      continue;
    }
    const value = JSON.parse(row.value_json);
    const cells: PrivateMigrationCell[] = [];
    let unknownOrigin = false;
    const add = (raw: unknown, path: Array<string | number>, kind: string, id: string, field: string, origins: PrivateOrigin[]) => {
      if (typeof raw !== 'string') throw new PrivatePromptError();
      if (isStoredPrivatePrompt(raw)) {
        const binding = inspectPrivatePrompt(raw).binding;
        if (binding.kind !== kind || binding.id !== id || binding.field !== field) throw new PrivatePromptError();
        cells.push({ column: 'value_json', path, binding });
      } else if (origins.length) cells.push({ column: 'value_json', path, binding: { kind, id, field, origins } });
      else unknownOrigin = true;
    };
    if (row.key === 'gpt_image_studio_v1' || row.key === 'video_studio_context_v1') {
      const kind = row.key === 'gpt_image_studio_v1' ? 'image-global' : 'video-global';
      add(value.context, ['context'], kind, row.key, 'context', one(privateOrigin(kind, row.key)));
    } else if (row.key.startsWith('video_studio_module_context:')) {
      const id = row.key.slice('video_studio_module_context:'.length);
      add(value.context, ['context'], 'video-module-context', id, 'context', one(privateOrigin('video-module-context', id)));
    } else if (row.key.startsWith('studio_skill_v1:')) {
      if (typeof value.id !== 'string' || typeof value.ownerId !== 'string' || row.key !== `studio_skill_v1:${value.ownerId}:${value.id}`) throw new PrivatePromptError();
      const origins = one(privateOrigin('skill', value.id, value.ownerId));
      for (const field of ['prompt', 'promptVersion']) add(value[field], [field], 'skill', value.id, field, origins);
    } else if (row.key.startsWith('studio_shared_reproduction_v1:')) {
      if (value.version === 2 && value.moduleContext === undefined && value.globalContext === undefined) { unchangedRows++; continue; }
      const id = row.key.slice('studio_shared_reproduction_v1:'.length);
      if (typeof value.sourceTaskId !== 'string') throw new PrivatePromptError();
      const task = await db.imageStudioTask.findUnique({ where: { id: value.sourceTaskId }, select: { module_id: true } });
      const definition = task?.module_id ? await db.imageStudioModule.findUnique({ where: { id: task.module_id },
        select: { id: true, owner_id: true, source_preset_id: true } }) : null;
      const origin = definition?.source_preset_id ? privateOrigin('image-preset', definition.source_preset_id)
        : definition ? privateOrigin('image-module', definition.id, definition.owner_id) : privateOrigin('image-preset', id);
      add(value.moduleContext, ['moduleContext'], 'image-reproduction', id, 'moduleContext', one(origin));
      if (typeof value.globalContext === 'string') add(value.globalContext, ['globalContext'], 'image-reproduction', id, 'globalContext',
        one(privateOrigin('image-global', 'gpt_image_studio_v1')));
    } else if (credentialsKey(row.key)) {
      const origins = one(privateOrigin('provider-credential', row.key));
      const visit = (node: unknown, path: Array<string | number>, credentialMap = false) => {
        if (Array.isArray(node)) { node.forEach((child, index) => visit(child, [...path, index])); return; }
        if (!node || typeof node !== 'object') return;
        for (const [field, child] of Object.entries(node)) {
          const location = [...path, field];
          if (typeof child === 'string' && child && (credentialMap || ['api_key', 'apiKey', 'inherited_api_key'].includes(field))) {
            add(child, location, 'provider-credential', row.key, location.join('/'), origins);
          } else visit(child, location, field === 'modelApiKeys');
        }
      };
      visit(value, []);
    } else throw new PrivatePromptError();
    if (unknownOrigin || !cells.length) { unclassifiedRows++; continue; }
    const prepared = preparePrivateMigrationRow('PlatformSetting', row, cells, options);
    if (prepared) rows.push(prepared); else unchangedRows++;
  }
  return { rows, unchangedRows, unclassifiedRows };
}
