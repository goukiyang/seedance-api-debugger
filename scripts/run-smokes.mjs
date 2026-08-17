#!/usr/bin/env node
/**
 * 统一 smoke 运行器
 *
 * 用法:
 *   node scripts/run-smokes.mjs               顺序运行全部 scripts/smoke/*-smoke.ts
 *   node scripts/run-smokes.mjs --list        只列出可用 smoke,不运行
 *   node scripts/run-smokes.mjs --only canvas 只运行文件名包含 "canvas" 的 smoke
 *   node scripts/run-smokes.mjs --only <kw> --list  列出匹配的 smoke
 *
 * 说明:
 * - 逐个通过 `npx tsx <file>` 顺序执行(避免并发写库/争用)。
 * - 单个失败不会中断整批;最后输出汇总,存在失败时以非 0 退出。
 * - 依赖本地 .env(数据库/密钥)与运行环境,部分 smoke 会写库或调用 provider,
 *   请按需用 --only 限定,不要无脑全跑。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SMOKE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'smoke');
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 && onlyIdx + 1 < args.length ? args[onlyIdx + 1].trim() : '';

const files = readdirSync(SMOKE_DIR)
  .filter((f) => f.endsWith('-smoke.ts') || f.endsWith('-smoke.mjs'))
  .filter((f) => !only || f.includes(only))
  .sort();

if (files.length === 0) {
  console.error(only ? `没有文件名包含 "${only}" 的 smoke` : '没有找到 smoke 文件');
  process.exit(only ? 2 : 1);
}

if (listOnly) {
  files.forEach((f) => console.log(f));
  console.log(`\n共 ${files.length} 个 smoke${only ? `(过滤:"${only}")` : ''}`);
  process.exit(0);
}

console.log(`开始顺序运行 ${files.length} 个 smoke...\n`);
const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const failed = [];
let passed = 0;

for (const file of files) {
  console.log(`\n▶ ${file}`);
  const result = spawnSync(npxBin, ['tsx', join(SMOKE_DIR, file)], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status === 0) {
    passed += 1;
    console.log(`✅ ${file}`);
  } else {
    failed.push(file);
    console.log(`❌ ${file} (exit ${result.status})`);
  }
}

console.log(`\n===== smoke 汇总:通过 ${passed}/${files.length} =====`);
if (failed.length > 0) {
  console.log('失败清单:');
  failed.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
