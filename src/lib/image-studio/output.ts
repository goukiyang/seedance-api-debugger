import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Prisma } from '@prisma/client';
import { StudioImageDeliveryError } from './media';

async function publishFile(file: string, bytes: Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, file);
    const folder = await fs.open(path.dirname(file), 'r');
    try { await folder.sync(); } finally { await folder.close(); }
    const saved = await fs.readFile(file);
    if (!saved.equals(bytes)) throw new Error('Published image mismatch');
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

// Prepare complete files using the existing asset paths. The asset row and settlement
// are committed together by finishStudioTask, never by an independent upload transaction.
export async function prepareStudioOutput(bytes: Buffer, task: { id: string; owner_id: string },
  validation: { width: number; height: number }, assertLease: () => Promise<void>): Promise<Prisma.AssetUncheckedCreateInput> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const thumb = await sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 })
    .timeout({ seconds: 45 }).resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  if (!thumb.length) throw new StudioImageDeliveryError('generated_thumbnail_failed', bytes.length);
  const thumbHash = createHash('sha256').update(thumb).digest('hex');
  const originalUrl = `/uploads/assets/${hash}.png`;
  const thumbnailUrl = `/uploads/thumbs/${thumbHash}_thumb.webp`;
  await assertLease();
  await publishFile(path.join(process.cwd(), 'public', originalUrl), bytes);
  await assertLease();
  await publishFile(path.join(process.cwd(), 'public', thumbnailUrl), thumb);
  await assertLease();
  return { id: `studio-${task.id}`, owner_id: task.owner_id, type: 'image', hash,
    original_url: originalUrl, thumbnail_url: thumbnailUrl, file_name: `image-${task.id}.png`, mime_type: 'image/png',
    width: validation.width, height: validation.height, file_size: bytes.length, status: 'active',
    metadata_json: JSON.stringify({ studioTaskId: task.id, validation }) };
}
