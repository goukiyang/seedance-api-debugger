import './server-runtime.cjs';
import { loadEnvConfig } from '@next/env';
import { runVideoSaveProcess, VIDEO_SAVE_RESULT_PREFIX } from '../src/lib/video/save-lock';

function report(result: unknown) {
  return new Promise<void>((resolve, reject) => process.stdout.write(VIDEO_SAVE_RESULT_PREFIX + JSON.stringify(result) + '\n',
    error => error ? reject(error) : resolve()));
}

async function main() {
  loadEnvConfig(process.cwd());
  const [kind, taskId, source, encoded, ...extra] = process.argv.slice(2);
  if (extra.length || !encoded || encoded.length > 8192) throw new Error('VIDEO_SAVE_ARGUMENTS_INVALID');
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());
  process.stdin.resume(); process.stdin.once('end', () => abort.abort());
  const result = await runVideoSaveProcess(kind, taskId, source, JSON.parse(Buffer.from(encoded, 'base64url').toString()), abort.signal);
  await report(result);
}
void main().then(async () => { await (await import('../src/lib/prisma')).prisma.$disconnect(); process.exit(0); }, async error => {
  const text = error instanceof Error ? error.message : '';
  const code = /^VIDEO_SAVE_[A-Z_]+$/.test(text) ? text : /下载超时|下载停滞/.test(text) ? 'VIDEO_SAVE_TIMEOUT' : 'VIDEO_SAVE_FAILED';
  const safe = /^(下载超时|视频下载停滞|MP4 文件不可读|下载后的视频文件|视频文件写入不完整)/.test(text)
    ? text : code === 'VIDEO_SAVE_SOURCE_CHANGED' ? '原视频来源已变化，保存已停止。'
      : code === 'VIDEO_SAVE_LEASE_LOST' ? '原保存已停止，请继续核对原任务。' : '视频保存未完成，请核对原任务。';
  await report({ success: false, error: code, message: safe,
    status: code === 'VIDEO_SAVE_TIMEOUT' ? 408 : code === 'VIDEO_SAVE_SOURCE_CHANGED' || code === 'VIDEO_SAVE_LEASE_LOST' ? 409 : 502 });
  await (await import('../src/lib/prisma')).prisma.$disconnect(); process.exit(0);
});
