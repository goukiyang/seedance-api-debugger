export function isSamModelId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const model = id.trim().toLowerCase().split('/').pop() || '';
  return /^sam(?:$|[-_:])/.test(model);
}
