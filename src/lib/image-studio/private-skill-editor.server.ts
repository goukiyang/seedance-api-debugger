import 'server-only';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type { ImageStudioIdentity } from './access';
import { getSkill, saveSkillInTx } from './skills';
import { privateFieldOrigins } from '@/lib/security/private-prompt-fields.server';
import { requirePrivatePromptRequest } from '@/lib/security/private-prompt-request.server';
import { openPrivatePrompt, sealPrivatePrompt, privatePromptIndex, PrivatePromptError } from '@/lib/security/private-prompts.server';
import { readPrivatePromptDraft, savePrivatePromptDraft, readPrivatePromptDraftReceipt, markPrivatePromptDraftApplied,
  PrivateDraftConflict } from '@/lib/security/private-prompt-drafts.server';

type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'asset' | 'userSession'>;
type Result = { state: 'saved' | 'not-applied'; requestId: string; revision: number };
async function target(user: ImageStudioIdentity, id: string, client: Client = prisma) {
  const skill = await getSkill(user, id, client);
  const origins = privateFieldOrigins(skill, 'prompt');
  if (!origins.length) throw new PrivatePromptError();
  await requirePrivatePromptRequest(user.id, origins, client);
  return { skill, draftTarget: { kind: 'skill', id, origins, fields: ['prompt', 'context'] } };
}
function receiptScope(userId: string, id: string, requestId: string, origins: Awaited<ReturnType<typeof target>>['draftTarget']['origins']) {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new PrivatePromptError();
  const key = `private_skill_editor_receipt_v1:${privatePromptIndex('private-skill-request', JSON.stringify([userId, id, requestId]))}`;
  return { key, binding: { kind: 'private-skill-editor-receipt', id: key, field: 'payload', origins } };
}
async function receipt(client: Client, scope: ReturnType<typeof receiptScope>, requestId: string) {
  const row = await client.platformSetting.findUnique({ where: { key: scope.key }, select: { value_json: true } });
  if (!row) return null;
  const value = JSON.parse(openPrivatePrompt(row.value_json, scope.binding)) as { fingerprint: string; result: Result };
  if (!value || Object.keys(value).sort().join(',') !== 'fingerprint,result' || typeof value.fingerprint !== 'string'
    || !value.result || Object.keys(value.result).sort().join(',') !== 'requestId,revision,state'
    || value.result.requestId !== requestId || !['saved', 'not-applied'].includes(value.result.state)
    || !Number.isSafeInteger(value.result.revision) || value.result.revision < 1) throw new PrivatePromptError();
  return value;
}
export async function readPrivateSkillEditor(user: ImageStudioIdentity, id: string) {
  const { skill, draftTarget } = await target(user, id);
  return { revision: skill.revision, sourceRevision: String(skill.revision), prompt: '', context: skill.prompt,
    draft: await readPrivatePromptDraft(user.id, draftTarget) };
}
export async function savePrivateSkillDraft(user: ImageStudioIdentity, id: string, input: Parameters<typeof savePrivatePromptDraft>[2]) {
  const { draftTarget } = await target(user, id);
  if (input.values?.prompt !== '' || typeof input.values?.context !== 'string' || input.values.context.length > 8000) throw new PrivatePromptError();
  return savePrivatePromptDraft(user.id, draftTarget, input);
}
export async function privateSkillEditorStatus(user: ImageStudioIdentity, id: string, requestId: string, draft: boolean) {
  const { draftTarget } = await target(user, id);
  if (draft) return { requestId, draft: await readPrivatePromptDraftReceipt(user.id, draftTarget, requestId) };
  return (await receipt(prisma, receiptScope(user.id, id, requestId, draftTarget.origins), requestId))?.result
    ?? { requestId, state: 'unknown' };
}
export async function savePrivateSkillEditor(user: ImageStudioIdentity, id: string, input: {
  requestId: string; revision: number; sourceRevision: string; prompt: string; context: string;
}) {
  if (!input || input.prompt !== '' || typeof input.context !== 'string' || !input.context.trim() || input.context.length > 8000
    || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.sourceRevision !== String(input.revision)) throw new PrivatePromptError();
  return prisma.$transaction(async tx => {
    const { skill, draftTarget } = await target(user, id, tx);
    const scope = receiptScope(user.id, id, input.requestId, draftTarget.origins);
    const fingerprint = privatePromptIndex('private-skill-editor-save', JSON.stringify([input.revision, input.context]));
    const prior = await receipt(tx, scope, input.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new PrivateDraftConflict();
      return prior.result;
    }
    let result: Result = { requestId: input.requestId, state: 'not-applied', revision: skill.revision };
    if (skill.revision === input.revision) {
      const saved = await saveSkillInTx(user, { id, revision: skill.revision, name: skill.name,
        coverAssetId: skill.coverAssetId, prompt: input.context }, tx, true);
      await markPrivatePromptDraftApplied(tx, user.id, draftTarget, input.sourceRevision, { prompt: '', context: input.context }, input.requestId);
      result = { requestId: input.requestId, state: 'saved', revision: saved.revision };
    }
    await tx.platformSetting.create({ data: { key: scope.key,
      value_json: sealPrivatePrompt(JSON.stringify({ fingerprint, result }), scope.binding), updated_by: user.id } });
    return result;
  });
}
