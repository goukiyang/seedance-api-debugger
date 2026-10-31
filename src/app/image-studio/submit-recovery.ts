export type StudioRequestReceipt = {
  schema: 'image.submit-receipt.v1';
  requestId: string;
  state: 'accepted' | 'rejected' | 'unknown' | 'closed';
  code?: string;
  stage?: string;
  message?: string;
  taskIds?: string[];
  batchId?: string;
};

// HTTP status and submitted:false are not proof that an original request ended.
export function matchingStudioRequestReceipt(value: unknown, requestId: string): StudioRequestReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.requestId !== requestId) return null;
  const candidate = envelope.receipt === undefined ? envelope : envelope.receipt;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const receipt = candidate as Record<string, unknown>;
  if (receipt.schema !== 'image.submit-receipt.v1' || receipt.requestId !== requestId || !['accepted', 'rejected', 'unknown', 'closed'].includes(String(receipt.state))) return null;
  return { schema: 'image.submit-receipt.v1', requestId, state: receipt.state as StudioRequestReceipt['state'],
    ...(typeof receipt.code === 'string' ? { code: receipt.code } : {}),
    ...(typeof receipt.stage === 'string' ? { stage: receipt.stage } : {}),
    ...(typeof receipt.message === 'string' ? { message: receipt.message } : typeof envelope.message === 'string' ? { message: envelope.message } : typeof envelope.error === 'string' ? { message: envelope.error } : {}),
    ...(Array.isArray(receipt.taskIds) && receipt.taskIds.every(id => typeof id === 'string') ? { taskIds: receipt.taskIds as string[] } : {}),
    ...(typeof receipt.batchId === 'string' ? { batchId: receipt.batchId } : {}) };
}

export function isStudioRequestEnded(receipt: StudioRequestReceipt | null): boolean {
  return receipt?.state === 'rejected' || receipt?.state === 'closed';
}

export function studioRequestOutcomeMessage(receipt: StudioRequestReceipt | null, fallback: string, serverError?: unknown): string {
  if (typeof serverError === 'string' && serverError.trim()) return serverError;
  if (isStudioRequestEnded(receipt)) {
    if (receipt?.code === 'PERSONAL_PROMPT_ENCRYPTED') return '个人补充含有旧加密内容，已在接单前拒绝。当前明文输入保留，请重新填写后再生成。';
    if (receipt?.code === 'PRIVATE_PROMPT_UNAVAILABLE') return '接单前未能读取本次私密设置，生成未被受理。输入保留，可稍后重试或联系管理员。';
  }
  return receipt?.message || fallback;
}
