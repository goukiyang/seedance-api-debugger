const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');

// SQL-backed Prisma-shaped adapter for behavioral contracts only. The production
// Prisma schema/client are separately checked by the lead on the server.
module.exports = function createDatabase(filename) {
  const sql = new DatabaseSync(filename);
  sql.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;');
  const db = {};
  const encode = row => JSON.stringify(row);
  const decode = row => row && JSON.parse(row.body, (key, value) => /(_at|At|expires_at|_until|_deadline)$/.test(key) && typeof value === 'string' && /^\d{4}-/.test(value) ? new Date(value) : value);
  function matches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return value.some(part => matches(row, part));
      if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        if ('in' in value) return value.in.includes(row[key]);
        if ('not' in value) return row[key] !== value.not;
        if ('lte' in value) return row[key] <= value.lte;
        if ('lt' in value) return row[key] < value.lt;
        if ('gte' in value) return row[key] >= value.gte;
        if ('gt' in value) return row[key] > value.gt;
        return matches(row, value);
      }
      return value instanceof Date ? +row[key] === +value : (row[key] ?? null) === value;
    });
  }
  for (const table of ['user', 'creditAccount', 'creditBucket', 'creditLedger', 'creditHold', 'videoTask', 'videoCard', 'imageStudioTask', 'canvasRoleAttempt', 'canvasRoleWork', 'canvasRoleTaskRun', 'projectBudgetAccount', 'projectBudgetLedger', 'platformSetting', 'notification', 'canvasVideoBatchChild', 'providerApiRequest', 'approvalUsage', 'approvalRecord']) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
    if (['creditLedger', 'projectBudgetLedger'].includes(table)) sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_key ON ${table}(json_extract(body,'$.idempotency_key'))`);
    if (table === 'creditHold') sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS hold_business ON creditHold(json_extract(body,'$.business_type'), json_extract(body,'$.business_id'))");
    const all = () => sql.prepare(`SELECT body FROM ${table}`).all().map(decode);
    const api = db[table] = {
      findMany: async ({ where, take, orderBy } = {}) => {
        let rows = all().filter(row => matches(row, where));
        for (const order of (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(Boolean).reverse()) {
          const [key, direction] = Object.entries(order)[0]; rows.sort((a,b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === 'desc' ? -1 : 1));
        }
        return take ? rows.slice(0, take) : rows;
      },
      findFirst: async args => (await api.findMany(args))[0] || null,
      findUnique: async args => api.findFirst(args),
      findUniqueOrThrow: async args => { const row = await api.findFirst(args); if (!row) throw new Error('Missing synthetic row'); return row; },
      count: async args => (await api.findMany(args)).length,
      aggregate: async ({ where, _sum }) => ({ _sum: Object.fromEntries(Object.keys(_sum).map(key => [key, all().filter(row => matches(row, where)).reduce((sum, row) => sum + (row[key] || 0), 0)])) }),
      create: async ({ data }) => {
        const row = { id: randomUUID(), created_at: new Date(), updated_at: new Date(), ...data };
        if (table === 'creditAccount') Object.assign(row, { monthly_used: 0, total_used: 0, ...data });
        if (table === 'creditHold') Object.assign(row, { state: 'held', version: 0, actual_cost: 0, refunded_amount: 0, expired_closed_amount: 0, ...data });
        if (table === 'videoTask') Object.assign(row, { state_version: 0, billing_scope: 'user', ...data });
        sql.prepare(`INSERT INTO ${table} VALUES (?,?)`).run(row.id, encode(row)); return row;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const old of all().filter(row => matches(row, where))) {
          const row = { ...old, updated_at: new Date() };
          for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value ? (old[key] || 0) + value.increment : value;
          count += Number(sql.prepare(`UPDATE ${table} SET body=? WHERE id=? AND body=?`).run(encode(row), old.id, encode(old)).changes);
        }
        return { count };
      },
      update: async args => { const old = await api.findUnique(args); if (!old) throw new Error('Missing synthetic row'); await api.updateMany(args); return api.findUnique({ where: { id: old.id } }); },
      upsert: async ({ where, create, update }) => await api.findUnique({ where }) ? api.update({ where, data: update }) : api.create({ data: create }),
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const row of all().filter(row => matches(row, where))) count += Number(sql.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id).changes);
        return { count };
      },
    };
  }
  let queue = Promise.resolve();
  db.$transaction = run => {
    const result = queue.then(async () => { sql.exec('BEGIN IMMEDIATE'); try {
      const tx = Object.fromEntries(Object.entries(db).filter(([key]) => !key.startsWith('$')));
      const value = await run(tx); sql.exec('COMMIT'); return value;
    } catch (error) { sql.exec('ROLLBACK'); throw error; } });
    queue = result.catch(() => {}); return result;
  };
  db.$disconnect = async () => sql.close();
  return db;
};
