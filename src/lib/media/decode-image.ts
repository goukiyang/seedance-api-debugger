import { open } from 'node:fs/promises';
import sharp from './sharp';
import type { Create, Raw, Sharp, OverlayOptions } from 'sharp';
import { HD_MAX_PIXELS, MULTIVIEW_OUTPUT_MAX_PIXELS, ORDINARY_IMAGE_MAX_PIXELS } from './image-limits';

export type ImagePurpose = 'ordinary' | 'hd' | 'multiview-output' | 'video-frame';
export const imageDecoderVersions = sharp.versions;
export const imageResizeKernel = sharp.kernel;
const limits: Record<ImagePurpose, number> = { ordinary: ORDINARY_IMAGE_MAX_PIXELS, hd: HD_MAX_PIXELS,
  'multiview-output': MULTIVIEW_OUTPUT_MAX_PIXELS, 'video-frame': 16_777_216 };
export class UntrustedImageError extends Error {
  constructor(public readonly code: 'IMAGE_FORMAT_NOT_ALLOWED' | 'IMAGE_PIXEL_LIMIT' | 'IMAGE_HEADER_INVALID') { super(code); }
}
function dimensions(width: number, height: number, purpose: ImagePurpose) {
  if (!Object.hasOwn(limits, purpose)) throw new UntrustedImageError('IMAGE_HEADER_INVALID');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new UntrustedImageError('IMAGE_HEADER_INVALID');
  if (width * height > limits[purpose]) throw new UntrustedImageError('IMAGE_PIXEL_LIMIT');
}
export async function inspectUntrustedImageHeader(source: string | Buffer, purpose: ImagePurpose = 'ordinary') {
  if (!Object.hasOwn(limits, purpose)) throw new UntrustedImageError('IMAGE_HEADER_INVALID');
  let header: Buffer;
  if (typeof source === 'string') {
    const file = await open(source, 'r');
    try { const bytes = Buffer.alloc(65536); const result = await file.read(bytes, 0, bytes.length, 0); header = bytes.subarray(0, result.bytesRead); }
    finally { await file.close(); }
  } else header = source.subarray(0, 65536);
  const text = (start: number, end: number) => header.toString('latin1', start, end);
  let format: string | undefined, width: number | undefined, height: number | undefined;
  if (header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && text(12,16) === 'IHDR') {
    format = 'png'; width = header.readUInt32BE(16); height = header.readUInt32BE(20);
  } else if (header.length >= 10 && ['GIF87a','GIF89a'].includes(text(0,6))) {
    format = 'gif'; width = header.readUInt16LE(6); height = header.readUInt16LE(8);
  } else if (header.length >= 26 && text(0,2) === 'BM') {
    format = 'bmp'; const dib = header.readUInt32LE(14);
    if (dib === 12) { width = header.readUInt16LE(18); height = header.readUInt16LE(20); }
    else if (header.length >= 30 && dib >= 40) { width = header.readInt32LE(18); height = Math.abs(header.readInt32LE(22)); }
    else throw new UntrustedImageError('IMAGE_HEADER_INVALID');
  } else if (header.length >= 16 && text(0,4) === 'RIFF' && text(8,12) === 'WEBP') {
    format = 'webp';
    if (text(12,16) === 'VP8X' && header.length >= 30) { width = 1 + header.readUIntLE(24,3); height = 1 + header.readUIntLE(27,3); }
    else if (text(12,16) === 'VP8L' && header.length >= 25 && header[20] === 0x2f) {
      const packed = header.readUInt32LE(21); width = (packed & 0x3fff) + 1; height = ((packed >>> 14) & 0x3fff) + 1;
    } else if (text(12,16) === 'VP8 ' && header.length >= 30 && header.subarray(23,26).equals(Buffer.from([0x9d,1,0x2a]))) {
      width = header.readUInt16LE(26) & 0x3fff; height = header.readUInt16LE(28) & 0x3fff;
    }
  } else if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    format = 'jpeg';
    for (let at = 2; at + 9 <= header.length;) {
      if (header[at] !== 0xff) break;
      const marker = header[at+1]; if (marker === 0xff) { at++; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      const size = header.readUInt16BE(at+2); if (size < 2) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        height = header.readUInt16BE(at+5); width = header.readUInt16BE(at+7); break;
      }
      at += size + 2;
    }
  } else if (header.length >= 16 && text(4,8) === 'ftyp') {
    const size = header.readUInt32BE(0);
    if (size >= 16 && size <= header.length) {
      const brands = [text(8,12)]; for (let at = 16; at + 4 <= size; at += 4) brands.push(text(at,at+4));
      if (brands.some(value => ['avif','avis','heic','heix','hevc','hevx','mif1','msf1'].includes(value))) format = 'heif';
    }
  }
  if (!format) throw new UntrustedImageError('IMAGE_FORMAT_NOT_ALLOWED');
  if (width !== undefined && height !== undefined) dimensions(width, height, purpose);
  return { format, width, height };
}

export async function openUntrustedImage(source: string | Buffer, purpose: ImagePurpose = 'ordinary', options: { animated?: boolean } = {}) {
  await inspectUntrustedImageHeader(source, purpose);
  return sharp(source, { animated: options.animated ?? false, limitInputPixels: limits[purpose], failOn: 'warning' })
    .timeout({ seconds: purpose === 'hd' ? 120 : purpose === 'multiview-output' ? 60 : 45 });
}

// Only internal blank canvases and raw pixels produced by our checked decoder use these constructors.
export function createTrustedImageCanvas(create: Create, purpose: ImagePurpose = 'ordinary') {
  dimensions(create.width, create.height, purpose);
  return sharp({ create }).timeout({ seconds: 60 });
}
export async function compositeCheckedImageTiles(image: Sharp, tiles: OverlayOptions[], purpose: ImagePurpose = 'ordinary') {
  for (const tile of tiles) {
    if (!(typeof tile.input === 'string' || Buffer.isBuffer(tile.input))) throw new UntrustedImageError('IMAGE_FORMAT_NOT_ALLOWED');
    await inspectUntrustedImageHeader(tile.input, purpose);
  }
  return image.composite(tiles.map(tile => ({ ...tile, limitInputPixels: limits[purpose], failOn: 'warning' })));
}
export function openTrustedRawImage(data: Buffer, raw: Raw, purpose: ImagePurpose = 'ordinary') {
  dimensions(raw.width, raw.height, purpose);
  if (!Number.isInteger(raw.channels) || raw.channels < 1 || raw.channels > 4 || data.byteLength !== raw.width * raw.height * raw.channels) throw new UntrustedImageError('IMAGE_HEADER_INVALID');
  return sharp(data, { raw, limitInputPixels: limits[purpose], failOn: 'warning' }).timeout({ seconds: 45 });
}
