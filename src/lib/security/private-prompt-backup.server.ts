import 'server-only';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { PrivatePromptError, privatePromptKey, PRIVATE_PROMPT_READER } from './private-prompts.server';

const MAGIC = Buffer.from('PPBACKUP1\n', 'ascii');
const MAX_BYTES = 8 * 1024 ** 3;
const CHUNK_BYTES = 1024 ** 2;
const MAX_HEADER_BYTES = 16 * 1024;
type BackupProof = {
  inventoryId: string; policyRevision: string; consumerDigest: string; sourceId: string;
  dataFormat: 'legacy-isolated' | 'private-prompt.v1'; bodyKeyIds: string[]; indexKeyIds: string[];
};
type Header = BackupProof & {
  format: 'private-backup.v1'; minimumReader: number; keyId: string; nonce: string; byteLength: number;
};
const fail = (): never => { throw new PrivatePromptError(); };
function validateProof(proof: BackupProof) {
  for (const value of [proof.inventoryId, proof.policyRevision, proof.consumerDigest, proof.sourceId]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,240}$/.test(value)) fail();
  }
  if (!/^[a-f0-9]{64}$/.test(proof.consumerDigest)) fail();
  if (!['legacy-isolated', 'private-prompt.v1'].includes(proof.dataFormat)) fail();
  for (const ids of [proof.bodyKeyIds, proof.indexKeyIds]) {
    if (!Array.isArray(ids) || ids.length > 64 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(id))) fail();
  }
  if (proof.dataFormat === 'private-prompt.v1' && (!proof.bodyKeyIds.length || !proof.indexKeyIds.length)) fail();
}
async function privateDirectory(directory: string) {
  const resolved = path.resolve(directory);
  const stat = await lstat(resolved);
  if (await realpath(resolved) !== resolved || !stat.isDirectory() || (stat.mode & 0o077)
    || stat.uid !== 0 && stat.uid !== process.getuid?.()) fail();
  return resolved;
}
async function readExactly(file: Awaited<ReturnType<typeof open>>, length: number, position: number) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await file.read(buffer, offset, length - offset, position + offset);
    if (!read.bytesRead) fail();
    offset += read.bytesRead;
  }
  return buffer;
}
async function writeAll(file: Awaited<ReturnType<typeof open>>, buffer: Buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = await file.write(buffer, offset, buffer.length - offset);
    if (!written.bytesWritten) fail();
    offset += written.bytesWritten;
  }
}

// No plaintext goes to a consumer or final path before the complete GCM tag is checked.
// A failed run never removes or replaces a previous backup or restore file.
export async function transformPrivateBackup(input: {
  mode: 'seal' | 'restore'; source: string; destination: string; proof: BackupProof;
}) {
  validateProof(input.proof);
  const directory = await privateDirectory(path.dirname(input.destination));
  const destination = path.join(directory, path.basename(input.destination));
  if (input.mode === 'restore') {
    const fixture = process.env.NODE_ENV === 'test' ? process.env.PRIVATE_PROMPTS_FIXTURE_ROOT : undefined;
    const root = path.resolve(fixture || '/data/video-api-debugger/private-restore');
    if (!destination.startsWith(root + path.sep)) fail();
  }
  if (path.resolve(input.source) === destination) fail();
  if (await realpath(input.source) !== path.resolve(input.source)) fail();
  const temporary = path.join(directory, `.private-backup-${randomBytes(24).toString('hex')}`);
  const source = await open(input.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target: Awaited<ReturnType<typeof open>> | undefined;
  let key: Buffer | undefined;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size > MAX_BYTES + MAX_HEADER_BYTES + 64) fail();
    target = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let header: Header, prefix: Buffer, sourceOffset: number;
    if (input.mode === 'seal') {
      if (before.size > MAX_BYTES) fail();
      const material = privatePromptKey('backup');
      key = material.key;
      header = { ...input.proof, format: 'private-backup.v1', minimumReader: PRIVATE_PROMPT_READER,
        keyId: material.keyId, nonce: randomBytes(12).toString('base64url'), byteLength: before.size };
      const encoded = Buffer.from(JSON.stringify(header));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(encoded.length);
      prefix = Buffer.concat([MAGIC, length, encoded]);
      sourceOffset = 0;
    } else {
      const start = await readExactly(source, MAGIC.length + 4, 0);
      if (!start.subarray(0, MAGIC.length).equals(MAGIC)) fail();
      const length = start.readUInt32BE(MAGIC.length);
      if (!length || length > MAX_HEADER_BYTES) fail();
      const encoded = await readExactly(source, length, start.length);
      header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)) as Header;
      if (Object.keys(header).sort().join(',') !== 'bodyKeyIds,byteLength,consumerDigest,dataFormat,format,indexKeyIds,inventoryId,keyId,minimumReader,nonce,policyRevision,sourceId'
        || header.format !== 'private-backup.v1' || header.minimumReader !== PRIVATE_PROMPT_READER
        || !Number.isSafeInteger(header.byteLength) || header.byteLength < 0 || header.byteLength > MAX_BYTES
        || typeof header.nonce !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(header.nonce)
        || typeof header.keyId !== 'string' || !/^[A-Za-z0-9_.:/-]{1,240}$/.test(header.keyId)) fail();
      validateProof(header);
      for (const field of ['inventoryId', 'policyRevision', 'consumerDigest', 'sourceId'] as const) {
        if (header[field] !== input.proof[field]) fail();
      }
      if (header.dataFormat !== input.proof.dataFormat
        || JSON.stringify(header.bodyKeyIds) !== JSON.stringify(input.proof.bodyKeyIds)
        || JSON.stringify(header.indexKeyIds) !== JSON.stringify(input.proof.indexKeyIds)) fail();
      prefix = Buffer.concat([start, encoded]);
      sourceOffset = prefix.length;
      if (before.size !== sourceOffset + header.byteLength + 16) fail();
      key = privatePromptKey('backup', header.keyId).key;
    }
    const nonce = Buffer.from(header.nonce, 'base64url');
    const cipher = input.mode === 'seal'
      ? createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
      : createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(prefix);
    const hash = createHash('sha256');
    if (input.mode === 'seal') await writeAll(target, prefix);
    else if ('setAuthTag' in cipher) cipher.setAuthTag(await readExactly(source, 16, sourceOffset + header.byteLength));
    for (let offset = 0; offset < header.byteLength; offset += CHUNK_BYTES) {
      const chunk = await readExactly(source, Math.min(CHUNK_BYTES, header.byteLength - offset), sourceOffset + offset);
      const output = cipher.update(chunk);
      hash.update(input.mode === 'seal' ? chunk : output);
      try { await writeAll(target, output); }
      finally { chunk.fill(0); output.fill(0); }
    }
    const final = cipher.final();
    if (input.mode === 'restore') hash.update(final);
    try { await writeAll(target, final); }
    finally { final.fill(0); }
    if ('getAuthTag' in cipher) await writeAll(target, cipher.getAuthTag());
    const after = await source.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail();
    await target.sync();
    await target.close();
    target = undefined;
    await link(temporary, destination);
    await unlink(temporary);
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
    return { destination, byteLength: header.byteLength, sha256: hash.digest('hex'), keyId: header.keyId, proof: input.proof };
  } catch { return fail(); }
  finally {
    key?.fill(0);
    await source.close();
    await target?.close();
    await unlink(temporary).catch(() => undefined);
  }
}
