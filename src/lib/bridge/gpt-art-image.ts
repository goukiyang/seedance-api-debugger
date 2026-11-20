import { createHash } from 'node:crypto';
import sharp from 'sharp';

export type ArtPicture = { mime: string; data: string };

// Decode the actual bitmap, rather than accepting a MIME label or PNG header.
// The fingerprint follows decoded pixels, so renaming/re-encoding the same PNG
// cannot turn the original or a previous version into a new revision.
export async function artImageFingerprints(images: ArtPicture[]): Promise<string[]> {
  const result: string[] = [];
  for (const image of images) {
    const bytes = Buffer.from(image.data, 'base64');
    const { data, info } = await sharp(bytes, { limitInputPixels: 16_000_000, animated: false, failOn: 'warning' })
      .rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width < 96 || info.height < 96 || !data.length) throw Error('改图尺寸过小，无法核对画面');
    result.push(createHash('sha256').update(JSON.stringify([info.width, info.height, info.channels])).update(data).digest('hex'));
  }
  return result;
}
