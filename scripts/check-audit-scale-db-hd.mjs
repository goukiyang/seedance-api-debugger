import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : []);
const constructors = files(path.join(root, 'src')).filter(file => /new PrismaClient\s*\(/.test(fs.readFileSync(file, 'utf8')));
assert.deepEqual(constructors.map(file => path.relative(root, file)), ['src/lib/database/client.ts']);
const scheduler = read('src/lib/media/hd-scheduler.ts');
assert.doesNotMatch(scheduler, /hdReadonlyDb|for \(const (?:asset|reference) of/);
assert.match(scheduler, /job\.ownerEvidence/);
const owner = read('src/lib/media/hd-owner.ts');
assert.doesNotMatch(owner, /endsWith|readdir|hdSource\(/);
assert.match(owner, /hdReadRepository\.assetsAtUrls/);
assert.match(read('src/lib/database/readonly-hd.ts'), /LIMIT 2/);
assert.match(read('src/lib/media/hd-derivatives.ts'), /database: databaseObservations\(\)/);
for (const [model, field] of [['Asset', 'original_url'], ['ReferenceImage', 'url']]) {
  const block = read('prisma/schema.prisma').split(`model ${model} {`)[1].split('\n}')[0];
  assert.ok(block.includes(`@@index([${field}])`), `${model}.${field} index missing`);
}
console.log('audit scale static contracts passed (not server/runtime acceptance)');
