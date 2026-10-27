'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixturePlan(root, runId) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) throw new Error('Use --run with a new safe synthetic run ID');
  const directory = path.join(path.resolve(root), '.role-tests', 'media-fixtures', runId);
  return { runId, directory, database: path.join(directory, 'audit-media.db'), databaseUrl: `file:${path.join(directory, 'audit-media.db')}` };
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('Prepare a new fenced synthetic DB only: node scripts/prepare-audit-media-fixture.cjs --run <new-run-id>');
    console.log('No existing DB, old evidence, source file or production configuration is overwritten. Requires installed Prisma CLI and a generated platform-matched client.');
    return;
  }
  if (argv.length !== 2 || argv[0] !== '--run') throw new Error('Expected --run <new-run-id>');
  const root = process.cwd(), plan = fixturePlan(root, argv[1]);
  if (!fs.existsSync(path.join(root, 'prisma', 'schema.prisma'))) throw new Error('Run from the isolated candidate root');
  for (const component of ['.role-tests', '.role-tests/media-fixtures']) {
    const directory = path.join(root, component);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('Fixture parent must be a real isolated directory');
  }
  if (fs.existsSync(plan.directory)) throw new Error('Run directory already exists; choose a new run ID. Prior evidence is preserved.');
  fs.mkdirSync(plan.directory, { mode: 0o700 });
  new (require('node:sqlite').DatabaseSync)(plan.database).close();
  const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DATABASE_URL: plan.databaseUrl, NODE_ENV: 'test', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });
  fs.writeFileSync(path.join(plan.directory, 'prepare.log'), `${result.stdout || ''}${result.stderr || ''}${result.error?.message || ''}`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(plan.directory, 'prepare.json'), JSON.stringify({ ...plan, syntheticOnly: true, existingDatabaseReused: false,
    exitCode: result.status, error: result.error?.message || null }, null, 2), { flag: 'wx', mode: 0o600 });
  if (result.status !== 0) throw new Error(`Synthetic schema preparation failed; inspect ${plan.directory}/prepare.log. No automatic cleanup/retry performed.`);
  const quotedDatabase = `'${plan.databaseUrl.replaceAll("'", "'\\''")}'`;
  console.log(JSON.stringify({ ...plan, next: [
    `MEDIA_FIXTURE_RUN_ID=${plan.runId} DATABASE_URL=${quotedDatabase} MEDIA_TEST_PHASE=server-first node --import tsx scripts/test-audit-media.ts`,
    `MEDIA_FIXTURE_RUN_ID=${plan.runId} DATABASE_URL=${quotedDatabase} MEDIA_TEST_PHASE=server-replay node --import tsx scripts/test-audit-media.ts`,
  ] }, null, 2));
}

module.exports = { fixturePlan };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
