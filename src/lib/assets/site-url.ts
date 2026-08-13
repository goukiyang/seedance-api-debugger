const DEFAULT_SITE_PUBLIC_BASE_URL = 'https://sd2.youdooart.com';

const LEGACY_SITE_UPLOAD_BASE_URLS = [
  'https://sd2.youdoodesign.com',
];

function normalizeBaseUrl(value: string | null | undefined) {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function isPublicHttpBaseUrl(value: string | null | undefined) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost'
      || host === '127.0.0.1'
      || host === '0.0.0.0'
      || host === '::1'
      || host.startsWith('10.')
      || host.startsWith('127.')
      || host.startsWith('169.254.')
      || host.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      || host.endsWith('.local')
    ) {
      return false;
    }
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function unique(values: Array<string | null>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function isLegacySiteBaseUrl(baseUrl: string | null | undefined) {
  const normalized = normalizeBaseUrl(baseUrl);
  return Boolean(normalized && LEGACY_SITE_UPLOAD_BASE_URLS.includes(normalized));
}

export function resolveSitePublicBaseUrl() {
  const rawCandidates = [
    process.env.SITE_PUBLIC_BASE_URL,
    process.env.BASE_URL,
    process.env.NEXTAUTH_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
  ];
  const candidates = unique(rawCandidates.map(normalizeBaseUrl));
  const current = candidates.find((value) => isPublicHttpBaseUrl(value) && !isLegacySiteBaseUrl(value));
  if (current) return current;

  // 迁移后旧域名已返回 410；如果运行环境还残留旧公开域名，站内上传资源必须改用新生产域名。
  if (candidates.some(isLegacySiteBaseUrl) || process.env.NODE_ENV === 'production') {
    return DEFAULT_SITE_PUBLIC_BASE_URL;
  }
  return null;
}

export function siteUploadBaseUrls() {
  return unique([
    resolveSitePublicBaseUrl(),
    normalizeBaseUrl(process.env.SITE_PUBLIC_BASE_URL),
    normalizeBaseUrl(process.env.BASE_URL),
    normalizeBaseUrl(process.env.NEXTAUTH_URL),
    normalizeBaseUrl(process.env.NEXT_PUBLIC_BASE_URL),
    DEFAULT_SITE_PUBLIC_BASE_URL,
    ...LEGACY_SITE_UPLOAD_BASE_URLS,
  ]);
}

export function siteUploadPathFromUrl(url: string | null | undefined) {
  const trimmed = (url || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/uploads/')) {
    return trimmed.split(/[?#]/, 1)[0] || null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!parsed.pathname.startsWith('/uploads/')) return null;
  const origin = normalizeBaseUrl(parsed.origin);
  return origin && siteUploadBaseUrls().includes(origin) ? parsed.pathname : null;
}

export function isSiteUploadUrl(url: string | null | undefined) {
  return Boolean(siteUploadPathFromUrl(url));
}

export function sameOriginPublicUrlForSiteUpload(url: string | null | undefined) {
  const uploadPath = siteUploadPathFromUrl(url);
  const baseUrl = resolveSitePublicBaseUrl();
  return uploadPath && baseUrl ? `${baseUrl}${uploadPath}` : null;
}
