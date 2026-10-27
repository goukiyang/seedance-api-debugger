import { prisma } from '@/lib/prisma';
import { RateLimiter, type RateLimitStore, type RateRecord } from './rate-limit';
import { RATE_INCREMENT_SQL, RATE_READ_SQL } from './rate-limit-sql';

let lastCleanup = 0;
type RawRateRecord = Omit<RateRecord, 'count'> & { count: number | bigint };
function normalize(row: RawRateRecord): RateRecord {
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid rate counter');
  return { ...row, count };
}
const store: RateLimitStore = {
  async increment(key, windowMs, now) {
    const rows = await prisma.$queryRawUnsafe<RawRateRecord[]>(RATE_INCREMENT_SQL, key, now + windowMs, now);
    if (!rows[0]) throw new Error('Rate counter unavailable');
    if (now - lastCleanup >= 60000) {
      lastCleanup = now;
      await prisma.$executeRaw`DELETE FROM ApiRateLimit WHERE key IN
        (SELECT key FROM ApiRateLimit WHERE expires_at_ms < ${now - 3600000} LIMIT 1000)`;
    }
    return normalize(rows[0]);
  },
  async read(key, now) {
    const rows = await prisma.$queryRawUnsafe<RawRateRecord[]>(RATE_READ_SQL, key, now);
    return rows[0] ? normalize(rows[0]) : null;
  },
  async delete(key) { await prisma.$executeRaw`DELETE FROM ApiRateLimit WHERE key = ${key}`; },
};

export const apiRateLimiter = new RateLimiter(store);
