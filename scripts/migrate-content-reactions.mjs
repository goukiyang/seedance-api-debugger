import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const database = args.includes('--database') ? option('--database') : '';
const backup = args.includes('--backup') ? option('--backup') : '';
if (!path.isAbsolute(database) || !fs.existsSync(database)) throw new Error('Use --database with an existing absolute SQLite path');
const sqlPath = fileURLToPath(new URL('../prisma/migrations/20260930120000_content_reactions/migration.sql', import.meta.url));
const sql = fs.readFileSync(sqlPath, 'utf8');
const quote = value => `'${value.replaceAll("'", "''")}'`;
const query = (sqlText, file = database) => execFileSync('sqlite3', ['-bail', '-readonly', file, sqlText], { encoding: 'utf8' }).trim();
const targetNames = ['ContentReaction', 'ContentReactionEvent'];
const schema = () => query("SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT IN ('ContentReaction','ContentReactionEvent','_prisma_migrations') ORDER BY type,name;");
const existing = query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ContentReaction','ContentReactionEvent') ORDER BY name;").split('\n').filter(Boolean);
if (existing.length && existing.length !== 2) throw new Error('Partial schema found; manual inspection required');
if (existing.length === 2) {
  for (const table of targetNames) {
    const expected = execFileSync('sqlite3', ['-bail', ':memory:', `${sql}\nPRAGMA table_info(${table});\nPRAGMA foreign_key_list(${table});\nSELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=${quote(table)} ORDER BY name;`], { encoding: 'utf8' }).trim();
    const actual = query(`PRAGMA table_info(${table});\nPRAGMA foreign_key_list(${table});\nSELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=${quote(table)} ORDER BY name;`);
    if (actual !== expected) throw new Error(`Existing ${table} differs from approved schema`);
  }
  console.log('Schema already present and matches; no changes made.');
  process.exit(0);
}
if (!args.includes('--apply')) {
  console.log('Plan only: add ContentReaction, ContentReactionEvent and their indexes. No existing data changes. Explicit migration authorization and --apply --backup are required.');
  process.exit(0);
}
if (!path.isAbsolute(backup) || fs.existsSync(backup) || backup === database) throw new Error('Use --backup with a new absolute backup path');
if (query('PRAGMA integrity_check;') !== 'ok') throw new Error('Database integrity check failed');
fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
execFileSync('sqlite3', ['-bail', '-readonly', database], { input: `.timeout 15000\n.backup ${quote(backup)}\n`, encoding: 'utf8' });
fs.chmodSync(backup, 0o600);
if (query('PRAGMA integrity_check;', backup) !== 'ok') throw new Error('Backup integrity check failed');
const before = schema();
let migrationRecord = '';
if (query("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='_prisma_migrations';") === '1') {
  const name = '20260930120000_content_reactions';
  if (query(`SELECT count(*) FROM _prisma_migrations WHERE migration_name=${quote(name)} AND rolled_back_at IS NULL;`) !== '0') throw new Error('Migration record exists without tables; manual inspection required');
  migrationRecord = `INSERT INTO _prisma_migrations (id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count) VALUES (${quote(randomUUID())},${quote(createHash('sha256').update(sql).digest('hex'))},CURRENT_TIMESTAMP,${quote(name)},NULL,NULL,CURRENT_TIMESTAMP,1);`;
}
execFileSync('sqlite3', ['-bail', database], { input: `.timeout 15000\nPRAGMA foreign_keys=ON;\nBEGIN IMMEDIATE;\n${sql}\n${migrationRecord}\nCOMMIT;`, encoding: 'utf8' });
if (before !== schema()) throw new Error('Unexpected existing-schema change; stop release and investigate, do not restore the whole database');
if (query('PRAGMA integrity_check;') !== 'ok') throw new Error('Post-migration integrity check failed');
console.log('Added two tables. Existing schema unchanged; backup and database integrity OK. Rollback code only; keep these tables and new records.');
