import 'server-only';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { privateVideoContextTarget, writePrivateVideoContext } from './context';
import { openPrivatePrompt, sealPrivatePrompt, privatePromptIndex, PrivatePromptError } from '@/lib/security/private-prompts.server';
import { readPrivatePromptDraft, savePrivatePromptDraft, readPrivatePromptDraftReceipt, markPrivatePromptDraftApplied,
  PrivateDraftConflict } from '@/lib/security/private-prompt-drafts.server';

type Client = Pick<Prisma.TransactionClient, 'platformSetting'>;
type Result = { state: 'saved' | 'not-applied'; requestId: string; revision: number };
const draftId = (id: string) => id === 'video-global' ? undefined : id;
function receiptScope(userId: string, id: string, requestId: string, origins: Awaited<ReturnType<typeof privateVideoContextTarget>>['draftTarget']['origins']) {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new PrivatePromptError();
  const key = `private_video_context_receipt_v1:${privatePromptIndex('private-video-context-request', JSON.stringify([userId, id, requestId]))}`;
  return { key, binding: { kind: 'private-video-context-receipt', id: key, field: 'payload', origins } };
}
async function receipt(client: Client, scope: ReturnType<typeof receiptScope>, requestId: string) {
  const row = await client.platformSetting.findUnique({ where: { key: scope.key }, select: { value_json: true } });
  if (!row) return null;
  const value = JSON.parse(openPrivatePrompt(row.value_json, scope.binding)) as { fingerprint: string; result: Result };
  if (!value || Object.keys(value).sort().join(',') !== 'fingerprint,result' || typeof value.fingerprint !== 'string'
    || !value.result || Object.keys(value.result).sort().join(',') !== 'requestId,revision,state'
    || value.result.requestId !== requestId || !['saved', 'not-applied'].includes(value.result.state)
    || !Number.isSafeInteger(value.result.revision) || value.result.revision < 0) throw new PrivatePromptError();
  return value;
}
export async function readPrivateVideoContextEditor(user: SessionUser, id: string) {
  const { setting, draftTarget } = await privateVideoContextTarget(user, draftId(id));
  return { revision: setting.revision, sourceRevision: String(setting.revision), prompt: '', context: setting.context,
    draft: await readPrivatePromptDraft(user.id, draftTarget) };
}
export async function savePrivateVideoContextDraft(user: SessionUser, id: string, input: Parameters<typeof savePrivatePromptDraft>[2]) {
  const { draftTarget } = await privateVideoContextTarget(user, draftId(id));
  if (input.values?.prompt !== '' || typeof input.values?.context !== 'string' || input.values.context.length > 12000) throw new PrivatePromptError();
  return savePrivatePromptDraft(user.id, draftTarget, input);
}
export async function privateVideoContextStatus(user: SessionUser, id: string, requestId: string, draft: boolean) {
  const { draftTarget } = await privateVideoContextTarget(user, draftId(id));
  if (draft) return { requestId, draft: await readPrivatePromptDraftReceipt(user.id, draftTarget, requestId) };
  return (await receipt(prisma, receiptScope(user.id, id, requestId, draftTarget.origins), requestId))?.result
    ?? { requestId, state: 'unknown' };
}
export async function savePrivateVideoContextEditor(user: SessionUser, id: string, input: {
  requestId: string; revision: number; sourceRevision: string; prompt: string; context: string;
}) {
  if (!input || input.prompt !== '' || typeof input.context !== 'string' || input.context.length > 12000
    || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.sourceRevision !== String(input.revision)) throw new PrivatePromptError();
  return prisma.$transaction(async tx => {
    const target = await privateVideoContextTarget(user, draftId(id), tx);
    const { setting, draftTarget } = target;
    const scope = receiptScope(user.id, id, input.requestId, draftTarget.origins);
    const fingerprint = privatePromptIndex('private-video-context-save', JSON.stringify([input.revision, input.context]));
    const prior = await receipt(tx, scope, input.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new PrivateDraftConflict();
      return prior.result;
    }
    let result: Result = { requestId: input.requestId, state: 'not-applied', revision: setting.revision };
    if (setting.revision === input.revision) {
      const revision = await writePrivateVideoContext(tx, user, target, input.context);
      await markPrivatePromptDraftApplied(tx, user.id, draftTarget, input.sourceRevision, { prompt: '', context: input.context }, input.requestId);
      result = { requestId: input.requestId, state: 'saved', revision };
    }
    await tx.platformSetting.create({ data: { key: scope.key,
      value_json: sealPrivatePrompt(JSON.stringify({ fingerprint, result }), scope.binding), updated_by: user.id } });
    return result;
  });
}
