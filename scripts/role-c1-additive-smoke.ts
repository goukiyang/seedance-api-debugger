import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
  const scratch = path.resolve('.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(path.join(scratch, 'role-additive-'));
  const database = path.join(dir, 'synthetic-old.db');
  const oldClient = path.join(dir, 'old-client');
  const baseline = execFileSync('git', ['show', 'ea7de46c12301ded8b499ffc52c4f60b6946954c:prisma/schema.prisma'], { encoding: 'utf8' });
  const schema = path.join(dir, 'old.prisma');
  writeFileSync(schema, baseline.replace('provider = "prisma-client-js"', `provider = "prisma-client-js"\n  output = ${JSON.stringify(oldClient)}`));
  const env = { ...process.env, DATABASE_URL: `file:${database}`, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  const prismaCli = path.resolve('node_modules/prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schema], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [prismaCli, 'generate', '--schema', schema], { env, stdio: 'pipe' });
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require(oldClient);
  const oldWriter = new PrismaClient({ datasources: { db: { url: `file:${database}` } } });
  const sql = readFileSync('prisma/migrations/20261010040000_canvas_roles/migration.sql', 'utf8');
  assert.equal(createHash('sha256').update(sql).digest('hex'), 'beb6e80217753ee76f26372462bff5197b59999c9733d9fc77e841515afa9c41');
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
  assert.equal(statements.length, 25);
  assert.equal(statements.filter(s => /^CREATE TABLE /.test(s)).length, 10);
  assert.equal(statements.filter(s => /^CREATE (UNIQUE )?INDEX /.test(s)).length, 15);
  assert.ok(statements.every(s => /^CREATE (TABLE|(?:UNIQUE )?INDEX) "CanvasRole[A-Za-z_]+"/.test(s)));
  const query = (source: string) => execFileSync('/usr/bin/sqlite3', ['-json', database, source], { encoding: 'utf8' }).trim();
  const before = query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
  const checks: string[] = [];
  try {
    await oldWriter.platformSetting.create({ data: { key: 'synthetic-writer', value_json: '{"before":true}' } });
    const locker = spawn('/usr/bin/sqlite3', [database], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const ready = new Promise<void>((resolve, reject) => {
      locker.stdout.on('data', data => { output += String(data); if (output.includes('READY')) resolve(); });
      locker.stderr.on('data', data => { error += String(data); });
      locker.once('error', reject);
      locker.once('exit', code => { if (!output.includes('READY')) reject(Error(`Synthetic writer exited before lock: ${code} ${error}`)); });
    });
    locker.stdin.write("BEGIN IMMEDIATE; UPDATE PlatformSetting SET value_json='{}' WHERE key='synthetic-writer'; SELECT 'READY';\n");
    try {
      await ready;
      assert.throws(() => execFileSync('/usr/bin/sqlite3', [database], {
        input: `.timeout 100\n.bail on\nBEGIN IMMEDIATE;\n${sql}\nCOMMIT;\n`, stdio: ['pipe', 'pipe', 'pipe'],
      }), /locked/);
      assert.equal(query("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'CanvasRole%'"), '[{"count":0}]');
      checks.push('A busy old writer causes additive transaction to abort without table creation');
    } finally {
      const closed = new Promise<void>(resolve => locker.once('close', () => resolve()));
      locker.stdin.end('ROLLBACK;\n.quit\n'); await closed;
    }
    const changes = execFileSync('/usr/bin/sqlite3', [database], { input: `.bail on\n.timeout 2000\nBEGIN IMMEDIATE;\n${sql}\nSELECT total_changes();\nCOMMIT;\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(changes.trim(), '0');
    const after = query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'CanvasRole%' ORDER BY type,name");
    assert.equal(after, before);
    assert.equal(query("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'CanvasRole%'"), '[{"count":10}]');
    assert.equal(query("SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name LIKE 'CanvasRole%'"), '[{"count":15}]');
    checks.push('Exact locked ten-table/fifteen-index SQL preserves every old table/index definition');
    await oldWriter.platformSetting.update({ where: { key: 'synthetic-writer' }, data: { value_json: '{"after":true}' } });
    assert.equal((await oldWriter.platformSetting.findUnique({ where: { key: 'synthetic-writer' } })).value_json, '{"after":true}');
    checks.push('A live generated ea7 Prisma client still reads and writes the old schema after additive DDL');
    await oldWriter.user.create({ data: { id: 'synthetic-delete', name: 'Synthetic', username: 'synthetic-delete', email: 'synthetic@invalid.test', password_hash: 'synthetic' } });
    await oldWriter.creditAccount.create({ data: { user_id: 'synthetic-delete', balance: 7 } });
    query("INSERT INTO CanvasRoleDefinition(id,owner_user_id,name,updated_at) VALUES('synthetic-role','synthetic-delete','Synthetic',CURRENT_TIMESTAMP);");
    await oldWriter.user.delete({ where: { id: 'synthetic-delete' } });
    assert.equal(await oldWriter.creditAccount.count({ where: { user_id: 'synthetic-delete' } }), 0);
    assert.equal(query("SELECT count(*) AS count FROM CanvasRoleDefinition WHERE id='synthetic-role'"), '[{"count":1}]');
    checks.push('New role soft owner references do not prevent old account deletion or old credit cascade');
    assert.equal(query('PRAGMA quick_check;'), '[{"quick_check":"ok"}]');
    console.log(checks.map(c => `PASS ${c}`).join('\n'));
  } finally {
    await oldWriter.$disconnect();
    writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ syntheticOnly: true, productionWrites: 0, realProviderCalls: 0, checks }, null, 2), { mode: 0o600 });
    console.log(`Evidence: ${path.join(dir, 'receipt.json')}`);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
