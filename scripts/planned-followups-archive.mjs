import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

const [commit, output] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(commit || '') || !output?.endsWith('.tar.gz')) throw Error('Invalid archive arguments');
const tracked = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', commit], { encoding: 'utf8' }).trim().split('\n'));
const required = ['src', 'scripts', 'ops', 'prisma', 'package.json', 'package-lock.json', 'next.config.js', 'tsconfig.json', 'next-env.d.ts', '.eslintrc.json', 'public/styles/loading.css',
  ...['index.html', 'style-gallery.js', 'style-gallery.css', 'canvas-styles.js', 'like-button.css', 'like-button.LICENSE.txt'].map(file => `public/tools/ultimate-canvas/${file}`)];
const entries = [...required, ...(tracked.has('public/home/video.png') ? ['public/home'] : [])];
const files = [...tracked].filter(file => entries.some(entry => file === entry || file.startsWith(entry + '/')));
if (files.some(file => /(^|\/)\.env|\.(db|sqlite)(?:$|-)|^(docs|tasks|storage|node_modules)\//.test(file))) throw Error('Non-source entry in archive');
for (const entry of required) if (!files.some(file => file === entry || file.startsWith(entry + '/'))) throw Error(`Missing required build input: ${entry}`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const temporary = output + '.source.tar';
try {
  execFileSync('git', ['archive', '--format=tar', '-o', temporary, commit, ...entries]);
  await pipeline(fs.createReadStream(temporary), createGzip(), fs.createWriteStream(output));
  console.log(JSON.stringify({ commit, sourceFiles: files.length, directPublicImports: ['public/styles/loading.css', 'public/tools/ultimate-canvas/like-button.css'],
    sha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex'), bytes: fs.statSync(output).size, excludes: ['private docs/materials', 'tasks', 'credentials', 'DB', 'runtime uploads', 'dependencies', 'build output'] }));
} finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
