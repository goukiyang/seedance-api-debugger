import assert from 'node:assert/strict';
import sharp from '../src/lib/media/sharp';
import { AvatarError, customAvatarUrl, parseAvatarCrop, renderAvatar, restoreAvatar } from '../src/lib/avatar';

async function main() {
  // Crop must be square and at least 128px; garbage is refused.
  assert.deepEqual(parseAvatarCrop({ x: 10.4, y: 0, width: 300, height: 301 }), { x: 10, y: 0, width: 300, height: 300 });
  assert.throws(() => parseAvatarCrop({ x: 0, y: 0, width: 100, height: 100 }), /太小/);
  assert.throws(() => parseAvatarCrop({ x: 0, y: 0, width: 400, height: 200 }), /正方形/);
  assert.throws(() => parseAvatarCrop({ x: -1, y: 0, width: 200, height: 200 }), /无效/);
  // Both sizes come from the original pixels.
  const original = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#3366cc' } }).png().toBuffer();
  const { large, small } = await renderAvatar(original, { x: 100, y: 100, width: 600, height: 600 });
  const [l, s] = await Promise.all([sharp(large).metadata(), sharp(small).metadata()]);
  assert.equal(l.format, 'webp'); assert.equal(l.width, 512); assert.equal(s.width, 128);
  await assert.rejects(renderAvatar(original, { x: 900, y: 0, width: 600, height: 600 }), /超出/);
  // Only yourself; an admin may only reset someone else to the Feishu photo (checked before any DB access).
  await assert.rejects(restoreAvatar({ id: 'a', role: 'user' }, 'b', 'feishu'), (error: unknown) => error instanceof AvatarError && error.status === 403);
  await assert.rejects(restoreAvatar({ id: 'a', role: 'admin' }, 'b', 'initials'), (error: unknown) => error instanceof AvatarError && error.status === 403);
  assert.match(customAvatarUrl('u1', 'a'.repeat(32)), /^\/api\/avatars\/u1\?v=a{12}$/);
  console.log('avatar smoke: ok');
}
main().catch(error => { console.error(error); process.exit(1); });
