import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseH3InternalOutputUrl, h3InternalOutputUrl } from '@/lib/provider/h3';

const localCacheSource = readFileSync('src/lib/video/local-cache.ts', 'utf8');
const finalizerSource = readFileSync('src/lib/video/task-finalizer.ts', 'utf8');

assert.deepEqual(parseH3InternalOutputUrl(h3InternalOutputUrl('h3-job-001', 0)), {
  jobId: 'h3-job-001',
  index: 0,
});
assert.equal(parseH3InternalOutputUrl('https://example.com/out.mp4'), null);

assert.match(localCacheSource, /parseH3InternalOutputUrl/, '本地缓存必须识别 H3 内部输出地址');
assert.match(localCacheSource, /downloadH3JobOutput/, 'H3 输出下载必须走后端 token 下载器');
assert.match(localCacheSource, /h3InternalOutput/, 'H3 输出不能把带 token 的真实 URL 暴露给前端');
assert.match(finalizerSource, /Retry-After|retryAfterSeconds|h3_request_failed/, 'H3 状态错误需要保留 Retry-After 或可恢复异常信息');

console.log('h3-finalizer-output smoke passed');
