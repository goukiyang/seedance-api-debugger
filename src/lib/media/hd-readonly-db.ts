import { databaseProcessMode } from '../database/process-mode';
import { sqliteDatabaseFile } from '../database/location';
import type { HdReadRepository } from './hd-read-repository';

let current: Promise<HdReadRepository> | undefined;
async function repository() {
  if (!current) current = (async () => {
    if (databaseProcessMode === 'readonly') {
      const { openReadonlyHdRepository } = await import('../database/readonly-hd');
      return openReadonlyHdRepository(sqliteDatabaseFile(process.env.DATABASE_URL || ''));
    }
    const { sharedPrismaHdRepository } = await import('./hd-prisma-read');
    return sharedPrismaHdRepository();
  })();
  return current;
}
export const hdReadRepository: HdReadRepository = {
  assetById: async id => (await repository()).assetById(id),
  referenceById: async id => (await repository()).referenceById(id),
  assetsAtUrls: async urls => (await repository()).assetsAtUrls(urls),
  referencesAtUrls: async urls => (await repository()).referencesAtUrls(urls),
  nextAssets: async (...args) => (await repository()).nextAssets(...args),
  nextTasks: async (...args) => (await repository()).nextTasks(...args),
  taskAsset: async (...args) => (await repository()).taskAsset(...args),
  countActiveImageAssets: async () => (await repository()).countActiveImageAssets(),
  inventoryAssets: async () => (await repository()).inventoryAssets(),
  inventoryReferences: async () => (await repository()).inventoryReferences(),
  close: async () => {
    const previous = current; current = undefined;
    // An open failure already reached the caller. Cleanup must not rethrow its
    // raw SQLite diagnostic after the worker's confidential error handler.
    const opened = previous ? await previous.catch(() => undefined) : undefined;
    if (opened) await opened.close();
  },
};
// Lifecycle-only compatibility for old engineering callers. No generic ORM API.
export const hdReadonlyDb = { $disconnect: () => hdReadRepository.close() };
