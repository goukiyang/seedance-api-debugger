// Only command metadata belongs here. Template bodies, personal input and
// asset URLs remain in the existing separate draft, never in the unknown lock.
export type FixedReferenceSavePending = {
  version: 1; actorId: string; moduleId: string; presetId: string; requestId: string;
  expectedRevision: number; definitionToken: string;
};
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
export const fixedReferenceSaveKey = (actorId: string, moduleId: string) =>
  `sd2:fixed-reference-save:v1:${encodeURIComponent(actorId)}:${encodeURIComponent(moduleId)}`;
function parse(raw: string | null, actorId: string, moduleId: string): FixedReferenceSavePending | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!plain(value) || value.version !== 1 || value.actorId !== actorId || value.moduleId !== moduleId
    || !id(value.actorId) || !id(value.moduleId) || !id(value.presetId) || !id(value.requestId)
    || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0
    || typeof value.definitionToken !== 'string' || !value.definitionToken || value.definitionToken.length > 160) {
    throw new Error('原修复保存记录无法确认，请保留当前草稿并核对本机存储');
  }
  return { version: 1, actorId, moduleId, presetId: value.presetId, requestId: value.requestId,
    expectedRevision: value.expectedRevision as number, definitionToken: value.definitionToken };
}
export function readFixedReferenceSave(actorId: string, moduleId: string) {
  return parse(localStorage.getItem(fixedReferenceSaveKey(actorId, moduleId)), actorId, moduleId);
}
export async function claimFixedReferenceSave(command: FixedReferenceSavePending) {
  const key = fixedReferenceSaveKey(command.actorId, command.moduleId);
  // Serialize claims from the same origin's tabs, not unrelated objects.
  if (!navigator.locks) throw new Error('浏览器暂不能安全保存修复记录，本次尚未提交');
  return navigator.locks.request(key, () => {
    if (readFixedReferenceSave(command.actorId, command.moduleId)) throw new Error('此模板已有待确认保存，请先核对原保存');
    const raw = JSON.stringify({ version: 1, actorId: command.actorId, moduleId: command.moduleId, presetId: command.presetId,
      requestId: command.requestId, expectedRevision: command.expectedRevision, definitionToken: command.definitionToken });
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw new Error('修复保存记录未能持久保留，本次尚未提交');
    return parse(raw, command.actorId, command.moduleId)!;
  });
}
export async function clearFixedReferenceSave(command: FixedReferenceSavePending) {
  const key = fixedReferenceSaveKey(command.actorId, command.moduleId);
  if (!navigator.locks) throw new Error('浏览器暂不能安全清理原保存记录，请保留草稿');
  return navigator.locks.request(key, () => {
    const current = readFixedReferenceSave(command.actorId, command.moduleId);
    if (current && current.requestId !== command.requestId) throw new Error('原保存记录已变化，请继续核对，不会重新提交');
    if (current) localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw new Error('原保存已确认，但本机记录尚未清理，请再次核对');
  });
}
export function fixedReferenceReceiptMatches(value: unknown, command: FixedReferenceSavePending): boolean {
  if (!plain(value) || value.status !== 'completed' || !plain(value.receipt)) return false;
  const receipt = value.receipt;
  // This GET is authenticated and keyed by the original actor/requestId. Its
  // receipt is historical; a different current state is never proof of success.
  return receipt.moduleId === command.moduleId && receipt.presetId === command.presetId
    && receipt.beforeRevision === command.expectedRevision && receipt.revision === command.expectedRevision + 1
    && typeof receipt.sourceRevision === 'string' && Number.isFinite(Date.parse(receipt.sourceRevision))
    && typeof receipt.definitionToken === 'string' && Boolean(receipt.definitionToken);
}
export function fixedReferenceSaveRejected(value: unknown, command: FixedReferenceSavePending): boolean {
  return plain(value) && plain(value.commandOutcome) && value.commandOutcome.status === 'not-applied'
    && value.commandOutcome.actorId === command.actorId && value.commandOutcome.moduleId === command.moduleId
    && value.commandOutcome.requestId === command.requestId;
}
