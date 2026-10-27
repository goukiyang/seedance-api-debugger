import './server-runtime.cjs';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { privatePromptPolicy } from '../src/lib/security/private-prompts.server';
import { preparePrivateContextIndexMigration, executePrivateContextIndexMigration } from '../src/lib/image-studio/private-context-migration.server';
import { prepareImagePrivateMigration } from '../src/lib/image-studio/private-migration.server';
import { prepareVideoStudioPrivateMigration } from '../src/lib/template-studio/private-migration.server';
import { preparePrivateSettingMigration } from '../src/lib/security/private-setting-migration.server';
import { prepareMultiviewPrivateMigration, preparePrivateVideoTaskMigration } from '../src/lib/video/private-migration.server';
import { preparePrivateMigrationPlan, executePrivateMigrationPlan } from '../src/lib/security/private-prompt-migration.server';

async function protectedJson(file: string) {
  if (!path.isAbsolute(file) || await realpath(file) !== file) throw new Error();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) || stat.uid !== 0 && stat.uid !== process.getuid?.()) throw new Error();
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
async function main() {
  const [mode, phase, selectionFile, approvalFile, ...extra] = process.argv.slice(2);
  if (!['prepare', 'apply'].includes(mode) || !['fields', 'index'].includes(phase) || !selectionFile
    || extra.length || mode === 'apply' && !approvalFile || mode === 'prepare' && approvalFile) throw new Error();
  const selection = await protectedJson(selectionFile);
  if (selection.schema !== 'private-prompt-migration-selection.v1' || typeof selection.inventoryId !== 'string') throw new Error();
  if (selection.rotateBodyKey !== undefined && typeof selection.rotateBodyKey !== 'boolean') throw new Error();
  const options = { rotateBodyKey: selection.rotateBodyKey === true };
  const db = new PrismaClient({ log: [] });
  try {
    const policy = privatePromptPolicy();
    if (!policy) throw new Error();
    let approval: any;
    if (mode === 'apply') {
      const root = process.env.NODE_ENV === 'test' ? process.env.PRIVATE_PROMPTS_FIXTURE_ROOT : '/etc/video-api-debugger/private-prompts';
      if (!root || !path.resolve(approvalFile).startsWith(path.resolve(root) + path.sep)) throw new Error();
      approval = await protectedJson(approvalFile);
      if (approval.schema !== 'private-prompt-migration-approval.v1' || approval.phase !== phase
        || approval.inventoryId !== selection.inventoryId || approval.policyRevision !== policy.revision
        || approval.writerFenceId !== policy.activation?.writerFenceId || approval.restoreId !== policy.activation?.restoreId
        || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now()) throw new Error();
    }
    if (phase === 'index') {
      const plan = await preparePrivateContextIndexMigration(db, selection.inventoryId, selection.contextKeys);
      if (mode === 'apply') await executePrivateContextIndexMigration(db, plan, { inventoryId: selection.inventoryId, digest: approval.digest, restoreId: approval.restoreId });
      process.stdout.write(JSON.stringify({ mode, phase, inventoryId: plan.inventoryId, digest: plan.digest, pairs: plan.pairs.length }) + '\n');
    } else {
      const image = await prepareImagePrivateMigration(db, selection.image, options);
      const video = await prepareVideoStudioPrivateMigration(db, selection.video, options);
      const settings = await preparePrivateSettingMigration(db, selection.settingIds, options);
      const multiview = selection.multiview ? await prepareMultiviewPrivateMigration(db, selection.multiview, options) : { rows: [], unchangedRows: 0 };
      const videoTasks = await preparePrivateVideoTaskMigration(db, selection.privateVideoTaskIds, options);
      const unclassifiedRows = image.unclassifiedRows + video.unclassifiedRows + settings.unclassifiedRows;
      const plan = preparePrivateMigrationPlan(selection.inventoryId, [...image.rows, ...video.rows, ...settings.rows, ...multiview.rows, ...videoTasks.rows]);
      if (mode === 'apply') {
        if (unclassifiedRows) throw new Error();
        await executePrivateMigrationPlan(db, plan, { inventoryId: selection.inventoryId, planDigest: approval.digest,
          restoreId: approval.restoreId, policyRevision: approval.policyRevision });
      }
      process.stdout.write(JSON.stringify({ mode, phase, inventoryId: plan.inventoryId, digest: plan.digest,
        changedRows: plan.rows.length, unclassifiedRows,
        unchangedRows: image.unchangedRows + video.unchangedRows + settings.unchangedRows + multiview.unchangedRows + videoTasks.unchangedRows }) + '\n');
    }
  } finally { await db.$disconnect(); }
}
void main().catch(() => { process.stderr.write('PRIVATE_MIGRATION_FAILED\n'); process.exitCode = 1; });
