import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [app, dist, commit, mode = 'candidate'] = process.argv.slice(2);
const root = path.join(app, dist), manifest = JSON.parse(fs.readFileSync(path.join(root, 'app-build-manifest.json')));
const checks = [
  ['/template-studio/page', '开始批量生成'], ['/template-studio/page', '演化内容'],
  ['/template-studio/page', '完成提醒'], ['/template-studio/page', 'favoriteOnly'],
  ['/template-studio/page', '/assets?view=favorites&category=template'],
  ['/tools/avatar-studio/page', 'onDoubleClick'], ['/tools/avatar-studio/page', '已生成的四宫格整图'],
  ['/tools/avatar-studio/page', '描述你想要的人物'], ['/tools/avatar-studio/page', '完成提醒'],
];
const selected = new Set();
for (const [route, marker] of checks) {
  const files = manifest.pages[route] || [];
  const matched = files.filter(file => file.endsWith('.js') && fs.readFileSync(path.join(root, file), 'utf8').includes(marker));
  if (!matched.length) throw Error('Missing compiled marker: ' + route + ' ' + marker);
  matched.forEach(file => selected.add(file));
}
for (const route of ['/template-studio/page', '/tools/avatar-studio/page']) {
  const css = (manifest.pages[route] || []).filter(file => file.endsWith('.css'));
  if (!css.length) throw Error('Missing route CSS'); css.forEach(file => selected.add(file));
}
const routes = JSON.parse(fs.readFileSync(path.join(root, 'server/app-paths-manifest.json')));
if (!routes['/api/image-studio/batches/route']) throw Error('Missing batch API artifact');
const version = JSON.parse(fs.readFileSync(path.join(app, 'package.json'))).version;
const build = fs.readFileSync(path.join(root, 'BUILD_ID'), 'utf8').trim();
const results = [];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (mode === 'public') {
  for (const pathname of ['/api/release', '/api/config', '/login']) {
    const response = await fetch(`https://sd2.youdooart.com${pathname}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (response.status !== 200 || response.headers.get('x-sd2-origin') !== 'server-42-193') throw Error('Public check failed: ' + pathname);
    if (pathname === '/api/release') { const value = await response.json(); if (value.version !== version || value.channel !== 'production' || value.summary !== '') throw Error('Public version or anonymous summary boundary mismatch'); }
    else await response.arrayBuffer();
    results.push({ pathname, status: response.status, origin: response.headers.get('x-sd2-origin') });
  }
}
for (const file of selected) {
  const expected = fs.readFileSync(path.join(root, file));
  if (mode === 'public') {
    const response = await fetch(`https://sd2.youdooart.com/_next/${file}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200 || hash(bytes) !== hash(expected)) throw Error('Static resource differs from candidate: ' + file);
  }
  results.push({ file, sha256: hash(expected), matchesArtifact: true });
}
console.log(JSON.stringify({ commit, version, build, mode, checks: results, functionalAcceptance: 'not-run; user manual acceptance required' }, null, 2));
