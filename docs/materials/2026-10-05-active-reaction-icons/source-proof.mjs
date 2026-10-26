import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const [mode, root, other, commit, output] = process.argv.slice(2);
const cssPath = 'src/components/content-reactions/reactions.module.css';
const componentPath = 'src/components/content-reactions/ContentReactions.tsx';
const allowed = [cssPath, componentPath, 'package.json', 'src/lib/release.ts'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = (directory, file) => fs.readFileSync(path.join(directory, file));
function files(directory, relative) {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const file = path.join(relative, entry.name);
    if (entry.name.startsWith('.env') || /\.(db|sqlite|sqlite3)(-|$)/.test(entry.name)) return [];
    return entry.isDirectory() ? files(directory, file) : entry.isFile() ? [file] : [];
  });
}
function sourceFiles(directory) {
  return ['src', 'scripts', 'prisma'].flatMap(relative => files(directory, relative)).concat(['package.json', 'package-lock.json', 'next.config.js', 'tsconfig.json', '.eslintrc.json']);
}
function compare(base, next) {
  const names = [...new Set([...sourceFiles(base), ...sourceFiles(next)])];
  const hash = (directory, file) => fs.existsSync(path.join(directory, file)) ? sha(read(directory, file)) : null;
  return { checkedFiles: names.length, changed: names.filter(file => hash(base, file) !== hash(next, file)) };
}
function source(directory) {
  const css = read(directory, cssPath).toString(), component = read(directory, componentPath).toString();
  if (!css.includes('button[data-reaction-action][aria-pressed="true"]') || !css.includes('.controls.overlayControls button { opacity: 0; pointer-events: none; }')) throw Error('Missing scoped persistent icon CSS');
  for (const action of ['like', 'favorite']) if (!component.includes(`data-reaction-action="${action}"`)) throw Error('Missing real reaction marker: ' + action);
  const version = JSON.parse(read(directory, 'package.json')).version;
  if (version !== '0.43.4') throw Error('Wrong source version');
  return { version, hashes: Object.fromEntries(allowed.map(file => [file, sha(read(directory, file))])), evidenceLimit: 'Source integrity, not DOM, visual or behavior acceptance' };
}
function candidate(directory, dist) {
  const build = path.join(directory, dist), require = createRequire(path.join(directory, 'package.json'));
  const postcss = require('postcss');
  const routes = JSON.parse(read(build, 'server/app-paths-manifest.json'));
  const selected = new Map();
  for (const route of ['/assets/page', '/template-studio/page']) {
    if (!routes[route]) throw Error('Missing target route: ' + route);
    const context = {};
    vm.runInNewContext(read(build, `server/app${route.replace('/page', '/page_client-reference-manifest.js')}`).toString(), context);
    const manifest = context.__RSC_MANIFEST[route];
    const cssFiles = [...new Set(Object.values(manifest.entryCSSFiles).flat())];
    let found = false;
    for (const file of cssFiles) {
      const bytes = read(build, file), text = bytes.toString();
      if (!text.includes('data-reaction-action')) continue;
      const ast = postcss.parse(text), selectors = [];
      ast.walkRules(rule => { if (rule.selector.includes('data-reaction-action')) selectors.push({ selector: rule.selector, declarations: Object.fromEntries(rule.nodes.filter(n => n.type === 'decl').map(n => [n.prop, n.value])) }); });
      if (!selectors.some(rule => rule.selector.includes(':has(') && rule.declarations.opacity === '1') || !selectors.some(rule => !rule.selector.includes(':has(') && !rule.selector.includes(':disabled') && rule.declarations['pointer-events'] === 'auto')) throw Error('Compiled CSS missing persistent parent/button rules');
      selected.set(file, { file, sha256: sha(bytes), bytes: bytes.length, selectors, routes: [...new Set([...(selected.get(file)?.routes || []), route])] });
      found = true;
    }
    if (!found) throw Error('Target route lacks current reaction CSS: ' + route);
  }
  return { ...source(directory), buildId: read(build, 'BUILD_ID').toString().trim(), css: [...selected.values()] };
}
let proof;
if (mode === 'compare' || mode === 'boundary') {
  proof = compare(root, other);
  if (mode === 'compare' && proof.changed.length) throw Error('Source drift: ' + JSON.stringify(proof.changed));
  if (mode === 'boundary' && (proof.changed.length !== allowed.length || proof.changed.some(file => !allowed.includes(file)))) throw Error('Unexpected application write set: ' + JSON.stringify(proof.changed));
} else if (mode === 'source') proof = source(root);
else if (mode === 'candidate') proof = candidate(root, '.next-prod-candidate');
else if (mode === 'public') {
  proof = candidate(root, '.next-prod');
  proof.checks = [];
  for (const pathname of ['/api/release', '/api/config', '/api/health', '/login']) {
    const response = await fetch(`https://sd2.youdooart.com${pathname}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (response.status !== 200 || response.headers.get('x-sd2-origin') !== 'server-42-193') throw Error('Public check failed: ' + pathname);
    if (pathname === '/api/release') {
      const release = await response.json();
      if (release.version !== '0.43.4' || release.channel !== 'production' || release.summary !== '') throw Error('Release or anonymous-summary boundary mismatch');
    } else if (pathname === '/api/health') { if (!(await response.json()).ok) throw Error('Health check failed'); }
    else await response.arrayBuffer();
    proof.checks.push({ pathname, status: response.status, origin: response.headers.get('x-sd2-origin') });
  }
  for (const entry of proof.css) {
    const response = await fetch(`https://sd2.youdooart.com/_next/${entry.file}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const hash = sha(Buffer.from(await response.arrayBuffer()));
    if (response.status !== 200 || hash !== entry.sha256) throw Error('Public CSS differs from candidate: ' + entry.file);
    proof.checks.push({ file: entry.file, status: response.status, sha256: hash, matchesCandidate: true });
  }
} else throw Error('Unknown proof mode');
proof = { ...proof, commit, checkedAt: new Date().toISOString() };
if (output) fs.writeFileSync(output, JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof));
