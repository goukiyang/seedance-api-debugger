const privateKey = /token|secret|password|authorization|cookie|api[_-]?key|credential|signature/i;
function redactText(value: string) {
  return value.slice(0, 65536).replace(/https?:\/\/[^\s"<>]+/g, candidate => {
    try {
      const url = new URL(candidate);
      url.username = ''; url.password = '';
      for (const key of [...url.searchParams.keys()]) if (privateKey.test(key)) url.searchParams.set(key, '[redacted]');
      return url.toString();
    } catch { return '[invalid url]'; }
  }).replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted authorization]');
}

export function taskDebugJson(source: string | null): string | null {
  if (!source) return null;
  if (source.length > 2 * 1024 * 1024) return JSON.stringify({ unavailable: '响应过大，未载入' });
  let value: unknown;
  try { value = JSON.parse(source); } catch { return JSON.stringify({ unavailable: '响应不是有效 JSON，未载入原文' }); }
  let remaining = 10000;
  function visit(item: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 12) return '[truncated]';
    if (typeof item === 'string') return redactText(item);
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (Array.isArray(item)) return item.slice(0, 1000).map(entry => visit(entry, depth + 1));
    if (!item || typeof item !== 'object') return null;
    return Object.fromEntries(Object.entries(item).slice(0, 1000).map(([key, entry]) =>
      [key, privateKey.test(key) ? '[redacted]' : visit(entry, depth + 1)]));
  }
  return JSON.stringify(visit(value, 0));
}
