import './server-runtime.cjs';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);
async function main() {
  const [proofPath, mode = 'database', ...extra] = process.argv.slice(2);
  const source = process.env.DB_PATH || '/var/lib/video-api-debugger/dev.db';
  const root = process.env.PRIVATE_BACKUP_ROOT || '/data/video-api-debugger/backups/private';
  if (!proofPath || !['database', 'multiview'].includes(mode) || extra.length || [source, root, proofPath].some(value => !path.isAbsolute(value) || /[\r\n\0]/.test(value))) throw new Error();
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root || await realpath(proofPath) !== proofPath) throw new Error();
  const database = await realpath(source);
  const dir = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await dir.stat();
    if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== 0 && stat.uid !== process.getuid?.()) throw new Error();
  } finally { await dir.close(); }
  const proofFile = await open(proofPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let proof: Parameters<typeof import('../src/lib/security/private-prompt-backup.server').transformPrivateBackup>[0]['proof'];
  try {
    const stat = await proofFile.stat();
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) || stat.uid !== 0 && stat.uid !== process.getuid?.()) throw new Error();
    proof = JSON.parse(await proofFile.readFile('utf8'));
  } finally { await proofFile.close(); }
  // A stale lock is intentionally not cleared automatically. No backup or retention job can race this one.
  const lock = path.join(root, '.backup-lock');
  await mkdir(lock, { mode: 0o700 });
  let staging: string | undefined;
  try {
    staging = await mkdtemp(path.join(root, '.stage-'));
    const compressed = path.join(staging, mode === 'multiview' ? 'bundle.tar.gz' : 'database.sqlite3.gz');
    if (mode === 'multiview') {
      const fixture = process.env.NODE_ENV === 'test' ? process.env.PRIVATE_PROMPTS_FIXTURE_ROOT : undefined;
      const media = fixture ? path.join(fixture, 'backup-media') : '/data/video-api-debugger/var-lib';
      if (fixture && (!database.startsWith(path.resolve(fixture) + path.sep) || !root.startsWith(path.resolve(fixture) + path.sep))) throw new Error();
      if (!fixture && (root !== '/data/video-api-debugger/backups/private' || database !== '/data/video-api-debugger/var-lib/dev.db')) throw new Error();
      await exec('python3', [path.join(process.cwd(), 'scripts/backup-multiview-works.py'),
        '--database', database, '--source-root', path.join(media, 'storage/multiview-works'),
        '--recipe-root', path.join(media, 'storage/multiview-recipes'), '--private-source-root', path.join(media, 'storage/multiview-sources'),
        '--foreground-root', path.join(media, 'storage/multiview-reference-foregrounds'),
        '--uploads-root', path.join(media, 'uploads'), '--destination', path.join(staging, 'bundle'),
        fixture ? '--non-production' : '--sealed-staging'], { timeout: 90 * 60 * 1000, maxBuffer: 16384 });
      await exec('tar', ['-C', path.join(staging, 'bundle'), '-czf', compressed, '.'], { timeout: 15 * 60 * 1000, maxBuffer: 16384 });
    } else {
      const snapshot = path.join(staging, 'database.sqlite3');
      await exec('sqlite3', [database, `.backup '${snapshot.replace(/'/g, "''")}'`], { timeout: 300000, maxBuffer: 16384 });
      const { stdout } = await exec('sqlite3', [snapshot, 'PRAGMA integrity_check;'], { timeout: 300000, maxBuffer: 16384 });
      if (stdout.trim() !== 'ok') throw new Error();
      await pipeline(createReadStream(snapshot), createGzip(), createWriteStream(compressed, { flags: 'wx', mode: 0o600 }));
    }
    const { transformPrivateBackup } = await import('../src/lib/security/private-prompt-backup.server');
    const destination = path.join(root, `database-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.ppbackup`);
    const receipt = await transformPrivateBackup({ mode: 'seal', source: compressed, destination, proof });
    // The authenticated header carries recovery metadata. Existing archives are never removed here.
    process.stdout.write(JSON.stringify({ state: 'sealed', integrity: 'ok', byteLength: receipt.byteLength,
      sha256: receipt.sha256, keyId: receipt.keyId }) + '\n');
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
void main().catch(() => { process.stderr.write('PRIVATE_BACKUP_JOB_FAILED\n'); process.exitCode = 1; });
