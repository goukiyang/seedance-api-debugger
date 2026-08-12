import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function main() {
  const auditSource = read('src/lib/costs/audit.ts');

  assert.match(
    auditSource,
    /LEDGER_ID_QUERY_CHUNK_SIZE/,
    '成本审计需要显式设置账本 ID 分批查询大小，避免 Prisma\/SQLite 参数上限。',
  );
  assert.match(
    auditSource,
    /async function findOfficialChargeAllocations/,
    '官方扣费分摊查询需要集中到专用 helper，避免后台页面继续写单次大 in 查询。',
  );
  assert.match(
    auditSource,
    /ledgerIds\.slice\(start,\s*start \+ LEDGER_ID_QUERY_CHUNK_SIZE\)/,
    '官方扣费分摊查询必须按 chunk 切分账本 ID。',
  );
  assert.doesNotMatch(
    auditSource,
    /ledger_id:\s*\{\s*in:\s*officialChargeLedgerIds\s*\}/,
    '不能把完整 officialChargeLedgerIds 一次性传给 prisma.costAllocation.findMany。',
  );

  console.log('cost-ledger-audit-chunk-smoke: ok');
}

main();
