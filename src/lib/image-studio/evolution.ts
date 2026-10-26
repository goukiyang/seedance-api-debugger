export type EvolutionDirection = 'increase' | 'decrease';
export type EvolutionCapability = { version: 1; defaultDirection: EvolutionDirection };
export type EvolutionInput = { direction: EvolutionDirection; manual: boolean };

// Verified legacy template. A name or unrelated prose is not a capability signal.
const legacyModules = new Set(['322d566f-cd7b-438d-aac6-dc5d549c37fc']);
export function evolutionCapability(row: { id?: string; context?: string }): EvolutionCapability | null {
  const marker = row.context?.match(/\[studio:evolution:v1:(increase|decrease)\]/);
  if (marker) return { version: 1, defaultDirection: marker[1] as EvolutionDirection };
  return row.id && legacyModules.has(row.id) ? { version: 1, defaultDirection: 'increase' } : null;
}
export function parseEvolution(value: unknown): EvolutionInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('演化方向无效');
  const record = value as Record<string, unknown>;
  if (!['increase', 'decrease'].includes(String(record.direction)) || typeof record.manual !== 'boolean'
    || Object.keys(record).some(key => !['direction', 'manual'].includes(key))) throw new Error('演化方向无效');
  return { direction: record.direction as EvolutionDirection, manual: record.manual };
}
export function describedEvolutionDirection(content: string): EvolutionDirection | null {
  const up = /递进|逐[步级渐].{0,8}(?:增加|增强|加深|复杂|变大|变重)|越来越(?:多|强|深|复杂|大|重)|从(?:轻装到重装|少到多|弱到强|简单到复杂|轻到重)/.test(content);
  const down = /递减|逐[步级渐].{0,8}(?:减少|减弱|变浅|简化|变小|变轻)|越来越(?:少|弱|浅|简单|小|轻)|从(?:重装到轻装|多到少|强到弱|复杂到简单|重到轻)/.test(content);
  return up === down ? null : up ? 'increase' : 'decrease';
}
export function resolveEvolution(input: EvolutionInput, content: string, capability: EvolutionCapability) {
  const described = describedEvolutionDirection(content);
  if (input.manual && described && described !== input.direction) throw new Error('正文方向与手选方向冲突，请调整正文或方向');
  return { direction: input.manual ? input.direction : described || capability.defaultDirection, manual: input.manual, content };
}
export function evolutionInstructions(value: ReturnType<typeof resolveEvolution>) {
  return `本次演化参数（优先于模板未手选的默认方向）：\n变化内容：${JSON.stringify(value.content)}\n方向：${value.direction === 'increase' ? '递进，同一变化维度逐档增加' : '递减，沿同一组档位反向排列，逐档减少，不另随机一组状态'}。\n原正文对变化的明确要求优先于未手选默认；只改变正文要求变化的部分，其余主体、构图、风格、档数、范围与排版沿模板和参考图。档数不是输出图片数，不套用其他人物模板、不改变计费张数。`;
}
