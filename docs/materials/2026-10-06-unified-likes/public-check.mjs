import fs from 'node:fs';
import { createHash } from 'node:crypto';
const expected = JSON.parse(fs.readFileSync(process.argv[2]));
const origin = 'https://sd2.youdooart.com';
const request = url => fetch(origin + url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000) });
const releaseResponse = await request('/api/release');
if (!releaseResponse.ok) throw Error('Public release unavailable');
const release = await releaseResponse.json();
if (release.version !== expected.version || release.channel !== 'production') throw Error('Public version mismatch');
const config = await request('/api/config');
if (!config.ok || config.headers.get('x-sd2-origin') !== 'server-42-193') throw Error('Config/origin mismatch');
await config.json();
const login = await request('/login');
if (!login.ok || !(await login.text()).includes('/_next/static/')) throw Error('Login/static entry unavailable');
const assets = [];
for (const asset of expected.assets) {
  const response = await request(asset.url);
  if (!response.ok) throw Error(`Static asset unavailable: ${asset.url}`);
  const sha256 = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  if (sha256 !== asset.sha256) throw Error(`Static artifact mismatch: ${asset.url}`);
  assets.push({ ...asset, status: response.status, matched: true });
}
const canvas = await request('/tools/ultimate-canvas/like-button.css?v=20261006-unified-likes');
if (![302, 307].includes(canvas.status) || !canvas.headers.get('location')?.includes('/login')) throw Error('Canvas auth protection changed');
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), version: release.version, commit: expected.commit, build: expected.build,
  config: { status: config.status, validJson: true, origin: config.headers.get('x-sd2-origin') }, login: { status: login.status }, assets,
  canvas: { status: canvas.status, authProtected: true, publicBytesNotVerified: true },
  acceptance: 'Release/static health only; no business API, DOM, visual, touch or historical-data acceptance' }, null, 2));
