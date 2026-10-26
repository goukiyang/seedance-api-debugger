export const CANVAS_PRODUCT_NAME = '无限画布';
// The old label is read-only compatibility for existing task and ledger rows.
export const CANVAS_SOURCE_LABELS = [CANVAS_PRODUCT_NAME, '无线画布'] as const;

export function isCanvasSource(source: unknown, ...labels: unknown[]): boolean {
  return source === 'ultimate_canvas' || labels.some(label =>
    typeof label === 'string' && CANVAS_SOURCE_LABELS.some(alias => alias === label));
}

export function canvasSourceJsonMarkers(): string[] {
  const pairs = [['source', 'ultimate_canvas'], ...CANVAS_SOURCE_LABELS.map(label => ['source_label', label])];
  return pairs.flatMap(([key, value]) => [JSON.stringify(key) + ':' + JSON.stringify(value),
    JSON.stringify(key) + ': ' + JSON.stringify(value)]);
}
