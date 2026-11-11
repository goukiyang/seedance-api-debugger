import type { ReferenceImageInput } from './types';
import { parseReferenceImageInputs } from './inputs';

export const referenceInputKey = (input: ReferenceImageInput) => input.kind === 'site_image'
  ? `site:${input.referenceImageId}` : `character:${input.characterAssetId}`;

/** Optional legacy drafts stay readable; malformed new choices require an explicit reset. */
export function readClientReferenceInputs(value: unknown): ReferenceImageInput[] | undefined {
  try {
    if (Array.isArray(value) && value.length > 80) throw new Error('too many references');
    return parseReferenceImageInputs(value);
  } catch { throw new Error('原角色引用无法读取，提示词已保留。请清除失效引用后重新选择。'); }
}

/** Only explicit @ markers can be rebound without guessing what prose means. */
export function rebindReferenceMarkers(prompt: string, before: ReferenceImageInput[], after: ReferenceImageInput[]) {
  const nextIndices = new Map(after.map((item, index) => [referenceInputKey(item), index + 1]));
  if (!before.some((item, index) => nextIndices.get(referenceInputKey(item)) !== index + 1)) return { prompt, issue: null };
  const ambiguous = /(?<!@)(?:图片|图)\s*\d+/.test(prompt);
  return { prompt: prompt.replace(/@图片(\d+)(?!\d)/g, (marker, number) => {
    const source = before[Number(number) - 1];
    if (!source) return marker;
    const index = nextIndices.get(referenceInputKey(source));
    return index ? `@图片${index}` : '';
  }), issue: ambiguous ? '素材顺序已变化，提示词中的文字图号未改动。请核对并修改对应图号后再生成。' : null };
}
