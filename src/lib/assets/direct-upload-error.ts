/** Bounded diagnostics for the direct-upload family; never serialize an SDK error. */
export function directUploadFailure(error: unknown, errorStage: 'proxy' | 'complete') {
  const codes = new Set(['ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ABORT_ERR']);
  const names = new Set(['AggregateError', 'TimeoutError', 'AbortError', 'Error', 'NetworkingError']);
  const queue: unknown[] = [error], seen = new Set<unknown>();
  let causeCode: string | undefined;
  for (let visited = 0; queue.length && visited < 12; visited++) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const current = value as { code?: unknown; cause?: unknown; errors?: unknown[] };
    if (!causeCode && typeof current.code === 'string' && codes.has(current.code)) causeCode = current.code;
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors.slice(0, 8));
  }
  const rawName = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return {
    error: errorStage === 'proxy' ? '上传服务连接未完成，原上传结果待确认；请核对原上传' : '上传登记暂不可用，原上传结果待确认；请核对原上传',
    code: 'UPLOAD_RESULT_UNKNOWN', causeCode,
    errorName: typeof rawName === 'string' && names.has(rawName) ? rawName : 'Error',
    errorStage, recovery: 'query' as const,
  };
}
