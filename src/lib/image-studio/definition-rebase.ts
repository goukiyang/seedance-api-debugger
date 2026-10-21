export type StudioDefinitionField<T> = {
  key: keyof T;
  label: string;
  before: T[keyof T] | undefined;
  current: T[keyof T];
  latest: T[keyof T];
  conflict: boolean;
};

export function planStudioDefinitionRebase<T extends Record<string, unknown>>(
  before: T | null, current: T, latest: T, labels: Record<keyof T, string>,
) {
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const fields = (Object.keys(labels) as Array<keyof T>).flatMap(key => same(before ? before[key] : current[key], latest[key]) ? [] : [{
    key, label: labels[key], before: before?.[key], current: current[key], latest: latest[key],
    conflict: !before || !same(before[key], current[key]) && !same(current[key], latest[key]),
  }]);
  return {
    fields,
    apply(preferCurrent: boolean): T {
      const merged = { ...current };
      for (const field of fields) if (!field.conflict || !preferCurrent) merged[field.key] = field.latest;
      return merged;
    },
  };
}
