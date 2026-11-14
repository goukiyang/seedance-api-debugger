const escapedReferenceMediaQuery = /\\\/api\\\/provider\\\/reference-media\?[^\s"'<>\\]*/gi;
const referenceMediaQuery = /\/api\/provider\/reference-media\?[^\s"'<>\\]*/gi;

export type ProviderReferenceMediaRedactor = <T>(value: T) => T;

function redactValue<T>(value: T, redactString: (value: string) => string): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map(item => redactValue(item, redactString)) as T;
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Error) {
    const error = new Error(redactString(value.message));
    error.name = redactString(value.name);
    error.stack = value.stack === undefined ? undefined : redactString(value.stack);
    return Object.assign(error, redactValue({ ...value }, redactString),
      value.cause === undefined ? {} : { cause: redactValue(value.cause, redactString) }) as T;
  }
  return Object.fromEntries(Object.entries(value).map(([key, current]) => [
    redactString(key), redactValue(current, redactString),
  ])) as T;
}

function redactReferenceMediaUri(value: string) {
  return value.replace(escapedReferenceMediaQuery, '/api/provider/reference-media?[redacted]')
    .replace(referenceMediaQuery, '/api/provider/reference-media?[redacted]');
}

export function sanitizeProviderReferenceMedia<T>(value: T): T {
  return redactValue(value, redactReferenceMediaUri);
}

export function createProviderReferenceMediaRedactor(referenceVideoUrls?: readonly string[] | null): ProviderReferenceMediaRedactor {
  const fragments = new Set<string>();
  for (const value of referenceVideoUrls || []) {
    let url: URL;
    try { url = new URL(value); } catch { continue; }
    if (url.pathname !== '/api/provider/reference-media') continue;
    const ticket = url.searchParams.get('ticket');
    for (const fragment of [value, url.toString(), ticket, url.search.match(/[?&]ticket=([^&]*)/)?.[1]]) {
      if (!fragment) continue;
      const encoded = encodeURIComponent(fragment);
      fragments.add(fragment);
      fragments.add(fragment.replaceAll('/', '\\/'));
      fragments.add(encoded);
      fragments.add(encoded.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()));
    }
  }
  const known = [...fragments].sort((a, b) => b.length - a.length);
  return <T>(value: T): T => redactValue(value, text => {
    for (const fragment of known) text = text.split(fragment).join('[redacted]');
    return redactReferenceMediaUri(text);
  });
}
