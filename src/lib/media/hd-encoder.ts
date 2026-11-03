import fs from 'node:fs/promises';
import sharp from 'sharp';

export const HD_MAX_PIXELS = 40_000_000;
export const HD_ENCODING_TIMEOUT_SECONDS = 600;
export const HD_VALIDATION_VERSION = 'hd-output-integrity-v2';
export const HD_ENCODER_STRATEGIES = ['hd-webp-q93-e4-v1', 'hd-legacy-e6-v1', 'hd-avif-e4-v1', 'hd-avif-q90-e4-v1'] as const;
export type HdEncoderStrategy = typeof HD_ENCODER_STRATEGIES[number];
export const HD_LEGACY_ENCODER_STRATEGY: HdEncoderStrategy = 'hd-legacy-e6-v1';
export function hdEncoderStrategy(value: unknown = HD_LEGACY_ENCODER_STRATEGY): HdEncoderStrategy {
  if (!HD_ENCODER_STRATEGIES.includes(value as HdEncoderStrategy)) throw new Error('invalid_hd_encoder_strategy');
  return value as HdEncoderStrategy;
}
// Recovery reads both WebP and legacy jobs while keeping the previous A
// default for new originals. Registered jobs retain their frozen strategy.
export function defaultHdEncoderStrategy(): HdEncoderStrategy {
  if (process.env.HD_ENCODER_STRATEGY !== undefined) return hdEncoderStrategy(process.env.HD_ENCODER_STRATEGY);
  if (process.env.NODE_ENV === 'test') return process.env.HD_CANDIDATE_ENCODER_STRATEGY === 'hd-avif-e4-v1'
    ? 'hd-avif-e4-v1' : HD_LEGACY_ENCODER_STRATEGY;
  return 'hd-avif-q90-e4-v1';
}
type HdIntegrityCheck = { expected: unknown; actual: unknown; ok: boolean };
export type HdIntegrity = { version: string; checks: Record<string, HdIntegrityCheck>; failedChecks: string[] };
export type HdEncoderParameters = { format: 'avif' | 'webp'; lossless: boolean; quality?: number; chromaSubsampling?: string; smartSubsample?: boolean; effort: number; orientation: string; bitdepth: number };
export class HdOutputIntegrityError extends Error {
  constructor(readonly integrity: HdIntegrity) { super('output_integrity'); }
}
export function hdEligibility(meta: sharp.Metadata) {
  if (meta.format === 'webp') return 'existing_webp';
  if ((meta.pages || 1) !== 1) return 'multi_frame';
  if (!meta.width || !meta.height || meta.width * meta.height > HD_MAX_PIXELS) return 'pixel_limit';
  if ((meta.depth && meta.depth !== 'uchar') || (meta.bitsPerSample && meta.bitsPerSample > 8)) return 'high_bit_depth';
  if (meta.space !== 'srgb' && meta.space !== 'b-w') return 'wide_gamut';
  if (meta.hasProfile) return 'unverified_color_profile';
  return null;
}
export function hdEncoderOutputFormat(strategy: HdEncoderStrategy | undefined, protectedImage: boolean): 'avif' | 'webp' {
  return protectedImage || hdEncoderStrategy(strategy) === 'hd-webp-q93-e4-v1' ? 'webp' : 'avif';
}
export function hdEncoderParameters(format: 'avif' | 'webp', strategy?: HdEncoderStrategy, protectedImage = false): HdEncoderParameters {
  const selected = hdEncoderStrategy(strategy);
  const lossyWebp = format === 'webp' && selected === 'hd-webp-q93-e4-v1' && !protectedImage;
  return { format, lossless: format === 'webp' && !lossyWebp,
    effort: selected === 'hd-webp-q93-e4-v1' || format === 'avif' && selected !== HD_LEGACY_ENCODER_STRATEGY ? 4 : 6, orientation: 'auto', bitdepth: 8,
    ...(format === 'avif' ? { quality: selected === 'hd-avif-q90-e4-v1' ? 90 : 95, chromaSubsampling: '4:4:4' }
      : lossyWebp ? { quality: 93, smartSubsample: true } : {}) };
}
// Shared with receipt recovery. Encode the frozen full-size recipe while
// retaining the original alpha, colour and output-integrity protections.
export async function encodeHdOutput(input: string, output: string, format: 'avif' | 'webp', strategy?: HdEncoderStrategy, protectedImage = false) {
  const parameters = hdEncoderParameters(format, strategy, protectedImage);
  const image = sharp(input, { limitInputPixels: HD_MAX_PIXELS, failOn: 'warning' }).rotate().timeout({ seconds: HD_ENCODING_TIMEOUT_SECONDS });
  await (format === 'webp' ? parameters.lossless ? image.webp({ lossless: true, effort: parameters.effort })
    : image.webp({ quality: parameters.quality, smartSubsample: parameters.smartSubsample, effort: parameters.effort })
    : image.avif({ quality: parameters.quality, chromaSubsampling: '4:4:4', effort: parameters.effort, bitdepth: 8 })).toFile(output);
  await fs.chmod(output, 0o600);
}
export async function validateHdOutput(inputFile: string, meta: sharp.Metadata, outputFile: string, format: 'avif' | 'webp'): Promise<HdIntegrity> {
  const integrity: HdIntegrity = { version: HD_VALIDATION_VERSION, checks: {}, failedChecks: [] };
  const check = (name: string, expected: unknown, actual: unknown, ok: boolean) => {
    integrity.checks[name] = { expected, actual, ok };
    if (!ok) integrity.failedChecks.push(name);
  };
  let output: sharp.Metadata;
  try {
    output = await sharp(outputFile, { limitInputPixels: HD_MAX_PIXELS, failOn: 'warning' }).metadata();
    check('output_metadata', 'readable', 'readable', true);
  } catch {
    check('output_metadata', 'readable', 'decode_failed', false);
    throw new HdOutputIntegrityError(integrity);
  }
  const rotated = [5, 6, 7, 8].includes(meta.orientation || 1);
  check('width', rotated ? meta.height : meta.width, output.width ?? null, output.width === (rotated ? meta.height : meta.width));
  check('height', rotated ? meta.width : meta.height, output.height ?? null, output.height === (rotated ? meta.width : meta.height));
  let alphaMatches = Boolean(output.hasAlpha) === Boolean(meta.hasAlpha);
  let inputIsOpaque: boolean | null = null;
  if (meta.hasAlpha && !output.hasAlpha && format === 'webp' && output.format === 'webp') {
    try {
      inputIsOpaque = (await sharp(inputFile, { limitInputPixels: HD_MAX_PIXELS, failOn: 'warning' }).timeout({ seconds: 120 }).stats()).isOpaque;
      check('input_opaque_decode', true, inputIsOpaque, inputIsOpaque === true);
      alphaMatches = inputIsOpaque === true;
    } catch { check('input_opaque_decode', true, 'decode_failed', false); }
  }
  check('alpha', { hasAlpha: Boolean(meta.hasAlpha), opaqueOmissionAllowed: format === 'webp' }, { hasAlpha: Boolean(output.hasAlpha), inputIsOpaque }, alphaMatches);
  check('pages', 1, output.pages || 1, (output.pages || 1) === 1);
  check('color', ['srgb', 'b-w'], output.space ?? null, ['srgb', 'b-w'].includes(output.space || ''));
  check('bitdepth', '<=8', output.bitsPerSample || 8, (output.bitsPerSample || 8) <= 8);
  check('depth', 'uchar', output.depth ?? null, output.depth === 'uchar');
  check('format', format === 'avif' ? 'heif' : 'webp', output.format ?? null, output.format === (format === 'avif' ? 'heif' : 'webp'));
  try {
    await sharp(outputFile, { limitInputPixels: HD_MAX_PIXELS, failOn: 'warning' }).timeout({ seconds: 120 }).stats();
    check('output_full_decode', 'complete', 'complete', true);
  } catch { check('output_full_decode', 'complete', 'decode_failed', false); }
  if (integrity.failedChecks.length) throw new HdOutputIntegrityError(integrity);
  return integrity;
}
