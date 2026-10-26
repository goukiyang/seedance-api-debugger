import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [root, dist, commit] = process.argv.slice(2);
if (!root || !dist || !/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Invalid artifact arguments');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
if (version !== '0.51.0') throw Error('Unexpected candidate version');
const buildRoot = path.resolve(root, dist);
const manifest = JSON.parse(fs.readFileSync(path.join(buildRoot, 'app-build-manifest.json')));
const files = [...new Set(['/page', '/assets/page', '/cutout/page', '/template-studio/page', '/tools/avatar-studio/page'].flatMap(route => {
  if (!manifest.pages[route]) throw Error(`Missing route ${route}`);
  return manifest.pages[route];
}))].filter(file => /\.(js|css)$/.test(file));
const text = file => fs.readFileSync(path.join(buildRoot, file), 'utf8');
const markers = ['data-image-preview-pane', 'data-image-preview-preload', '还原两图', '粘贴并替换全文', '当前账户尚未绑定抠图授权', '确认生成', '本批资产', '公开喜欢人数', 'data-result-pages', 'data-page-capacity', '下一页图片', 'data-avatar-results', 'data-avatar-composer', '添加人物参考图', '整图参考', 'glyph-', 'burst-'];
const selected = new Set();
for (const marker of markers) {
  const file = files.find(file => file.endsWith('.js') && text(file).includes(marker));
  if (!file) throw Error(`Compiled marker missing: ${marker}`);
  selected.add(file);
}
const comparisonCss = files.find(file => file.endsWith('.css') && text(file).includes('comparePane'));
if (!comparisonCss) throw Error('Compiled comparison CSS missing');
selected.add(comparisonCss);
const stickyCss = files.find(file => file.endsWith('.css') && /body:has\([^)]*templateWorkbench[^)]*\)\{[^}]*overflow-x:clip/.test(text(file)));
if (!stickyCss) throw Error('Compiled workbench-only body clip missing');
selected.add(stickyCss);
const avatarCss = files.find(file => file.endsWith('.css') && text(file).includes('candidateLabel') && text(file).includes('mainColumn'));
if (!avatarCss) throw Error('Compiled avatar layout missing');
selected.add(avatarCss);
const likeCss = files.find(file => file.endsWith('.css') && text(file).includes('inset:4.4px') && text(file).includes('lk-glyph'));
if (!likeCss) throw Error('Compiled compact Like background missing');
selected.add(likeCss);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const assets = [...selected].map(file => ({ url: `/_next/${file}`, sha256: hash(path.join(buildRoot, file)) }));
for (const name of ['video', 'canvas', 'templates', 'avatar', 'cutout']) assets.push({ url: `/home/${name}.png`, sha256: hash(path.join(root, 'public', 'home', name + '.png')) });
for (const file of ['like-button.css', 'style-gallery.js']) assets.push({ url: `/tools/ultimate-canvas/${file}`, sha256: hash(path.join(root, 'public', 'tools', 'ultimate-canvas', file)) });
console.log(JSON.stringify({ version, commit, build: fs.readFileSync(path.join(buildRoot, 'BUILD_ID'), 'utf8').trim(), markers, assets,
  homeMedia: 'Original virtual illustrations, not real output samples or product screenshots',
  acceptance: 'Release-required compiled/static provenance only; LIKE21/AVUI21 functional acceptance remains manual' }, null, 2));
