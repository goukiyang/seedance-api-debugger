const privateHeaders = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};
const conditionalHeaders = ['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'];

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.href !== url.origin + '/') throw new Error('invalid pilot origin');
  return url.origin;
}

// An undefined result delegates to the existing application route. Disable
// generic response caching for both the pilot route and this passthrough.
export function createHdEdgePilot({ siteOrigin, appOrigin, objectOrigin, entries }, fetchImpl = fetch) {
  const site = httpsOrigin(siteOrigin);
  const app = httpsOrigin(appOrigin);
  const objects = httpsOrigin(objectOrigin);
  if (new Set([site, app, objects]).size !== 3) throw new Error('pilot origins must be distinct');

  const records = new Map();
  for (const entry of entries) {
    const works = entry.route === 'works';
    const object = new URL(entry.objectUrl);
    const path = works ? '/api/works/' + entry.id + '/media' : '/api/image-studio/assets/' + entry.id;
    if ((!works && entry.route !== 'template') || !/^[\w-]{1,160}$/.test(entry.id)
      || (works && (typeof entry.workVersion !== 'string' || !/^[\w-]{1,160}$/.test(entry.workVersion))) || records.has(path)
      || !['avif', 'webp'].includes(entry.format) || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || object.origin !== objects || object.username || object.password || object.hash
      || !object.pathname.endsWith('/' + entry.sha256 + '.' + entry.format)
      || !entry.objectEtag || !entry.sourceVersion || !/^hd-representation-v1:[a-f0-9]{64}$/.test(entry.representationVersion)
      || [entry.width, entry.height, entry.bytes].some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('invalid pilot entry');
    }
    const { sourceVersion, representationVersion, width, height, bytes, format } = entry;
    const mime = 'image/' + format;
    const description = JSON.stringify({ policy: 'hd-f-v1', status: 'ready', sourceVersion, representationVersion,
      width, height, bytes, format, mime, original: false });
    records.set(path, { ...entry, object: object.href, mime, description });
  }

  return async function serveHdPilot(request) {
    const url = new URL(request.url);
    const entry = records.get(url.pathname);
    if (!entry || url.origin !== site || request.method !== 'GET'
      || request.headers.get('x-image-accept') !== 'hd-open-v1'
      || request.headers.get('x-image-read-intent') === 'prefetch'
      || conditionalHeaders.some(name => request.headers.has(name))) return;

    const origin = new URL(url.pathname, app);
    if (entry.route === 'works') {
      if (url.searchParams.size !== 2 || url.searchParams.get('variant') !== 'hd-description'
        || url.searchParams.get('version') !== entry.workVersion) return;
      origin.searchParams.set('variant', 'hd');
      origin.searchParams.set('version', entry.workVersion);
    } else {
      if (url.searchParams.size !== 1 || url.searchParams.get('hd-description') !== '1') return;
      origin.searchParams.set('hd', '1');
    }

    const denial = status => Response.json({ error: '高清图片暂不可读取' }, { status, headers: privateHeaders });
    const cookie = request.headers.get('cookie');
    if (!cookie) return denial(401);
    const authStarted = Date.now();
    let permission;
    try {
      permission = await fetchImpl(origin, { method: 'HEAD', redirect: 'manual', signal: request.signal,
        headers: { Cookie: cookie, 'Cache-Control': 'no-store, no-cache' } });
    } catch {
      return denial(503);
    }
    const authMs = Math.max(0, Date.now() - authStarted);
    if ([401, 403, 404].includes(permission.status)) return denial(permission.status);
    // The existing combined GET returns the actual pending state on this path.
    if (permission.status === 409) return;
    if (permission.status !== 200) return denial(503);
    const allowed = permission.headers;
    if (!allowed.get('cache-control')?.split(',').some(value => value.trim().toLowerCase() === 'no-store')) return denial(503);
    if (allowed.get('x-image-source-version') !== entry.sourceVersion
      || allowed.get('x-image-representation-version') !== entry.representationVersion
      || allowed.get('content-type') !== entry.mime || allowed.get('content-length') !== String(entry.bytes)
      || !allowed.get('etag')) return;

    const objectStarted = Date.now();
    let bytes;
    try {
      bytes = await fetchImpl(entry.object, { redirect: 'manual', signal: request.signal,
        headers: { 'If-Match': entry.objectEtag, 'Accept-Encoding': 'identity' } });
    } catch {
      return;
    }
    const objectHeadersMs = Math.max(0, Date.now() - objectStarted);
    const objectHeaders = bytes.headers;
    if (bytes.status !== 200 || !bytes.body || objectHeaders.has('content-range')
      || (objectHeaders.has('content-encoding') && objectHeaders.get('content-encoding') !== 'identity')
      || objectHeaders.get('content-length') !== String(entry.bytes) || objectHeaders.get('content-type') !== entry.mime
      || objectHeaders.get('etag') !== entry.objectEtag || objectHeaders.get('x-cos-meta-sha256') !== entry.sha256) {
      void bytes.body?.cancel().catch(() => {});
      return;
    }
    return new Response(bytes.body, { headers: { ...privateHeaders,
      'Content-Type': entry.mime, 'Content-Length': String(entry.bytes), 'Content-Disposition': 'inline',
      ETag: allowed.get('etag'), 'X-Image-Source-Version': entry.sourceVersion,
      'Server-Timing': 'hd_edge_auth;dur=' + authMs + ', hd_edge_object_headers;dur=' + objectHeadersMs,
      'X-Image-Representation-Version': entry.representationVersion, 'X-Image-HD-Description': entry.description } });
  };
}
