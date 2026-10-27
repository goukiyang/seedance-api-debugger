import './server-runtime.cjs';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const [mode, source, destination, proofFile, ...extra] = process.argv.slice(2);
  if (!['seal', 'restore'].includes(mode) || !source || !destination || !proofFile || extra.length
    || [source, destination, proofFile].some(value => !path.isAbsolute(value))) throw new Error('arguments');
  if (await realpath(proofFile) !== proofFile) throw new Error('proof');
  const file = await open(proofFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let proof: unknown;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077)
      || stat.uid !== 0 && stat.uid !== process.getuid?.()) throw new Error('proof');
    proof = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  const { transformPrivateBackup } = await import('../src/lib/security/private-prompt-backup.server');
  const result = await transformPrivateBackup({ mode: mode as 'seal' | 'restore', source, destination,
    proof: proof as Parameters<typeof transformPrivateBackup>[0]['proof'] });
  // No path, key bytes, prompt content or decrypted payload is written to stdout.
  process.stdout.write(JSON.stringify({ mode, byteLength: result.byteLength, sha256: result.sha256,
    keyId: result.keyId, proof: result.proof }) + '\n');
}

void main().catch(() => {
  process.stderr.write('PRIVATE_BACKUP_FAILED\n');
  process.exitCode = 1;
});
