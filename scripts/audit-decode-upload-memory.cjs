const assert = require('node:assert/strict');
const fs = require('node:fs');
const { functions, load } = require('./audit-decode-upload-loader.cjs');
class VerifiedUploadError extends Error { constructor(code, message, status) { super(message); Object.assign(this, { code, status }); } }
const bytes = 200 * 1024 * 1024;
let produced = 0;
const body = new ReadableStream({ pull(controller) {
  if (produced === bytes) { controller.close(); return; }
  const chunk = new Uint8Array(64 * 1024); chunk.fill(7); produced += chunk.length; controller.enqueue(chunk);
} }, { highWaterMark: 1 });
const request = new Request('https://synthetic.invalid/upload', { method: 'POST', headers: { 'Content-Type': 'video/mp4', 'X-File-Size': String(bytes), 'X-File-Name': 'synthetic.mp4' }, body, duplex: 'half' });
const bindings = { VerifiedUploadError, NextResponse: { json: x => x }, validateSiteUploadMetadata: () => null, MULTIPART_COMPAT_MAX_SIZE_BYTES: 8 * 1024 * 1024 };
if (fs.existsSync('src/lib/assets/streamed-upload.ts')) Object.assign(bindings, load('src/lib/assets/streamed-upload.ts'));
const api = functions('src/app/api/assets/upload/route.ts', ['decodeFileName','parseContentLength','readBoundedBody','readUploadPayload'], bindings);
(async () => {
  global.gc?.(); const initial = process.memoryUsage().rss; let peak = initial;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
  let result;
  try { result = await api.readUploadPayload(request); peak = Math.max(peak, process.memoryUsage().rss); }
  finally { clearInterval(sampler); }
  if (result?.payload?.cleanup) await result.payload.cleanup();
  const delta = peak - initial;
  console.log(JSON.stringify({ bytes, produced, rssPeakDeltaBytes: delta, maximumBytes: 50 * 1024 * 1024, fileBacked: Boolean(result?.payload?.file) }));
  assert.ok(delta < 50 * 1024 * 1024, `200MiB actual upload reader RSS delta ${delta} must be below 50MiB`);
  assert.ok(result?.payload?.file, 'actual reader must return a temporary file, not a whole buffer');
})().catch(error => { console.error(error); process.exitCode = 1; });
