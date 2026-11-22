import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AuthError } from '@/lib/auth/session';
export const sourceDigest = 'ec22430289417474f6a64710bb58f8a261f901493af89ffc6053c3209444561a';
export const packageRoot = () => path.resolve(process.env.UI_DESIGN_PACKAGE || path.join(process.cwd(), '.private/ui-design', sourceDigest));
export async function privateManifest() {
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot(), 'manifest.json'), 'utf8'));
  if (manifest.sourceSha256 !== sourceDigest || manifest.schema !== 1) throw new AuthError('私有依赖版本不符', 503);
  return manifest;
}
export async function packageFile(name: string, browser = false) {
  const manifest = await privateManifest();
  if (!name || name.split('/').some(part => !part || part === '.' || part === '..') || name.includes('\\') || !Object.hasOwn(manifest.files, name) || browser && !manifest.publicFiles.includes(name)) throw new AuthError('文件不存在', 404);
  const root = await fs.realpath(packageRoot()), file = await fs.realpath(path.join(root, name));
  if (!file.startsWith(`${root}${path.sep}`)) throw new AuthError('文件不存在', 404);
  const bytes = await fs.readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name]) throw new AuthError('私有依赖校验失败', 503);
  return bytes;
}
export async function privateModule(name: string) {
  if (!/^[\w-]+\.(?:cjs|js)$/.test(name)) throw new AuthError('模块无效', 400);
  await packageFile(name);
  // Keep the native loader at runtime: Next transforms a dynamic createRequire import into undefined.
  const nativeModule = process.getBuiltinModule('node:module');
  return nativeModule.createRequire(path.join(packageRoot(), 'index.html'))(path.join(packageRoot(), name));
}
export async function sourceLibrary() {
  const record = JSON.parse((await packageFile('library/UIUX-ART.uiuxworkspace')).toString());
  return record.structureLibrary as import('./types').JsonObject[];
}
