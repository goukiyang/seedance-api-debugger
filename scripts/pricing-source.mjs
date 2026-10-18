import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function pricingSourceHashes(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (['node_modules', '.git', '.role-tests', '__pycache__'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (['public/uploads', 'public/videos'].includes(file)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Candidate source symlink is not accepted: ${file}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  for (const directory of ['src', 'scripts', 'prisma', 'public']) walk(directory);
  files.push('package.json', 'package-lock.json', 'tsconfig.json', 'next.config.js', 'ops/feishu-credit-gateway.mjs');
  return Object.fromEntries(Array.from(new Set(files)).sort().map(file => [file,
    createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]));
}
export function pricingSourceTreeHash(hashes) {
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}
