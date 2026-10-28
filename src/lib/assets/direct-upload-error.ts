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

/** Only for a caller that has not staged, published or registered any bytes. */
export function uploadPreflightFailure(error: unknown) {
  const diagnostic = directUploadFailure(error, 'complete');
  const value = error && typeof error === 'object'
    ? error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } : null;
  const status = value?.$metadata?.httpStatusCode;
  const name = value?.name;
  const causeCode = diagnostic.causeCode
    || (typeof status === 'number' && [400, 401, 403, 404, 408, 429, 500, 502, 503, 504].includes(status) ? `HTTP_${status}` : undefined)
    || (typeof name === 'string' && ['TimeoutError', 'AbortError', 'NotFound', 'NoSuchKey', 'AccessDenied'].includes(name) ? name : undefined);
  return { error: '上传检查暂未完成，尚未保存文件；请重试原上传。', code: 'UPLOAD_PREFLIGHT_FAILED', causeCode,
    errorName: diagnostic.errorName, recovery: 'retry' as const };
}
