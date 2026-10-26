import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = '/data/video-api-debugger/controls';
const file = `${root}/raw-upload-recovery-v1.json`;
export const rawUploadStateDigest = (state: string) => createHash('sha256').update(state).digest('hex');

/** Issued only by the protected release after every old raw writer has naturally drained. */
export async function readRawUploadRecoveryProof(key: string, state: string): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    for (const directory of ['/data', '/data/video-api-debugger', root]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022 || await fs.realpath(directory) !== directory) return null;
    }
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022 || stat.size > 4 * 1024 * 1024
        || await fs.realpath(file) !== file || (await fs.lstat(file)).ino !== stat.ino) return null;
      const proof = JSON.parse(await handle.readFile('utf8'));
      if (proof.schema !== 'raw-upload-retired-writer-proof.v1' || proof.oldWritersDrained !== true
        || proof.unidentifiedStagingFiles !== 0 || !/^[a-f0-9]{64}$/.test(proof.drainReceiptSha256 || '')
        || !Array.isArray(proof.entries) || proof.entries.length > 1000) return null;
      const digest = rawUploadStateDigest(state);
      return proof.entries.some((entry: { key: string; stateSha256: string; noAssetOrReceipt: boolean; noPublishedFile: boolean; sameOwnerAsset?: boolean }) =>
        entry.key === key && entry.stateSha256 === digest
        && (entry.noAssetOrReceipt === true && entry.noPublishedFile === true || entry.sameOwnerAsset === true)) ? digest : null;
    } finally { await handle.close(); }
  } catch { return null; }
}
