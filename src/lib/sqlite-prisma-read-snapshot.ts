import { Prisma } from '@prisma/client';
import { withUsageReadSnapshot, type UsageSqlReader, type UsageSqlCell, type UsageSqlRow } from './usage/sqlite-read-snapshot';

type Model = typeof Prisma.dmmf.datamodel.models[number];
type Field = Model['fields'][number];
type Input = Record<string, any>;
const models = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name, model]));
const delegates = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name[0].toLowerCase() + model.name.slice(1), model]));
const fail = () => new Error('sqlite_snapshot_query_unsupported');
const identifier = (name: string) => Prisma.raw('"' + name.replace(/"/g, '""') + '"');
const table = (model: Model) => identifier(model.dbName || model.name);
const fieldOf = (model: Model, name: string) => {
  const field = model.fields.find(value => value.name === name);
  if (!field) throw fail();
  return field;
};
const column = (model: Model, name: string, alias: string) => {
  const field = fieldOf(model, name);
  if (field.kind === 'object') throw fail();
  return Prisma.sql`${identifier(alias)}.${identifier(field.dbName || field.name)}`;
};
const combine = (values: Prisma.Sql[], operator: 'AND' | 'OR') => values.length
  ? Prisma.sql`(${Prisma.join(values, ` ${operator} `)})` : Prisma.raw(operator === 'AND' ? '1=1' : '1=0');
function compare(left: Prisma.Sql, operator: string, value: unknown): Prisma.Sql {
  if (value === null) {
    if (!['=', '<>'].includes(operator)) throw fail();
    return Prisma.sql`${left} IS ${Prisma.raw(operator === '<>' ? 'NOT NULL' : 'NULL')}`;
  }
  return Prisma.sql`${left} ${Prisma.raw(operator)} ${value}`;
}
function scalarFilter(left: Prisma.Sql, value: unknown): Prisma.Sql {
  if (value === undefined) return Prisma.raw('1=1');
  if (value === null || typeof value !== 'object' || value instanceof Date) return compare(left, '=', value);
  const clauses: Prisma.Sql[] = [];
  for (const [operation, expected] of Object.entries(value)) {
    if (expected === undefined) continue;
    if (operation === 'equals') clauses.push(compare(left, '=', expected));
    else if (operation === 'not') clauses.push(expected === null ? compare(left, '<>', null) : Prisma.sql`NOT (${scalarFilter(left, expected)})`);
    else if (['lt', 'lte', 'gt', 'gte'].includes(operation)) clauses.push(compare(left, ({ lt: '<', lte: '<=', gt: '>', gte: '>=' } as Input)[operation], expected));
    else if (operation === 'in' || operation === 'notIn') {
      if (!Array.isArray(expected)) throw fail();
      clauses.push(expected.length ? Prisma.sql`${left} ${Prisma.raw(operation === 'in' ? 'IN' : 'NOT IN')} (${Prisma.join(expected)})`
        : Prisma.raw(operation === 'in' ? '1=0' : '1=1'));
    } else if (['startsWith', 'endsWith', 'contains'].includes(operation) && typeof expected === 'string') {
      // Prisma's SQLite connector uses LIKE with its native ASCII case folding
      // and wildcard semantics. Keep that behavior for existing namespaces.
      clauses.push(Prisma.sql`${left} LIKE ${(operation === 'startsWith' ? '' : '%') + expected + (operation === 'endsWith' ? '' : '%')}`);
    } else throw fail();
  }
  return combine(clauses, 'AND');
}
function relation(model: Model, field: Field) {
  const target = models.get(field.type);
  if (!target) throw fail();
  if (field.relationFromFields?.length) return { target, local: field.relationFromFields, remote: field.relationToFields! };
  const reverse = target.fields.find(value => value.kind === 'object' && value.relationName === field.relationName && value.relationFromFields?.length);
  if (!reverse) throw fail(); // This application uses explicit join models.
  return { target, local: reverse.relationToFields!, remote: reverse.relationFromFields! };
}
function where(model: Model, input: Input | undefined, alias: string, depth = 0): Prisma.Sql {
  if (!input) return Prisma.raw('1=1');
  const clauses: Prisma.Sql[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (['AND', 'OR', 'NOT'].includes(name)) {
      const nested = (Array.isArray(value) ? value : [value]).map(item => where(model, item, alias, depth + 1));
      clauses.push(name === 'NOT' ? combine(nested.map(item => Prisma.sql`NOT (${item})`), 'AND') : combine(nested, name as 'AND' | 'OR'));
      continue;
    }
    const field = model.fields.find(item => item.name === name);
    if (!field) {
      const compound = [...model.uniqueIndexes, ...(model.primaryKey ? [model.primaryKey] : [])]
        .find(item => (item.name || item.fields.join('_')) === name);
      if (!compound || !value || typeof value !== 'object') throw fail();
      clauses.push(where(model, value, alias, depth + 1)); continue;
    }
    if (field.kind !== 'object') { clauses.push(scalarFilter(column(model, name, alias), value)); continue; }
    const joined = relation(model, field), child = `r${depth}_${name}`;
    const link = joined.local.map((key, index) => Prisma.sql`${column(model, key, alias)} = ${column(joined.target, joined.remote[index], child)}`);
    const exists = (condition?: Input, negate = false) => Prisma.sql`${Prisma.raw(negate ? 'NOT EXISTS' : 'EXISTS')} (SELECT 1 FROM ${table(joined.target)} ${identifier(child)} WHERE ${combine([...link, where(joined.target, condition, child, depth + 1)], 'AND')})`;
    if (value === null) { clauses.push(exists(undefined, true)); continue; }
    if (!value || typeof value !== 'object') throw fail();
    const filters = Object.entries(value);
    if (!filters.some(([key]) => ['some', 'none', 'every', 'is', 'isNot'].includes(key))) { clauses.push(exists(value)); continue; }
    for (const [operator, filter] of filters) {
      if (filter !== null && filter !== undefined && (typeof filter !== 'object' || Array.isArray(filter))) throw fail();
      const condition = filter as Input | null | undefined;
      if (operator === 'some' || operator === 'is') clauses.push(exists(condition ?? undefined, condition === null));
      else if (operator === 'none' || operator === 'isNot') clauses.push(exists(condition ?? undefined, condition !== null));
      else if (operator === 'every') clauses.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM ${table(joined.target)} ${identifier(child)} WHERE ${combine([...link, Prisma.sql`NOT (${where(joined.target, condition ?? undefined, child, depth + 1)})`], 'AND')})`);
      else throw fail();
    }
  }
  return combine(clauses, 'AND');
}
function order(model: Model, input: Input | Input[] | undefined, alias: string): Prisma.Sql {
  if (!input) return Prisma.empty;
  const terms: Prisma.Sql[] = [];
  for (const row of Array.isArray(input) ? input : [input]) for (const [name, direction] of Object.entries(row)) {
    if (direction !== 'asc' && direction !== 'desc') throw fail();
    terms.push(Prisma.sql`${column(model, name, alias)} ${Prisma.raw(direction.toUpperCase())}`);
  }
  return terms.length ? Prisma.sql`ORDER BY ${Prisma.join(terms)}` : Prisma.empty;
}
function limit(input: Input): Prisma.Sql {
  const take = input.take, skip = input.skip;
  if (take !== undefined && (!Number.isSafeInteger(take) || take < 0) || skip !== undefined && (!Number.isSafeInteger(skip) || skip < 0) || input.cursor) throw fail();
  return take !== undefined || skip !== undefined ? Prisma.sql`LIMIT ${take ?? -1} OFFSET ${skip ?? 0}` : Prisma.empty;
}
function decode(field: Field, value: UsageSqlCell) {
  if (value === null) return null;
  if (field.type === 'DateTime') return new Date(typeof value === 'bigint' ? Number(value) : value as string | number);
  if (field.type === 'Boolean') return value === BigInt(1) || value === 1;
  if (field.type === 'Int' || field.type === 'Float') return Number(value);
  if (field.type === 'BigInt') return BigInt(value);
  if (field.type === 'Json' && typeof value === 'string') return JSON.parse(value);
  return value;
}

/** Read-only delegates over one real SQLite mode=ro / query_only pinned snapshot.
 * Unsupported operations fail closed; no query falls back to the writer client.
 */
export function sqlitePrismaReadClient(reader: UsageSqlReader): Prisma.TransactionClient {
  async function query(model: Model, operation: string, args: Input = {}): Promise<any> {
    const allowed = ['where', 'select', 'include', 'orderBy', 'take', 'skip', 'distinct', 'by', '_count', '_sum', '_min', '_max', '_avg'];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw fail();
    const alias = 's';
    if (operation === 'count' || operation === 'groupBy' || operation === 'aggregate') {
      const by: string[] = operation === 'groupBy' ? args.by : [];
      if (!Array.isArray(by) || !by.every(name => typeof name === 'string')) throw fail();
      const counts: Array<{ group: string; name: string; alias: string }> = [];
      const selections = by.map(name => Prisma.sql`${column(model, name, alias)} AS ${identifier(name)}`);
      for (const group of ['_count', '_sum', '_min', '_max', '_avg']) {
        const requested = operation === 'count' ? group === '_count' ? args.select ?? true : undefined : args[group];
        if (!requested) continue;
        const names = requested === true ? ['_all'] : Object.keys(requested).filter(name => requested[name]);
        for (const name of names) {
          if (name === '_all' && group !== '_count') throw fail();
          const nameAlias = `${group}_${name}`;
          counts.push({ group, name, alias: nameAlias });
          selections.push(Prisma.sql`${Prisma.raw(group === '_count' ? 'COUNT' : group.slice(1).toUpperCase())}(${name === '_all' ? Prisma.raw('*') : column(model, name, alias)}) AS ${identifier(nameAlias)}`);
        }
      }
      if (!selections.length) throw fail();
      const rows = await reader.query(Prisma.sql`SELECT ${Prisma.join(selections)} FROM ${table(model)} ${identifier(alias)} WHERE ${where(model, args.where, alias)} ${by.length ? Prisma.sql`GROUP BY ${Prisma.join(by.map(name => column(model, name, alias)))}` : Prisma.empty} ${order(model, args.orderBy, alias)} ${limit(args)}`);
      const values = rows.map(row => {
        const result: Input = Object.fromEntries(by.map(name => [name, decode(fieldOf(model, name), row[name])]));
        for (const entry of counts) {
          result[entry.group] ??= {};
          result[entry.group][entry.name] = row[entry.alias] === null ? null : entry.group === '_count' || entry.group === '_avg'
            ? Number(row[entry.alias]) : decode(fieldOf(model, entry.name), row[entry.alias]);
        }
        if (args._count === true) result._count = result._count._all;
        return result;
      });
      return operation === 'groupBy' ? values : operation === 'count' ? args.select && args.select !== true ? values[0]._count : values[0]._count._all : values[0];
    }
    if (!['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow'].includes(operation)) throw fail();
    if (args.select && args.include || args.distinct) throw fail();
    const scalar = model.fields.filter(field => field.kind !== 'object');
    const selected = args.select ? scalar.filter(field => args.select[field.name]) : scalar;
    const relations = Object.entries(args.select || args.include || {}).filter(([name, value]) => value && (name === '_count' || fieldOf(model, name).kind === 'object'));
    const required = new Set(selected.map(field => field.name));
    for (const [name] of relations) {
      const names = name === '_count' ? model.fields.filter(field => field.kind === 'object').map(field => field.name) : [name];
      for (const relationName of names) for (const key of relation(model, fieldOf(model, relationName)).local) required.add(key);
    }
    if (!required.size) throw fail();
    const columns = Array.from(required, name => Prisma.sql`${column(model, name, alias)} AS ${identifier(name)}`);
    const rows = await reader.query(Prisma.sql`SELECT ${Prisma.join(columns)} FROM ${table(model)} ${identifier(alias)} WHERE ${where(model, args.where, alias)} ${order(model, args.orderBy, alias)} ${limit(operation === 'findMany' ? args : { ...args, take: 1 })}`);
    const results: Input[] = [];
    for (const raw of rows) {
      const decoded = Object.fromEntries(Array.from(required, name => [name, decode(fieldOf(model, name), raw[name])]));
      const output: Input = Object.fromEntries(selected.map(field => [field.name, decoded[field.name]]));
      const readRelation = async (name: string, nested: Input, count = false) => {
        const field = fieldOf(model, name), joined = relation(model, field);
        const condition = Object.fromEntries(joined.local.map((key, index) => [joined.remote[index], decoded[key]]));
        if (Object.values(condition).some(value => value === null)) return count ? 0 : field.isList ? [] : null;
        return query(joined.target, count ? 'count' : field.isList ? 'findMany' : 'findFirst', { ...nested,
          where: { AND: [condition, nested.where || {}] } });
      };
      for (const [name, nested] of relations) {
        if (nested !== true && (!nested || typeof nested !== 'object' || Array.isArray(nested))) throw fail();
        const selection: Input = nested === true ? {} : nested as Input;
        if (name !== '_count') output[name] = await readRelation(name, selection);
        else {
          const requested = nested === true ? model.fields.filter(field => field.kind === 'object' && field.isList).map(field => field.name)
            : Object.keys(selection.select || {}).filter(key => selection.select[key]);
          output._count = {};
          for (const key of requested) output._count[key] = await readRelation(key, selection.select?.[key] === true ? {} : selection.select?.[key] || {}, true);
        }
      }
      results.push(output);
    }
    if (operation.endsWith('OrThrow') && !results.length) throw new Prisma.PrismaClientKnownRequestError('Record not found', { code: 'P2025', clientVersion: Prisma.prismaVersion.client });
    return operation === 'findMany' ? results : results[0] ?? null;
  }
  const raw = (...args: unknown[]) => {
    const first = args[0];
    const statement = Array.isArray(first) && 'raw' in first ? Prisma.sql(first as unknown as TemplateStringsArray, ...args.slice(1)) : first as Prisma.Sql;
    if (!statement || typeof statement.sql !== 'string' || !Array.isArray(statement.values)) throw fail();
    return reader.query(statement);
  };
  return new Proxy({}, { get(_target, name) {
    if (name === 'then') return undefined;
    if (name === '$queryRaw') return raw;
    if (name === '$queryRawUnsafe') return (sql: string, ...values: unknown[]) => reader.query({ sql, values } as Prisma.Sql);
    if (typeof name !== 'string' || !delegates.has(name)) throw fail();
    const model = delegates.get(name)!;
    return new Proxy({}, { get(_delegate, operation) {
      if (operation === 'then') return undefined;
      return (args?: Input) => query(model, String(operation), args);
    } });
  } }) as Prisma.TransactionClient;
}

export function withSqlitePrismaReadSnapshot<T>(read: (tx: Prisma.TransactionClient) => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
  return withUsageReadSnapshot(reader => read(sqlitePrismaReadClient(reader)), options);
}
