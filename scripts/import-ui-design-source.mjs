import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export const SOURCE_SHA256 = 'ec22430289417474f6a64710bb58f8a261f901493af89ffc6053c3209444561a';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function copyTree(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  execFileSync('/bin/cp', [process.platform === 'darwin' ? '-cR' : '-R', `${source}/.`, destination]);
}
async function files(root, prefix = '') {
  const result = [];
  for (const item of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Private package must not contain symlinks');
    const name = path.posix.join(prefix, item.name);
    if (item.isDirectory()) result.push(...await files(root, name));
    else if (item.isFile()) result.push(name);
  }
  return result.sort();
}
export async function importSource({ zip, overlay, pdfjs, target }) {
  if (sha(await fs.readFile(zip)) !== SOURCE_SHA256) throw new Error('Source archive checksum mismatch');
  const destination = target;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  target = await fs.mkdtemp(path.join(path.dirname(destination), '.package-'));
  const staging = await fs.mkdtemp(path.join(path.dirname(target), '.unpack-'));
  try {
    const extract = `import zipfile,pathlib,sys,stat
root=pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as archive:
 for item in archive.infolist():
  name=item.filename
  if name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts or stat.S_ISLNK(item.external_attr >> 16): raise ValueError('Unsafe archive entry')
  pieces=name.split('/')
  selected=name.startswith('UIUX-ART/structure-library/') or name.startswith(('UIUX-ART/project/assets/','UIUX-ART/project/design-standards/','UIUX-ART/project/tests/')) or len(pieces)==3 and pieces[:2]==['UIUX-ART','project'] and pathlib.PurePosixPath(name).suffix in ['.js','.cjs','.css','.html']
  if selected: archive.extract(item,root)
`;
    execFileSync('python3', ['-c', extract, zip, staging], { maxBuffer: 1024 * 1024 });
    const source = path.join(staging, 'UIUX-ART/project');
    const html = await fs.readFile(path.join(source, 'index.html'), 'utf8');
    const front = [...html.matchAll(/(?:src|href)="\.\/([^"?#]+\.(?:js|css|png|svg))"/g)].map(match => match[1]);
    const rootFiles = (await fs.readdir(source)).filter(name => /\.(?:js|cjs|css|html)$/.test(name) && !/^(?:server|app|feishu|figma-(?:auth|oauth|transport|source)|lovart-(?:source|mcp)|macos|codex-mcp)/.test(name));
    for (const name of rootFiles) await fs.copyFile(path.join(source, name), path.join(target, name));
    for (const folder of ['assets', 'design-standards', 'tests']) await copyTree(path.join(source, folder), path.join(target, folder));
    await copyTree(path.join(staging, 'UIUX-ART/structure-library'), path.join(target, 'library'));
    if (overlay) for (const name of await files(overlay)) {
      await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true });
      await fs.copyFile(path.join(overlay, name), path.join(target, name));
    }
    if (pdfjs) {
      const metadata = JSON.parse(await fs.readFile(path.join(pdfjs, 'package.json'), 'utf8'));
      if (metadata.version !== '5.6.205') throw new Error('Unverified PDF dependency version');
      for (const name of ['package.json', 'LICENSE', 'legacy/build', 'cmaps', 'standard_fonts']) {
        await fs.mkdir(path.dirname(path.join(target, 'node_modules/pdfjs-dist', name)), { recursive: true });
        if ((await fs.stat(path.join(pdfjs, name))).isDirectory()) await copyTree(path.join(pdfjs, name), path.join(target, 'node_modules/pdfjs-dist', name));
        else await fs.copyFile(path.join(pdfjs, name), path.join(target, 'node_modules/pdfjs-dist', name));
      }
    }
    const libc = process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl') : '';
    const nativeDependency = `@napi-rs/canvas-${process.platform}-${process.arch}${libc}`;
    if (pdfjs) {
      const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(pdfjs), '@napi-rs/canvas/package.json'), 'utf8'));
      if (metadata.optionalDependencies?.[nativeDependency] !== '0.1.100') throw new Error('Unsupported canvas runtime platform');
    }
    const dependencyVersions = {};
    if (pdfjs) for (const dependency of ['@napi-rs/canvas', nativeDependency]) {
      const source = path.join(path.dirname(pdfjs), dependency);
      const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
      if (metadata.version !== '0.1.100') throw new Error('Unverified canvas dependency version');
      await fs.mkdir(path.dirname(path.join(target, 'node_modules', dependency)), { recursive: true });
      await copyTree(source, path.join(target, 'node_modules', dependency));
      dependencyVersions[dependency] = { version: metadata.version, license: metadata.license };
    }
    const inventory = {};
    for (const name of (await files(target)).filter(name => name !== 'manifest.json')) inventory[name] = sha(await fs.readFile(path.join(target, name)));
    const catalog = JSON.parse(await fs.readFile(path.join(target, 'library/catalog.json'), 'utf8'));
    const images = Object.keys(inventory).filter(name => /^library\/figma-cache\/assets\//.test(name));
    if (catalog.plans.length !== 7 || catalog.rawFrames !== 191 || catalog.availableFrames !== 181 || catalog.uniqueAssets !== 565 || images.length !== 565) throw new Error('Unexpected library inventory');
    const publicFiles = [...new Set(['index.html', 'sd2-adapter.js', 'sd2.css', ...front, ...Object.keys(inventory).filter(name => /^assets\//.test(name))])].filter(name => name in inventory);
    const manifest = { schema: 1, adapter: 'API02-v1.1', sourceSha256: SOURCE_SHA256, digest: sha(JSON.stringify(inventory)), publicFiles, files: inventory,
      counts: { plans: 7, rawFrames: 191, selectableFrames: 181, images: images.length }, dependencies: { pdfjs: pdfjs ? '5.6.205' : null, websiteScreenshot: false, canvas: dependencyVersions, platform: process.platform, arch: process.arch } };
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
    try { await fs.access(destination); await fs.rename(destination, `${destination}.previous-${Date.now()}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(target, destination);
    return manifest;
  } finally { execFileSync('/bin/rm', ['-rf', '--', staging]); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = Object.fromEntries(process.argv.slice(2).map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }));
  const result = await importSource({ zip: args.zip, overlay: args.overlay, pdfjs: args.pdfjs, target: args.target || path.resolve('.private/ui-design', SOURCE_SHA256) });
  console.log(JSON.stringify({ digest: result.digest, counts: result.counts, dependencies: result.dependencies }));
}

export async function refreshOverlay(target, overlay) {
  const old = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'));
  if (old.sourceSha256 !== SOURCE_SHA256) throw new Error('Unknown base package');
  const changed = new Set(await files(overlay));
  for (const [name, expected] of Object.entries(old.files)) {
    if (!changed.has(name) && sha(await fs.readFile(path.join(target, name))) !== expected) throw new Error(`Unchanged dependency differs: ${name}`);
  }
  for (const name of changed) await fs.copyFile(path.join(overlay, name), path.join(target, name));
  const inventory = {};
  for (const name of (await files(target)).filter(name => name !== 'manifest.json')) inventory[name] = sha(await fs.readFile(path.join(target, name)));
  const manifest = { ...old, files: inventory, digest: sha(JSON.stringify(inventory)) };
  await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
