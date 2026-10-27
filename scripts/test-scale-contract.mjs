import { spawnSync } from 'node:child_process';

if (process.platform !== 'linux' || !/^\/data\/video-api-debugger\/managed-releases\/[a-f0-9]{40}$/.test(process.cwd())) {
  throw new Error('Run native scale contracts only inside the isolated Linux candidate');
}
for (const args of [
  ['scripts/test-audit-scale-db-hd.mjs'],
  ['scripts/test-audit-strict-readonly.cjs'],
  ['--import', 'tsx', 'scripts/verify-audit-scale-db-hd-server.ts'],
  ['--import', 'tsx', 'scripts/verify-task-seedance-pagination-server.cjs'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: {
    ...process.env, NODE_ENV: 'test', SD2_DATABASE_MODE: 'writer', AUD_SCALE_SYNTHETIC_SERVER: '1', AUD_TASK_PAGE_SYNTHETIC_SERVER: '1',
  } });
  if (result.error || result.status !== 0) { process.exitCode = 1; break; }
}
