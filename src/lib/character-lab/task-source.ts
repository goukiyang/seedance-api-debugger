import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type CharacterLabTaskSourceClient = Pick<Prisma.TransactionClient, 'platformSetting'>;

const PLAN_ID = /^[a-zA-Z0-9-]{16,80}$/;

/** Durable plan keys are the only source of truth for Character Lab task batches. */
export async function characterLabTaskBatchIds(
  ownerId: string,
  db: CharacterLabTaskSourceClient = prisma,
): Promise<string[]> {
  const prefix = `character-lab:v1:${ownerId}:plan:`;
  const rows = await db.platformSetting.findMany({
    where: { key: { startsWith: prefix } },
    select: { key: true },
  });
  const batches = rows.flatMap(({ key }) => {
    if (!key.startsWith(prefix)) return [];
    const planId = key.slice(prefix.length);
    return PLAN_ID.test(planId)
      ? [createHash('sha256').update(`${ownerId}:${planId}`).digest('hex')]
      : [];
  });
  return Array.from(new Set(batches)).sort();
}
