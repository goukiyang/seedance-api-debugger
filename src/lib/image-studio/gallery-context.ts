import type { Prisma } from '@prisma/client';
import { sharedDependencyState, type SharedStudioClient } from './shared-contract';
import { sharedCommandFingerprint } from './shared-command-storage';
import { moduleCoverKey } from './module-cover';

type Row = Record<string, unknown>;

// Only scalar Prisma predicates used by the existing readers are evaluated here.
// New/relational predicates return to the real delegate, never a permissive match.
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      const clauses = (Array.isArray(value) ? value : [value]) as Row[];
      return key === 'OR' ? clauses.some(item => matches(row, item))
        : key === 'NOT' ? clauses.every(item => !matches(row, item)) : clauses.every(item => matches(row, item));
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, operand]) => {
        const actual = row[key];
        if (operator === 'in' || operator === 'notIn') return (operand as unknown[]).includes(actual) === (operator === 'in');
        if (operator === 'equals') return actual === operand;
        if (operator === 'not' && (!operand || typeof operand !== 'object')) return actual !== operand;
        if (operator === 'startsWith') return typeof actual === 'string' && actual.startsWith(String(operand));
        throw new Error('gallery_unhandled_predicate');
      });
    }
    return row[key] === value;
  });
}

export type GalleryPageSelection = { moduleIds: string[]; presetIds: string[] };
export async function createGalleryReadContext(tx: Prisma.TransactionClient, ownerId: string, selection?: GalleryPageSelection) {
  if (selection && selection.moduleIds.length + selection.presetIds.length > 24) throw new Error('gallery_page_exceeds_limit');
  const modules = await tx.imageStudioModule.findMany({ where: { owner_id: ownerId, ...(selection ? { id: { in: selection.moduleIds } } : {}) }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] });
  const sources = await tx.imageStudioPreset.findMany({ where: selection ? { id: { in: [...selection.presetIds, ...modules.flatMap(row => row.source_preset_id ? [row.source_preset_id] : [])] } } : { OR: [{ owner_id: ownerId }, { is_shared: true },
    { id: { in: modules.flatMap(row => row.source_preset_id ? [row.source_preset_id] : []) } }] }, orderBy: { id: 'asc' } });
  const settingPrefixes = ['studio_shared_binding_v1:', 'studio_shared_publisher_v1:', 'studio_fixed_references_v1:',
    'studio_reference_policy_v1:', 'studio_style_', 'studio_skill_selection_v1:', 'studio_shared_reproduction_v1:',
    'studio_preset_archived_v1:', 'studio_deleted_workspace', 'studio_module_cover_v1:', 'studio_removed_default_groups_v1:'];
  const dependency = await sharedDependencyState(sources, tx);
  const pageKeys = [...dependency.dependencies.map(row => row.key), ...dependency.styles.map(row => row.key),
    ...modules.flatMap(row => [`studio_shared_binding_v1:${row.id}`, moduleCoverKey({ kind: 'module', id: row.id }),
      `studio_deleted_workspace_v1:${sharedCommandFingerprint(ownerId)}:${row.id}`]),
    ...sources.flatMap(row => [`studio_shared_publisher_v1:${row.id}`, `studio_preset_archived_v1:${row.id}`,
      `studio_deleted_workspace_source_v1:${sharedCommandFingerprint(ownerId)}:${sharedCommandFingerprint(row.id)}`]), `studio_removed_default_groups_v1:${ownerId}`];
  const settings = await tx.platformSetting.findMany({ where: selection ? { key: { in: pageKeys } } : { OR: settingPrefixes.map(prefix => ({ key: { startsWith: prefix } })) } });
  const settingsCovered = (where: Row): boolean => {
    if (where.OR) return (where.OR as Row[]).every(settingsCovered);
    const key = where.key as string | { in?: string[]; startsWith?: string } | undefined;
    if (selection) return typeof key === 'string' ? pageKeys.includes(key) : Boolean(key?.in?.every(value => pageKeys.includes(value)));
    return typeof key === 'string' ? settingPrefixes.some(prefix => key.startsWith(prefix))
      : Boolean(key && (key.in ? key.in.every(value => settingPrefixes.some(prefix => value.startsWith(prefix)))
        : key.startsWith && settingPrefixes.some(prefix => key.startsWith!.startsWith(prefix))));
  };
  const publisherIds = settings.filter(row => row.key.startsWith('studio_shared_publisher_v1:')).flatMap(row => {
    try { const value = JSON.parse(row.value_json); return typeof value?.moduleId === 'string' ? [value.moduleId] : []; } catch { return []; }
  });
  const publishers = await tx.imageStudioModule.findMany({ where: { id: { in: publisherIds } } });
  const users = await tx.user.findMany({ where: { id: { in: Array.from(new Set([ownerId, ...sources.map(row => row.owner_id)])) } } });
  const assets = dependency.dependencyAssets;
  const tables: Record<string, Row[]> = { platformSetting: settings, imageStudioModule: Array.from(new Map([...modules, ...publishers].map(row => [row.id, row])).values()),
    imageStudioPreset: sources, user: users, asset: assets };
  const memo = new Map<string, Promise<unknown>>();
  const client = new Proxy(tx, { get(target, property) {
    const delegate = Reflect.get(target, property);
    if (typeof property !== 'string' || !delegate || typeof delegate !== 'object') return delegate;
    return new Proxy(delegate, { get(model, method) {
      const original = Reflect.get(model, method);
      if (typeof method !== 'string' || !['findUnique', 'findFirst', 'findMany'].includes(method)) return original;
      return (args: { where?: Row; select?: Record<string, boolean>; orderBy?: unknown; take?: number } = {}) => {
        const token = JSON.stringify([property, method, args]);
        if (memo.has(token)) return memo.get(token);
        const read = async () => {
          let rows = tables[property];
          // The asset projection is intentionally bounded to the collected dependencies.
          const ids = args.where?.id as string | { in?: string[] } | undefined;
          if (property === 'asset' && (!ids || typeof ids !== 'string' && !Array.isArray(ids.in)
            || (typeof ids === 'string' ? [ids] : ids?.in || []).some(id => !assets.some(row => row.id === id)))) rows = undefined!;
          if (property === 'platformSetting' && !settingsCovered(args.where || {})) rows = undefined!;
          if (rows) {
            try {
              let selected = rows.filter(row => matches(row, args.where || {}));
              const orders = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) as Array<Record<string, string>> : [];
              selected = selected.slice().sort((a, b) => {
                for (const order of orders) for (const [field, direction] of Object.entries(order)) {
                  const left = a[field] as string | number, right = b[field] as string | number;
                  if (left < right) return direction === 'desc' ? 1 : -1;
                  if (left > right) return direction === 'desc' ? -1 : 1;
                }
                return 0;
              });
              if (args.take !== undefined) selected = selected.slice(0, args.take);
              const project = (row: Row) => args.select ? Object.fromEntries(Object.entries(args.select).filter(([, enabled]) => enabled).map(([key]) => [key, row[key]])) : row;
              return method === 'findMany' ? selected.map(project) : selected[0] ? project(selected[0]) : null;
            } catch (error) { if (!(error instanceof Error) || error.message !== 'gallery_unhandled_predicate') throw error; }
          }
          return Reflect.apply(original, model, [args]);
        };
        const value = read(); memo.set(token, value); return value;
      };
    } });
  } }) as SharedStudioClient;
  return { client, modules, sources, dependency, settings };
}
