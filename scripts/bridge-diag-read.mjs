#!/usr/bin/env node
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// The web service reads this EnvironmentFile through systemd; a one-off CLI
// needs to load the same DATABASE_URL itself. Existing environment wins.
if (!process.env.DATABASE_URL) dotenv.config({ path: process.env.SD2_ENV_FILE || '/etc/video-api-debugger.env' });
if (!process.env.DATABASE_URL) dotenv.config();

const arg = process.argv[2];
if (!arg || (arg !== 'latest' && arg !== '--list' && !/^[A-HJ-NP-Z2-9]{6}$/i.test(arg))) {
  console.error('用法: node scripts/bridge-diag-read.mjs latest | <六位编号> | --list');
  process.exit(2);
}

const prisma = new PrismaClient();
const where = { action: 'bridge_diag_upload', target_type: 'BridgeDiag' };
const select = {
  id: true, target_id: true, detail: true, created_at: true, operator_id: true,
  operator: { select: { name: true } },
};

try {
  if (arg === '--list') {
    const rows = await prisma.operationLog.findMany({ where, orderBy: { created_at: 'desc' }, take: 20, select });
    const uploads = rows.map((row) => {
      const detail = row.detail ? JSON.parse(row.detail) : {};
      return {
        code: row.target_id, uploadedBy: row.operator?.name || row.operator_id,
        createdAt: row.created_at, version: detail.version ?? null,
        profileName: detail.instance?.profileName ?? null, count: detail.count ?? null,
      };
    });
    console.log(JSON.stringify(uploads, null, 2));
  } else {
    const row = await prisma.operationLog.findFirst({
      where: { ...where, ...(arg === 'latest' ? {} : { target_id: arg.toUpperCase() }) },
      orderBy: { created_at: 'desc' }, select,
    });
    if (!row) {
      console.error('未找到诊断日志');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({
        code: row.target_id, id: row.id, createdAt: row.created_at,
        uploadedBy: row.operator?.name || row.operator_id,
        detail: row.detail ? JSON.parse(row.detail) : null,
      }, null, 2));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
