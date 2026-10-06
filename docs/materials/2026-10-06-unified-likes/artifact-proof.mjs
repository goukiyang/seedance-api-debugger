import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [root, dist, commit] = process.argv.slice(2);
if (!root || !dist || !/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Invalid arguments');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
if (version !== '0.49.0') throw Error('Unexpected version');
const manifest = JSON.parse(fs.readFileSync(path.join(root, dist, 'app-build-manifest.json')));
const pageFiles = new Set([...manifest.pages['/assets/page'], ...manifest.pages['/template-studio/page']]);
const text = file => fs.readFileSync(path.join(root, dist, file), 'utf8');
const jsFiles = [...pageFiles].filter(file => file.endsWith('.js'));
const reactionChunk = jsFiles.find(file => text(file).includes('公开喜欢人数'));
const assetsChunk = jsFiles.find(file => text(file).includes('最近喜欢'));
if (!reactionChunk || !assetsChunk || !jsFiles.some(file => text(file).includes('我的喜欢'))) throw Error('Unified likes missing in compiled client');
const cssFiles = [...pageFiles].filter(file => file.endsWith('.css'));
const likeCss = cssFiles.find(file => text(file).includes('lk-bloom') && text(file).includes('prefers-reduced-motion'));
if (!likeCss) throw Error('Bloom CSS missing from manifest');
const assets = [reactionChunk, assetsChunk, likeCss].filter((file, index, all) => all.indexOf(file) === index).map(file => ({
  url: `/_next/${file}`, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, dist, file))).digest('hex'),
}));
console.log(JSON.stringify({ version, commit, build: fs.readFileSync(path.join(root, dist, 'BUILD_ID'), 'utf8').trim(), assets,
  acceptance: 'Compiled static artifacts only; not functional or visual acceptance' }, null, 2));
