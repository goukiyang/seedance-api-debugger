const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
class AuthError extends Error { constructor(message, status) { super(message); this.status = status; } }
const calls = [];
const forbidden = () => { throw Error('Unexpected database access in pure media resolution contract'); };
const deps = {
  '@/lib/auth/session': { AuthError }, '@/lib/prisma': { prisma: new Proxy({}, { get: forbidden }) },
  '@/lib/reference-albums/permissions': {}, '@/lib/image-studio/protected-assets': {},
  './site-url': { siteUploadBaseUrls: () => ['https://sd2.youdooart.com'], sameOriginPublicUrlForSiteUpload: () => null },
  '@/lib/access/media-policy': { MEDIA_TYPES: ['asset', 'reference', 'video-input'], assertMedia: async (user, ref, action) => {
    calls.push({ user, ref, action });
    if (ref.id === 'denied') throw new AuthError('Denied', 403);
    return { source: { kind: ref.id === 'audio' ? 'audio' : ref.id === 'image' ? 'image' : 'video', url: `/uploads/assets/${ref.id}.canonical` } };
  } },
};
const mod = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync('src/lib/assets/original-image-input.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(name => {
  assert.ok(Object.hasOwn(deps, name), name); return deps[name];
}, mod, mod.exports);
(async () => {
  const user = { id: 'owner' };
  const body = { reference_video_urls: ['/m/asset/video/preview?exp=expired&ticket=browser-only'],
    reference_audio_urls: ['/m/asset/audio/original'], reference_image_urls: ['/m/asset/image/preview'] };
  await mod.exports.resolveImageInputUrls(user, body);
  assert.deepEqual(body.reference_video_urls, ['/uploads/assets/video.canonical']);
  assert.deepEqual(body.reference_audio_urls, ['/uploads/assets/audio.canonical']);
  assert.deepEqual(body.reference_image_urls, ['/uploads/assets/image.canonical']);
  assert.equal(calls.find(row => row.ref.id === 'video').action, 'use');
  assert.equal(calls.find(row => row.ref.id === 'image').action, 'download-original');
  assert.equal(JSON.stringify(body).includes('ticket='), false);
  await assert.rejects(() => mod.exports.resolveImageInputUrls(user, { reference_video_urls: ['/m/asset/denied/preview'] }), { status: 403 });
  await assert.rejects(() => mod.exports.resolveImageInputUrls(user, { reference_audio_urls: ['/m/asset/video/preview'] }), { status: 400 });
  console.log('PASS video/audio use-only inputs resolve fresh identity without persisting expiring tickets; original image grants remain distinct');
})().catch(error => { console.error(error); process.exitCode = 1; });
