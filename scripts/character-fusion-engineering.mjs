import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/check-fusion-workspace.ts')], { cwd: root, encoding: 'utf8', env: { ...process.env, FUSION_ENGINEERING_ONLY: '1' }, maxBuffer: 8 * 1024 * 1024 });
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || String(result.error || '角色融合工程检查未完成。'));
  process.exit(result.status || 1);
}
const line = result.stdout.trim().split('\n').findLast(value => value.startsWith('{'));
if (!line) throw new Error('角色融合工程检查缺少 JSON 证据。');
const evidence = JSON.parse(line);
if (evidence.passed !== true) throw new Error('角色融合工程检查未通过。');
process.stdout.write(JSON.stringify(evidence) + '\n');
