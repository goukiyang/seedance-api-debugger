import { PrismaClient } from '@prisma/client';

async function main() {
  if (!process.argv.includes('--readonly')) throw new Error('Explicit --readonly required; this command never migrates ownership');
  const url = process.env.AUDIT_READONLY_DATABASE_URL;
  if (!url?.startsWith('file:') || !url.includes('mode=ro')) throw new Error('Explicit SQLite readonly URL required');
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const rows = await db.seedanceAsset.findMany({ where: { OR: [{ owner_id: null }, { ownership_status: { not: 'owned' } }] },
      orderBy: { id: 'asc' }, take: 100, ...(process.env.AUDIT_AFTER_ID ? { cursor: { id: process.env.AUDIT_AFTER_ID }, skip: 1 } : {}),
      select: { id: true, created_at: true, local_status: true, owner_id: true, ownership_status: true } });
    const inventory = [];
    for (const row of rows) {
      const logs = await db.operationLog.findMany({ where: { target_type: 'SeedanceAsset', target_id: row.id,
        action: { in: ['seedance_asset_create', 'seedance_asset_upload_create'] } }, take: 101, select: { id: true, operator_id: true } });
      const candidates = Array.from(new Set(logs.map(log => log.operator_id)));
      inventory.push({ ...row, evidenceLogIds: logs.map(log => log.id), candidateOwnerIds: candidates,
        proposal: logs.length > 100 || candidates.length !== 1 ? 'keep-quarantined' : 'manual-review-single-exact-create-log', requiresExplicitApproval: true });
    }
    console.log(JSON.stringify({ readonly: true, writes: 0, automaticAttribution: false, inventory,
      nextAfterId: rows.length === 100 ? rows[rows.length - 1].id : null,
      migrationProposal: 'Review exact creation evidence and current ownership per row; approve a separate CAS migration. Never attribute by filename, email, project-name or current administrator.' }, null, 2));
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
