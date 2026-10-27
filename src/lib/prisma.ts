export { applicationDatabase as prisma } from './database/client';

// Prisma's SQLite transactions start with BEGIN IMMEDIATE, so even reads queue on the single write lock.
// A busy lock (P1008) rolls the whole transaction back, which makes a bounded retry safe.
export async function retrySqliteBusy<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); }
    catch (error) {
      if (attempt >= attempts || (error as { code?: string } | null)?.code !== 'P1008') throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
}
