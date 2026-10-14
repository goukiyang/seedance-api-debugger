'use client';

// Only the original request id is retained; no template, URL or personal input.
export const sharedOpenKey = (actorId: string, presetId: string) => `sd2-shared-open:v1:${actorId}:${presetId}`;
function read(key: string) {
  const value = localStorage.getItem(key);
  if (value !== null && !/^[A-Za-z0-9-]{16,80}$/.test(value)) throw new Error('原打开编号无法确认，请保留现场并核对本机记录');
  return value;
}
export async function claimSharedOpen(actorId: string, presetId: string, allowNew: boolean) {
  const key = sharedOpenKey(actorId, presetId);
  if (!navigator.locks) throw new Error('浏览器暂不能安全记住打开请求，尚未提交');
  return navigator.locks.request(key, () => {
    const existing = read(key);
    if (existing) return { requestId: existing, retained: true };
    if (!allowNew) return null;
    const requestId = crypto.randomUUID();
    localStorage.setItem(key, requestId);
    if (read(key) !== requestId) throw new Error('打开编号未能保存，尚未提交');
    return { requestId, retained: false };
  });
}
export async function clearSharedOpen(actorId: string, presetId: string, requestId: string) {
  const key = sharedOpenKey(actorId, presetId);
  if (!navigator.locks) throw new Error('原打开结果已确认，但本机编号尚未清理，请再次核对');
  await navigator.locks.request(key, () => {
    const current = read(key);
    if (current && current !== requestId) throw new Error('打开记录已有变化，请核对当前请求');
    if (current) localStorage.removeItem(key);
    if (read(key) !== null) throw new Error('本机打开记录尚未清理，请再次核对');
  });
}
