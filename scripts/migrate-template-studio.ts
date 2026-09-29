import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';

const PRODUCTION_ROOTS = [
  '/data/video-api-debugger',
  '/srv/video-api-debugger',
  '/srv/app',
  '/var/lib/video-api-debugger',
];
const SAFE_TEST_ROOT = '/tmp';
const SAFE_TEST_ROOT_ALIASES = process.platform === 'darwin' ? ['/tmp', '/private/tmp'] : ['/tmp'];
const SAFE_TEST_PREFIX = 'sd2-template-studio-test-';
const PRODUCTION_APPROVAL_ENV = 'TEMPLATE_STUDIO_PRODUCTION_MIGRATION_APPROVED';

function databasePathFromUrl(value: string) {
  if (!value.startsWith('file:')) throw new Error('模板工作台迁移只支持 SQLite file: 数据库');
  const pathname = decodeURIComponent(value.slice('file:'.length).split('?', 1)[0]);
  if (!pathname) throw new Error('DATABASE_URL 未包含 SQLite 文件路径');
  const schemaDirectory = path.resolve(process.cwd(), 'prisma');
  return path.resolve(schemaDirectory, pathname);
}

async function canonicalPathIncludingMissingTarget(input: string) {
  let target = path.resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        const linked = await fs.readlink(target);
        target = path.resolve(path.dirname(target), linked);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      const resolved = await fs.realpath(target);
      return path.join(resolved, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(target);
      if (parent === target) throw error;
      missing.push(path.basename(target));
      target = parent;
    }
  }
}

function isSafeTemporaryDatabase(databasePath: string) {
  const parent = path.dirname(databasePath);
  const filename = path.basename(databasePath);
  return SAFE_TEST_ROOT_ALIASES.includes(parent) && filename.startsWith(SAFE_TEST_PREFIX);
}

function isKnownProductionPath(databasePath: string, rawPath: string) {
  const candidates = [databasePath, path.resolve(rawPath)];
  return candidates.some((candidate) => PRODUCTION_ROOTS.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`)));
}

function assertInvocationIsExplicit(databasePath: string, rawPath: string) {
  if (!process.argv.includes('--apply')) throw new Error('请在维护窗口显式传入 --apply');
  if (isSafeTemporaryDatabase(databasePath)) return;
  const targetKind = isKnownProductionPath(databasePath, rawPath) ? '生产或其别名数据库' : '非隔离临时数据库';
  if (!process.argv.includes('--allow-production') || process.env[PRODUCTION_APPROVAL_ENV] !== '1') {
    throw new Error(`拒绝迁移${targetKind}；仅 /tmp/${SAFE_TEST_PREFIX}* 默认可运行，其他路径需备份与授权，并同时提供 --allow-production 和 ${PRODUCTION_APPROVAL_ENV}=1`);
  }
}

type RawSqlClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

async function tableColumns(client: RawSqlClient, table: string) {
  const rows = await client.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`);
  return new Set(rows.map((row) => row.name));
}

