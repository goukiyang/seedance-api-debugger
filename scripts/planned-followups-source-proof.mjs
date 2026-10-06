import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [source, target] = process.argv.slice(2);
const files = [];
function visit(relative) {
  const file = path.join(source, relative);
  if (!fs.existsSync(file)) return;
  if (fs.statSync(file).isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(relative, name));
  else {
    if (/\.env|\.(db|sqlite)(?:$|-)/.test(relative)) throw Error('Sensitive/non-source entry in source package');
    files.push(relative);
  }
}
for (const entry of ['src', 'scripts', 'ops', 'prisma/schema.prisma', 'prisma/migrations', 'package.json', 'package-lock.json', 'next.config.js', 'tsconfig.json', 'next-env.d.ts', '.eslintrc.json', 'public/home']) visit(entry);
for (const file of ['index.html', 'style-gallery.js', 'style-gallery.css', 'canvas-styles.js', 'like-button.css', 'like-button.LICENSE.txt']) visit(`public/tools/ultimate-canvas/${file}`);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const different = files.filter(file => !fs.existsSync(path.join(target, file)) || hash(path.join(source, file)) !== hash(path.join(target, file)));
if (different.length) throw Error(`Source differs: ${different.slice(0, 20).join(', ')}`);
console.log(JSON.stringify({ matchedFiles: files.length, version: JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version }));
