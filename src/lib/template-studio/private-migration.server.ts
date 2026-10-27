import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { privateOrigin, inspectPrivatePrompt, isStoredPrivatePrompt, PrivatePromptError, type PrivateOrigin } from '@/lib/security/private-prompts.server';
import { preparePrivateMigrationRow, type PrivateMigrationCell, type PrivateMigrationRow } from '@/lib/security/private-prompt-migration.server';
import { videoTemplateOrigins } from './private-storage.server';

type Selection = { templates: string[]; versions: string[]; drafts: string[]; runs: string[] };
const one = (origin: PrivateOrigin | null) => origin ? [origin] : [];
function cell(raw: unknown, column: string, path: Array<string | number>, kind: string, id: string,
  field: string, origins: PrivateOrigin[]): PrivateMigrationCell[] {
  if (typeof raw !== 'string') throw new PrivatePromptError();
  if (isStoredPrivatePrompt(raw)) {
    const binding = inspectPrivatePrompt(raw).binding;
    if (binding.kind !== kind || binding.id !== id || binding.field !== field) throw new PrivatePromptError();
    return [{ column, path, binding }];
  }
  return origins.length ? [{ column, path, binding: { kind, id, field, origins } }] : [];
}

export async function prepareVideoStudioPrivateMigration(db: PrismaClient, selection: Selection, options: { rotateBodyKey?: boolean } = {}) {
  const rows: PrivateMigrationRow[] = [];
  let unchangedRows = 0, unclassifiedRows = 0;
  for (const ids of Object.values(selection)) {
    if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)) throw new PrivatePromptError();
  }
  const append = (table: Parameters<typeof preparePrivateMigrationRow>[0], original: Parameters<typeof preparePrivateMigrationRow>[1], cells: PrivateMigrationCell[]) => {
    if (!cells.length) { unclassifiedRows++; return; }
    const prepared = preparePrivateMigrationRow(table, original, cells, options);
    if (prepared) rows.push(prepared); else unchangedRows++;
  };
  const templates = await db.videoStudioTemplate.findMany({ where: { id: { in: selection.templates } } });
  const versions = await db.videoStudioTemplateVersion.findMany({ where: { id: { in: selection.versions } } });
  const drafts = await db.videoStudioDraft.findMany({ where: { id: { in: selection.drafts } } });
  const runs = await db.videoStudioRun.findMany({ where: { id: { in: selection.runs } } });
  if (templates.length !== selection.templates.length || versions.length !== selection.versions.length
    || drafts.length !== selection.drafts.length || runs.length !== selection.runs.length) throw new PrivatePromptError();
  for (const row of templates) append('VideoStudioTemplate', row,
    cell(JSON.parse(row.recipe_json).instruction, 'recipe_json', ['instruction'], 'video-template', row.id, 'instruction', videoTemplateOrigins(row.id, row.owner_user_id)));
  for (const row of versions) append('VideoStudioTemplateVersion', row,
    cell(JSON.parse(row.recipe_json).instruction, 'recipe_json', ['instruction'], 'video-template-version', row.id, 'instruction', videoTemplateOrigins(row.template_id)));
  for (const row of drafts) {
    if (!row.template_snapshot_json) { unclassifiedRows++; continue; }
    const value = JSON.parse(row.template_snapshot_json);
    const origins = value.ref?.templateSource === 'studio' ? videoTemplateOrigins(value.ref.templateId) : [];
    append('VideoStudioDraft', row, cell(value.recipe?.instruction, 'template_snapshot_json', ['recipe', 'instruction'], 'video-draft', row.id, 'instruction', origins));
  }
  for (const row of runs) {
    const value = JSON.parse(row.snapshot_json);
    const recipe = value.templateVersion?.templateSource === 'studio' ? videoTemplateOrigins(value.templateVersion.templateId) : [];
    const moduleOrigin = one(privateOrigin('video-module-context', row.draft_id));
    const moduleOrigins = moduleOrigin.length ? moduleOrigin : recipe;
    if (value.templateVersion?.templateSource === 'studio' && !recipe.length && !isStoredPrivatePrompt(value.recipe?.instruction)
      || value.privateContext?.module && !moduleOrigins.length && !isStoredPrivatePrompt(value.privateContext.module)) {
      unclassifiedRows++; continue;
    }
    const cells: PrivateMigrationCell[] = [];
    if (value.privateContext) {
      cells.push(...cell(value.privateContext.global, 'snapshot_json', ['privateContext', 'global'], 'video-run', row.id, 'global', one(privateOrigin('video-global', 'video_studio_context_v1'))));
      cells.push(...cell(value.privateContext.module, 'snapshot_json', ['privateContext', 'module'], 'video-run', row.id, 'module', moduleOrigins));
    }
    if (value.recipe) cells.push(...cell(value.recipe.instruction, 'snapshot_json', ['recipe', 'instruction'], 'video-run', row.id, 'instruction', recipe));
    // With explicit privateContext, prompt is the user's direct input, not a copied template instruction.
    cells.push(...cell(value.prompt, 'snapshot_json', ['prompt'], 'video-run', row.id, 'prompt', value.privateContext ? [] : recipe));
    const credential = value.privateProvider?.settings?.api_key;
    if (typeof credential === 'string') cells.push(...cell(credential, 'snapshot_json', ['privateProvider', 'settings', 'api_key'],
      'provider-credential', `video-run:${row.id}:musk`, 'api_key', one(privateOrigin('provider-credential', `video-run:${row.id}:musk`))));
    append('VideoStudioRun', row, cells);
  }
  return { rows, unchangedRows, unclassifiedRows };
}