async function addColumnIfMissing(client: RawSqlClient, table: string, column: string, declaration: string) {
  const columns = await tableColumns(client, table);
  if (columns.has(column)) return;
  try {
    await client.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${declaration}`);
  } catch (error) {
    const refreshed = await tableColumns(client, table);
    if (!refreshed.has(column)) throw error;
  }
}

async function main() {
  loadEnvConfig(process.cwd());
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('必须显式配置 DATABASE_URL');
  const rawPath = databaseUrl.slice('file:'.length).split('?', 1)[0];
  const databasePath = await canonicalPathIncludingMissingTarget(databasePathFromUrl(databaseUrl));
  assertInvocationIsExplicit(databasePath, rawPath);

  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      const existingTables = await tx.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('User', 'VideoTask')`,
      );
      const existingNames = new Set(existingTables.map((table) => table.name));
      if (!existingNames.has('User') || !existingNames.has('VideoTask')) {
        throw new Error('目标库必须已有 User 与 VideoTask 表，拒绝在空库创建不完整迁移');
      }

      await tx.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "VideoStudioTemplate" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "owner_user_id" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "group_name" TEXT NOT NULL DEFAULT '未分组',
        "status" TEXT NOT NULL DEFAULT 'draft',
        "visibility" TEXT NOT NULL DEFAULT 'private',
        "revision" INTEGER NOT NULL DEFAULT 1,
        "recipe_json" TEXT NOT NULL DEFAULT '{}',
        "published_version_id" TEXT REFERENCES "VideoStudioTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await tx.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "VideoStudioTemplateVersion" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "template_id" TEXT NOT NULL REFERENCES "VideoStudioTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        "version_number" INTEGER NOT NULL,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "group_name" TEXT NOT NULL,
        "recipe_json" TEXT NOT NULL,
        "created_by" TEXT NOT NULL,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE ("template_id", "version_number")
      )`);
      await tx.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "VideoStudioDraft" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "owner_user_id" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        "name" TEXT NOT NULL,
        "group_name" TEXT NOT NULL DEFAULT '未分组',
        "prompt" TEXT NOT NULL DEFAULT '',
        "values_json" TEXT NOT NULL DEFAULT '{}',
        "assets_json" TEXT NOT NULL DEFAULT '[]',
        "parameters_json" TEXT NOT NULL DEFAULT '{}',
        "revision" INTEGER NOT NULL DEFAULT 1,
        "template_source" TEXT NOT NULL DEFAULT 'blank',
        "source_template_id" TEXT,
        "source_version_id" TEXT,
        "template_snapshot_json" TEXT,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await tx.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "VideoStudioRun" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "owner_user_id" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        "draft_id" TEXT NOT NULL REFERENCES "VideoStudioDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        "draft_revision" INTEGER NOT NULL DEFAULT 1,
        "request_id" TEXT NOT NULL,
        "request_fingerprint" TEXT NOT NULL,
        "source" TEXT NOT NULL,
        "mode" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'queued',
        "delivery_state" TEXT NOT NULL DEFAULT 'not_sent',
        "prompt" TEXT,
        "snapshot_json" TEXT NOT NULL,
        "model" TEXT,
        "usage_json" TEXT,
        "error_message" TEXT,
        "lease_token" TEXT,
        "lease_expires_at" DATETIME,
        "attempt" INTEGER NOT NULL DEFAULT 0,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "completed_at" DATETIME,
        UNIQUE ("owner_user_id", "request_id")
      )`);

      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioTemplate_owner_user_id_status_updated_at_idx" ON "VideoStudioTemplate" ("owner_user_id", "status", "updated_at")');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioTemplate_visibility_status_updated_at_idx" ON "VideoStudioTemplate" ("visibility", "status", "updated_at")');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioTemplate_published_version_id_idx" ON "VideoStudioTemplate" ("published_version_id")');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioTemplateVersion_template_id_created_at_idx" ON "VideoStudioTemplateVersion" ("template_id", "created_at")');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioTemplateVersion_created_by_idx" ON "VideoStudioTemplateVersion" ("created_by")');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioDraft_owner_user_id_updated_at_idx" ON "VideoStudioDraft" ("owner_user_id", "updated_at")');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioDraft_template_source_source_template_id_idx" ON "VideoStudioDraft" ("template_source", "source_template_id")');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioRun_owner_user_id_created_at_idx" ON "VideoStudioRun" ("owner_user_id", "created_at")');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioRun_draft_id_created_at_idx" ON "VideoStudioRun" ("draft_id", "created_at")');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioRun_status_delivery_state_created_at_idx" ON "VideoStudioRun" ("status", "delivery_state", "created_at")');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoStudioRun_status_lease_expires_at_idx" ON "VideoStudioRun" ("status", "lease_expires_at")');

      const videoTaskColumns = await tableColumns(tx, 'VideoTask');
      if (videoTaskColumns.size === 0) throw new Error('VideoTask 表不存在，拒绝继续迁移');
      await addColumnIfMissing(tx, 'VideoTask', 'template_studio_run_id', 'TEXT REFERENCES "VideoStudioRun"("id") ON DELETE SET NULL ON UPDATE CASCADE');
      await addColumnIfMissing(tx, 'VideoTask', 'template_studio_snapshot_json', 'TEXT');
      await addColumnIfMissing(tx, 'VideoTask', 'request_fingerprint', 'TEXT');
      await tx.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "VideoTask_template_studio_run_id_idx" ON "VideoTask" ("template_studio_run_id")');
      await addColumnIfMissing(tx, 'VideoStudioRun', 'draft_revision', 'INTEGER NOT NULL DEFAULT 1');
    }, { maxWait: 15_000, timeout: 30_000 });
    process.stdout.write('模板工作台兼容迁移完成；仅创建新表/索引并补充缺失的可空 VideoTask 列。\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : '未知迁移错误';
  console.error(`[template-studio-migration] ${message}`);
  process.exitCode = 1;
});
