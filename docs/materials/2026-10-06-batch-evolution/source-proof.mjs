import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [base, app] = process.argv.slice(2);
const skip = name => name.startsWith('.env') || /\.(db|sqlite|sqlite3)(-|$)/.test(name);
function files(root, dir) { return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
  const name = path.join(dir, entry.name); if (skip(entry.name)) return [];
  return entry.isDirectory() ? files(root, name) : entry.isFile() ? [name] : [];
}); }
const fixed = ['package.json', 'package-lock.json', 'next.config.js', 'tsconfig.json', '.eslintrc.json', 'public/styles/loading.css', 'ops/feishu-credit-gateway.mjs'];
const expected = ['src', 'scripts', 'prisma'].flatMap(dir => files(base, dir)).concat(fixed);
const current = ['src', 'scripts', 'prisma'].flatMap(dir => files(app, dir));
const hash = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const drift = expected.filter(file => hash(path.join(base, file)) !== hash(path.join(app, file))).concat(current.filter(file => !expected.includes(file)));
if (drift.length) throw Error('Live source drift; refuse overwrite: ' + JSON.stringify(drift));
console.log(JSON.stringify({ sourceMatchesExpectedArchive: true, checkedFiles: expected.length }));
