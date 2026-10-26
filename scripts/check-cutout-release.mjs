import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [app, dist = '.next-prod', mode = 'candidate'] = process.argv.slice(2);
if (!app || !['candidate', 'public'].includes(mode)) throw Error('Expected app directory, dist directory, candidate/public');
const root = path.join(app, dist);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app-build-manifest.json')));
const paths = JSON.parse(fs.readFileSync(path.join(root, 'server/app-paths-manifest.json')));
const version = JSON.parse(fs.readFileSync(path.join(app, 'package.json'))).version;
if (!paths['/api/cutout/[[...path]]/route']) throw Error('Cutout proxy missing from build');
const resources = manifest.pages['/cutout/page'];
if (!resources?.length) throw Error('Cutout page missing from build');
const scripts = resources.filter(file => file.endsWith('.js'));
const text = scripts.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
for (const marker of ['普通抠图', '角色拆切', '孔洞修复', '细节保护', '阴影保留', '/api/cutout/v1', '背景移除']) {
  if (!text.includes(marker)) throw Error('Missing compiled cutout feature: ' + marker);
}
if (!resources.some(file => file.endsWith('.css'))) throw Error('Cutout style missing from build');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const checks = [];
if (mode === 'public') {
  for (const route of ['/api/release', '/api/config', '/login']) {
    const response = await fetch(`https://sd2.youdooart.com${route}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (response.status !== 200 || response.headers.get('x-sd2-origin') !== 'server-42-193') throw Error('Public origin check failed: ' + route);
    if (route === '/api/release') {
      const result = await response.json();
      if (result.version !== version || result.channel !== 'production' || result.summary !== '') throw Error('Release version or anonymous privacy mismatch');
    } else await response.arrayBuffer();
    checks.push({ route, status: response.status, origin: 'server-42-193' });
  }
}
for (const file of resources) {
  const bytes = fs.readFileSync(path.join(root, file));
  if (mode === 'public') {
    const response = await fetch(`https://sd2.youdooart.com/_next/${file}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (response.status !== 200 || hash(Buffer.from(await response.arrayBuffer())) !== hash(bytes)) throw Error('Public static resource differs: ' + file);
  }
  checks.push({ file, sha256: hash(bytes), matchesArtifact: true });
}
console.log(JSON.stringify({ version, build: fs.readFileSync(path.join(root, 'BUILD_ID'), 'utf8').trim(), mode, checks, functionalAcceptance: 'separate evidence required' }, null, 2));
