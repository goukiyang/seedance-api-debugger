export type SelectionPolicy = { multi: boolean; exclusive?: readonly string[]; incompatible?: readonly (readonly [string, string])[]; randomMax?: number };

export const NO_CHOICES = ['无', '无职业设定', '无科技设定', '无反差设定', '无变形', '不强调机制', '非战斗'];

export function choicesConflict(policy: SelectionPolicy, a: string, b: string) {
  return a !== b && (!policy.multi || (policy.exclusive || NO_CHOICES).includes(a) || (policy.exclusive || NO_CHOICES).includes(b)
    || Boolean(policy.incompatible?.some(([x, y]) => a === x && b === y || a === y && b === x)));
}

export function toggleChoice(values: string[], label: string, policy: SelectionPolicy) {
  if (!policy.multi) return [label];
  return values.includes(label) ? values.filter(value => value !== label) : [...values.filter(value => !choicesConflict(policy, value, label)), label];
}

export function drawChoices(pool: string[], policy: SelectionPolicy, random: () => number, first?: string) {
  if (!pool.length) return [];
  const values = [first || pool[Math.floor(random() * pool.length)]];
  const max = Math.min(pool.length, policy.randomMax || (policy.multi ? 3 : 1));
  const count = 1 + Math.floor(random() * max);
  while (values.length < count) {
    const rest = pool.filter(value => !values.includes(value) && values.every(chosen => !choicesConflict(policy, chosen, value)));
    if (!rest.length) break;
    values.push(rest[Math.floor(random() * rest.length)]);
  }
  return values;
}
