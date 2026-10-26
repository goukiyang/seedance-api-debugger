import { opendir, lstat, unlink } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/prisma';
import { multiviewSourceRoot } from './multiview-source.server';

let directory: Dir | null = null, nextScan = 0;
/** Only abandoned immutable-attempt files are eligible. A DB read transaction
 * fences publication while checking references and unlinking the same inode. */
export async function cleanAbandonedMultiviewSources() {
  if (Date.now() < nextScan) return;
  nextScan = Date.now() + 60000;
  const root = await multiviewSourceRoot();
  directory ||= await opendir(root);
  try {
    for (let count = 0; count < 256; count++) {
      const entry = await directory.read();
      if (!entry) { await directory.close(); directory = null; break; }
      if (!entry.isFile() || !/^[a-f0-9]{64}\.mp4(?:\.[a-f0-9-]{36}\.tmp)?$/.test(entry.name)) continue;
      const file = path.join(root, entry.name);
      const before = await lstat(file).catch(() => null);
      if (!before?.isFile() || before.isSymbolicLink() || before.mtimeMs > Date.now() - 86400000) continue;
      await prisma.$transaction(async db => {
        if (await db.multiviewSource.findFirst({ where: { file_path: entry.name }, select: { id: true } })) return;
        if (await db.multiviewShareMutation.findFirst({ where: { state: 'preparing', lease_until: { gt: new Date() } }, select: { id: true } })) return;
        const after = await lstat(file).catch(() => null);
        if (after?.isFile() && after.ino === before.ino && after.dev === before.dev && after.mtimeMs === before.mtimeMs) await unlink(file);
      });
    }
  } catch (error) {
    await directory?.close().catch(() => {}); directory = null;
    throw error;
  }
}
