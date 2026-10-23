/**
 * Approved R02 recovery only. Default is read-only; --apply writes empty cover
 * slots and original per-item receipts. Run from the protected release with the
 * normal database/module-covers backup and v3-compatible rollback already held.
 * node --env-file=.env --import tsx scripts/backfill-shared-module-covers.ts \
 *   --inventory /private/inventory-r02.private.json --owner-id <approved-author> [--apply]
 * Re-run the identical command to query/resume original item IDs. No new IDs,
 * latest-result selection, publisher creation, model calls, or file deletion.
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { assertStudioActor } from '../src/lib/image-studio/shared-contract';
import { SHARED_COVER_R02_INVENTORY_SHA256, frozenSharedCoverRequestId, moduleCoverKey, recoverFrozenSharedCover,
  type FrozenSharedCoverItem } from '../src/lib/image-studio/module-cover';

type InventoryRow = Omit<Partial<FrozenSharedCoverItem>, 'presetId' | 'ownerId' | 'disposition'> & { presetId: string; ownerId: string; disposition: string; recordHash?: string };
type Inventory = { schema: string; capturedAt: string; readOnly: boolean; rows: InventoryRow[] };
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function args() {
  const values = process.argv.slice(2);
  let inventory = '', ownerId = '', apply = false;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === '--apply') { if (apply) throw new Error('--apply 不得重复'); apply = true; }
    else if (values[i] === '--inventory' && !inventory) inventory = values[++i] || '';
    else if (values[i] === '--owner-id' && !ownerId) ownerId = values[++i] || '';
    else throw new Error('仅支持 --inventory <R02原文件> --owner-id <授权作者> [--apply]');
  }
  if (!inventory || !ownerId || inventory.startsWith('--') || ownerId.startsWith('--'))
    throw new Error('必须提供 R02 私有原清单与已批准作者编号；默认只读');
  return { inventory, ownerId, apply };
}
async function main() {
  const options = args(), bytes = await fs.readFile(options.inventory);
  const digest = sha256(bytes);
  if (digest !== SHARED_COVER_R02_INVENTORY_SHA256) throw new Error('清单 SHA256 与已批准的 R02 原件不同，未开始读取业务对象');
  const inventory = JSON.parse(bytes.toString('utf8')) as Inventory;
  if (inventory.schema !== 'shared-cover-preflight.v1' || inventory.capturedAt !== '2026-10-22T08:36:28.165Z'
    || inventory.readOnly !== true || !Array.isArray(inventory.rows) || inventory.rows.length !== 30
    || new Set(inventory.rows.map(row => row.presetId)).size !== 30
    || inventory.rows.some(row => row.ownerId !== options.ownerId)) throw new Error('R02 清单或授权作者不匹配，停止补齐');
  const counts = new Map<string, number>();
  for (const row of inventory.rows) counts.set(row.disposition, (counts.get(row.disposition) || 0) + 1);
  if (counts.size !== 4 || counts.get('eligible-frozen-single-image') !== 24 || counts.get('preserve-fixed') !== 2
    || counts.get('no-result-no-banner') !== 3 || counts.get('skip-source-permission') !== 1) throw new Error('R02 处置数量不匹配，停止补齐');
  const actor = await assertStudioActor(options.ownerId);
  if (actor.id !== options.ownerId || actor.role !== 'admin' || actor.account_type !== 'internal')
    throw new Error('授权作者的当前内部身份无法确认，停止补齐');
  console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', inventorySha256: digest, rows: 30, eligible: 24 }));
  const outcomes: Record<string, number> = {};
  for (const [index, row] of inventory.rows.entries()) {
    if (row.disposition !== 'eligible-frozen-single-image') {
      // All six exclusions remain exclusions even if a new result now exists.
      // Observe drift for the two preserved covers, but never rewrite them.
      let status = row.disposition;
      if (row.disposition === 'preserve-fixed') {
        const current = await prisma.platformSetting.findUnique({ where: { key: moduleCoverKey({ kind: 'preset', id: row.presetId }) }, select: { value_json: true } });
        const currentHash = current ? sha256(JSON.stringify(current.value_json)) : null;
        if (currentHash !== row.recordHash) status = 'preserved-cover-drift';
      }
      outcomes[status] = (outcomes[status] || 0) + 1;
      console.log(JSON.stringify({ item: index + 1, status }));
      continue;
    }
    const frozen = row as FrozenSharedCoverItem;
    const result = await recoverFrozenSharedCover(actor, frozen, digest, options.apply);
    if (result.requestId !== frozenSharedCoverRequestId(frozen)) throw new Error('原请求编号无法确认，停止后续项目');
    outcomes[result.status] = (outcomes[result.status] || 0) + 1;
    console.log(JSON.stringify({ item: index + 1, ...result }));
    if (result.status === 'unknown' || result.status === 'pending') {
      process.exitCode = 2;
      console.log(JSON.stringify({ stopped: true, reason: '原请求未确认；保留同一清单与原号，核对后再接续，未开始后续项目' }));
      break;
    }
  }
  console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', outcomes }));
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : '封面补齐未确认，保留原清单与原请求编号');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
