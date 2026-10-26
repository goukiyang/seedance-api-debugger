// Comparison identity is separate from HD versions, URLs and representation ETags.
export type ComparisonImageDescriptor = {
  schema: 2;
  kind: 'asset' | 'reference_image';
  id: string;
  originalVersion: string | null;
};
export const COMPARISON_VERSION_PARAM = 'comparison-version';
export const COMPARISON_VERSION_HEADER = 'X-Image-Comparison-Version';
export function validComparisonVersion(value: unknown): value is string {
  return typeof value === 'string' && /^cmp2-[a-f0-9]{64}$/.test(value);
}
