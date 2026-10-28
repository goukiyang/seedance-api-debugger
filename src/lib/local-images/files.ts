import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { identifier, LocalImageError, requireThat, sha256 } from './core';

const MAX_BYTES = 30 * 1024 * 1024;
export async function boundedBody(request: Request, limit = 65536) {
  const reader = request.body?.getReader(); requireThat(reader, 'EMPTY_BODY');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      requireThat(bytes <= limit, 'BODY_TOO_LARGE', 413); chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function receiveOutput(request: Request, root: string, attemptId: string, expectedHash: string, expectedBytes: number) {
  identifier(attemptId);
  requireThat(request.headers.get('content-type') === 'image/png' && /^[a-f0-9]{64}$/.test(expectedHash)
    && Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && expectedBytes <= MAX_BYTES, 'UPLOAD_HEADERS_INVALID', 422);
  const raw = await boundedBody(request, MAX_BYTES);
  requireThat(raw.length === expectedBytes && sha256(raw) === expectedHash, 'UPLOAD_DIGEST_MISMATCH', 422);
  // Re-encode through the website's existing sharp dependency: full decode, metadata removed.
  let delivered: Buffer; let width: number; let height: number;
  try {
    const image = sharp(raw, { limitInputPixels: 4194304, failOn: 'warning' });
    const metadata = await image.metadata();
    requireThat(metadata.format === 'png' && (!metadata.pages || metadata.pages === 1), 'PNG_REQUIRED', 422);
    const result = await image.png().toBuffer({ resolveWithObject: true });
    delivered = result.data; width = result.info.width; height = result.info.height;
  } catch { throw new LocalImageError('IMAGE_DECODE_FAILED', 422); }
  requireThat(delivered.length <= MAX_BYTES, 'OUTPUT_TOO_LARGE', 413);
  const digest = sha256(delivered);
  const relative = `${attemptId}/${digest}.png`;
  const folder = path.join(root, attemptId); await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const target = path.join(root, relative); const temporary = path.join(folder, randomUUID() + '.tmp');
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(delivered); await handle.sync(); } finally { await handle.close(); }
  try { await fs.link(temporary, target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    requireThat(sha256(await fs.readFile(target)) === digest, 'IMMUTABLE_FILE_CONFLICT', 409);
  } finally { await fs.unlink(temporary); }
  if (process.platform !== 'win32') {
    const dir = await fs.open(folder, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  return { rawSha256: expectedHash, deliveredSha256: digest, path: relative, rawBytes: raw.length, bytes: delivered.length, width, height };
}
export async function readOutput(root: string, relative: string, digest: string) {
  requireThat(/^[a-zA-Z0-9_-]+\/[a-f0-9]{64}\.png$/.test(relative), 'OUTPUT_PATH_INVALID', 500);
  const full = path.join(root, relative);
  const realRoot = await fs.realpath(root); const realFile = await fs.realpath(full);
  requireThat(realFile.startsWith(realRoot + path.sep), 'OUTPUT_PATH_INVALID', 500);
  const bytes = await fs.readFile(full);
  requireThat(sha256(bytes) === digest, 'OUTPUT_INTEGRITY_FAILURE', 503); return bytes;
}
