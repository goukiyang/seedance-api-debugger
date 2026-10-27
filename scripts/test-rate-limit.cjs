const assert = require('node:assert/strict');
process.env.SESSION_SECRET = 'synthetic-rate-limit-master-012345678901234567';
require('tsx/cjs');
const { RateLimiter } = require('../src/lib/security/rate-limit.ts');
const { RATE_INCREMENT_SQL, RATE_READ_SQL } = require('../src/lib/security/rate-limit-sql.ts');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE ApiRateLimit (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at_ms BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL)');
const store = {
  increment: async (key, windowMs, now) => db.prepare(RATE_INCREMENT_SQL).get(key, now + windowMs, now),
  read: async (key, now) => db.prepare(RATE_READ_SQL).get(key, now) || null,
  delete: async key => { db.prepare('DELETE FROM ApiRateLimit WHERE key=?').run(key); },
};
async function main() {
  let now = 1700000000000;
  const limiter = new RateLimiter(store, () => now);
  for (let i = 0; i < 5; i++) {
    assert.equal((await limiter.beforeLogin('person', '192.0.2.1')).allowed, true);
    await limiter.afterLogin('person', '192.0.2.1', { invalidCredentials: true, succeeded: false });
  }
  assert.equal((await limiter.beforeLogin('person', '192.0.2.1')).allowed, false);
  assert.equal((await limiter.beforeLogin('person', '192.0.2.2')).allowed, true);
  const restarted = new RateLimiter(store, () => now);
  assert.equal((await restarted.beforeLogin('person', '192.0.2.1')).allowed, false);
  now += 1001;
  assert.equal((await restarted.beforeLogin('person', '192.0.2.1')).allowed, true);
  await restarted.afterLogin('person', '192.0.2.1', { invalidCredentials: false, succeeded: true });
  assert.equal((await restarted.beforeLogin('person', '192.0.2.1')).allowed, true);
  for (let i = 0; i < 3; i++) assert.equal((await limiter.registrationCode('person@example.invalid', '192.0.2.3')).allowed, true);
  assert.equal((await restarted.registrationCode('person@example.invalid', '192.0.2.4')).allowed, false);
  for (let i = 0; i < 5; i++) assert.equal((await limiter.feedback('192.0.2.5')).allowed, true);
  assert.equal((await restarted.feedback('192.0.2.5')).allowed, false);
  now += 3600001;
  assert.equal((await restarted.feedback('192.0.2.5')).allowed, true);
  const rows = db.prepare('SELECT key FROM ApiRateLimit').all();
  assert.equal(JSON.stringify(rows).includes('person'), false);
  assert.equal(JSON.stringify(rows).includes('192.0.2'), false);
  const failed = new RateLimiter({ ...store, increment: async () => { throw new Error('synthetic db offline'); } }, () => now);
  await assert.rejects(() => failed.feedback('192.0.2.9'), /synthetic db offline/);
  const outcomes = await Promise.all(Array.from({ length: 30 }, () => restarted.auth('192.0.2.8')));
  assert.equal(outcomes.filter(value => value.allowed).length, 20);
  console.log('PASS SQLite durable limits, login backoff without account lock, restart, expiry, parallel ceiling, fail-closed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
