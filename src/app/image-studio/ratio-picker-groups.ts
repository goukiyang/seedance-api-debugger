import { normalizeStudioRatio } from '../../lib/image-studio/ratios';

export type RatioPickerRow = { label: string; ratio: string; removable: boolean };
export type RatioPickerGroup = { id: string; title: string | null; rows: RatioPickerRow[] };

// Display order only. Selection, normalization and provider contracts stay unchanged.
export const RATIO_PICKER_PRESET_GROUPS = [
  { id: 'common', title: '常用', ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'] },
  { id: 'landscape', title: '其他横向', ratios: ['5:4', '3:2', '2:1', '21:9', '3:1', '4:1'] },
  { id: 'portrait', title: '其他竖向', ratios: ['4:5', '2:3', '1:2', '9:21', '1:3'] },
];

export function buildRatioPickerGroups(custom: string[], value: string): RatioPickerGroup[] {
  const existing = new Set(['auto']);
  const groups: RatioPickerGroup[] = [
    { id: 'auto', title: null, rows: [{ label: '自动（跟随原图）', ratio: 'auto', removable: false }] },
    ...RATIO_PICKER_PRESET_GROUPS.map(group => ({
      id: group.id,
      title: group.title,
      rows: group.ratios.map(label => {
        const ratio = normalizeStudioRatio(label);
        existing.add(ratio);
        return { label, ratio, removable: false };
      }),
    })),
  ];
  const customRows: RatioPickerRow[] = [];
  custom.forEach(item => {
    let ratio: string;
    try { ratio = normalizeStudioRatio(item); } catch { return; }
    if (existing.has(ratio)) return;
    existing.add(ratio);
    customRows.push({ label: ratio, ratio, removable: true });
  });
  // Keep the exact current parameter visible, including historical spellings.
  // Do not replace it with the first preset or normalize it as a side effect of sorting.
  if (value !== 'auto' && !existing.has(value)) customRows.push({ label: `${value}（当前参数）`, ratio: value, removable: false });
  groups.push({ id: 'custom', title: '自定义', rows: customRows });
  return groups;
}
