/**
 * Prisma Client 单例
 * 避免 Next.js 热更新时重复创建连接
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaSqlitePragmasStarted: boolean | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

function configureSqlitePragmas(client: PrismaClient) {
  if (globalForPrisma.prismaSqlitePragmasStarted) return;
  if (!process.env.DATABASE_URL?.startsWith('file:')) return;
  globalForPrisma.prismaSqlitePragmasStarted = true;

  void client.$queryRawUnsafe('PRAGMA busy_timeout = 5000').catch((error) => {
    console.warn('[Prisma] Failed to configure SQLite busy_timeout:', error instanceof Error ? error.message : String(error));
  });
}

configureSqlitePragmas(prisma);

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
