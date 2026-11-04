import './server-runtime.cjs';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';

async function main() {
  const snapshot = process.argv[2];
  const previewId = process.env.WORKS_PREVIEW_USER_ID?.trim();
  if (!snapshot || !isAbsolute(snapshot) || process.argv.length !== 3 ||
    !snapshot.endsWith('/works-recommendation-snapshot.db') || !previewId) {
    throw new Error('Expected a dedicated snapshot and the existing Works preview account');
  }
  if (!(await lstat(snapshot)).isFile()) throw new Error('Snapshot unavailable');
  // The CLI takes a dedicated offline database. Do not initialize the app singleton
  // against an ambient runtime datasource when loading permission helpers.
  delete process.env.DATABASE_URL;
  const db = new PrismaClient({ datasourceUrl: `${pathToFileURL(snapshot).href}?connection_limit=1` });
  try {
    await db.$queryRawUnsafe('PRAGMA query_only = ON');
    const mode = await db.$queryRawUnsafe<Array<{ query_only: number | bigint }>>('PRAGMA query_only');
    if (Number(mode[0]?.query_only) !== 1) throw new Error('Snapshot read-only guard unavailable');
    const user = await db.user.findUnique({ where: { id: previewId }, select: {
      id: true, name: true, username: true, email: true, role: true, account_type: true,
      user_profile: true, feature_profile_id: true, status: true, expires_at: true,
    } });
    if (!user || user.status !== 'active' || user.account_type !== 'internal' ||
      user.role !== 'admin' && user.role !== 'user') throw new Error('Preview account unavailable');
    const session: SessionUser = { ...user, status: 'active', account_type: 'internal', role: user.role };
    const { trialWorkRecommendation } = await import('../src/lib/works/recommendation-shadow');
    const summary = await trialWorkRecommendation(db, session);
    console.log(JSON.stringify(summary));
    if (!summary.complete || summary.truncatedSources) process.exitCode = 2;
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  console.error('[works] recommendation trial could not complete against the supplied snapshot');
  process.exitCode = 1;
});
