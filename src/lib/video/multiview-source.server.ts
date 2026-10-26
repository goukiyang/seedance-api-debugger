import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, stat, statfs, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, MultiviewSource } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { currentMultiviewActor, assertMultiviewWorkSource, MultiviewWorkError } from './multiview-works';
import type { MultiviewInfo } from './multiview-contract';
import type { MultiviewSourceAccess } from './multiview-work-contract';

type Db = Prisma.TransactionClient;
export const MULTIVIEW_SOURCE_LIMIT = 128 * 1024 * 1024;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new MultiviewWorkError('来源视频暂不可读取，方案与原文件保持不变。', 503, 'WORK_SOURCE_UNAVAILABLE');

export async function multiviewSourceRoot() {
  if (process.env.NODE_ENV === 'production') {
    const [data, system] = await Promise.all([stat('/data'), stat('/')]);
    if (!data.isDirectory() || data.dev === system.dev) throw unavailable();
  }
  const root = process.env.NODE_ENV === 'production' ? '/data/video-api-debugger/var-lib/storage/multiview-sources'
    : path.join(process.cwd(), '.cache', 'multiview-sources');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw unavailable();
  return root;
}

export async function readPrivateMultiviewSource(row: MultiviewSource) {
  const root = await multiviewSourceRoot();
  if (!/^[a-zA-Z0-9_-]+\.mp4$/.test(row.file_path) || row.file_bytes < 1 || row.file_bytes > MULTIVIEW_SOURCE_LIMIT) throw unavailable();
  const file = path.join(root, row.file_path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== row.file_bytes) throw unavailable();
    const bytes = await handle.readFile();
    if (bytes.length !== row.file_bytes || hash(bytes) !== row.file_sha256) throw unavailable();
    return { file, bytes };
  } finally { await handle.close(); }
}

export async function assertMultiviewShareAccess(user: SessionUser, shareId: string, db: Db = prisma) {
  await currentMultiviewActor(user, db);
  const share = await db.multiviewShare.findUnique({ where: { id: shareId } });
  if (!share || share.revoked_at) throw new AuthError('分享已停止或不可访问。', 404);
  const work = await db.multiviewWork.findUnique({ where: { id: share.work_id } });
  if (!work || work.owner_id !== share.owner_id || work.removed_at) throw new AuthError('分享方案已移出或不可访问。', 404);
  const recipient = await db.multiviewShareRecipient.findUnique({ where: { share_id_user_id: { share_id: shareId, user_id: user.id } } });
  if (share.owner_id !== user.id && (!recipient || recipient.revoked_at)) throw new AuthError('当前账号未获此链接授权。', 403);
  // The author's current source authority remains necessary for a live grant;
  // a successfully committed independent copy no longer takes this path.
  const { multiviewWorkActor } = await import('./multiview-works');
  const author = await multiviewWorkActor(share.owner_id, db);
  if (!work.source_id) {
    const task = await assertMultiviewWorkSource(author, work.source_task_id, db);
    if ((task.owner_user_id || task.user_id) !== author.id) throw new AuthError('来源转授权限已变化。', 403);
    if (task.project_id) {
      const project = await db.project.findUnique({ where: { id: task.project_id } });
      if (!project || project.owner_user_id !== author.id) throw new AuthError('项目来源转授权限已变化。', 403);
    }
  }
  else {
    const source = await db.multiviewSource.findUnique({ where: { id: work.source_id } });
    if (!source || source.owner_id !== author.id || !source.can_reshare) throw new AuthError('来源不允许再次转授。', 403);
  }
  return { share, recipient, generation: recipient?.generation || `owner-${share.id}` };
}

export async function assertMultiviewSourceReference(user: SessionUser, row: { owner_id: string; source_task_id: string; source_id: string | null }, db: Db = prisma) {
  await currentMultiviewActor(user, db);
  if (row.owner_id !== user.id) throw new AuthError('无权读取此方案。', 403);
  if (!row.source_id) { await assertMultiviewWorkSource(user, row.source_task_id, db); return null; }
  const source = await db.multiviewSource.findUnique({ where: { id: row.source_id } });
  if (!source || source.owner_id !== user.id || source.origin_task_id !== row.source_task_id) throw new AuthError('独立来源不存在或不可访问。', 404);
  return source;
}

export async function resolveMultiviewSourceAccess(user: SessionUser, taskId: string, access: MultiviewSourceAccess) {
  let source: MultiviewSource | null, generation: string;
  if (access.kind === 'work') {
    const work = await prisma.multiviewWork.findUnique({ where: { id: access.id } });
    if (!work || work.source_task_id !== taskId || work.removed_at) throw new AuthError('方案来源不可访问。', 404);
    source = await assertMultiviewSourceReference(user, work);
    generation = `work:${user.id}:${work.id}:${work.revision}`;
    if (!source) return null;
  } else {
    const allowed = await assertMultiviewShareAccess(user, access.id);
    if (allowed.share.source_task_id !== taskId || !allowed.share.source_id) throw new AuthError('分享来源不可访问。', 404);
    source = await prisma.multiviewSource.findUnique({ where: { id: allowed.share.source_id } });
    if (!source || source.owner_id !== allowed.share.owner_id || source.source_version !== allowed.share.source_version) throw unavailable();
    generation = `share:${user.id}:${access.id}:${allowed.generation}`;
  }
  const file = await readPrivateMultiviewSource(source);
  return { source: file.file, local: file.file, version: source.source_version,
    cacheKey: hash(`${generation}:${source.source_version}`), info: JSON.parse(source.info_json) as MultiviewInfo };
}

/** Staging is bounded to one immutable file per durable operation. Binding
 * happens only in the caller's fresh-authority transaction after this returns. */
export async function stageMultiviewSource(input: { ownerId: string; operationId: string; taskId: string; info: MultiviewInfo; file: string; canReshare: boolean }) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(input.operationId)) throw unavailable();
  const root = await multiviewSourceRoot();
  const fileName = `${hash(`${input.ownerId}:${input.operationId}`)}.mp4`;
  const id = `mvs_${hash(`${input.ownerId}:${input.operationId}`).slice(0, 48)}`;
  const handle = await open(input.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MULTIVIEW_SOURCE_LIMIT) throw unavailable();
    const space = await statfs(root);
    if (space.bavail * space.bsize < metadata.size + 512 * 1024 * 1024) throw new MultiviewWorkError('保存空间不足，未建立独立方案。', 503, 'WORK_SOURCE_SPACE');
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.size !== metadata.size) throw unavailable();
  } finally { await handle.close(); }
  const target = path.join(root, fileName), temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const output = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
    await rename(temporary, target);
    const directory = await open(root, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
  const row = { id, owner_id: input.ownerId, origin_task_id: input.taskId, source_version: input.info.sourceVersion,
    info_json: JSON.stringify(input.info), file_path: fileName, file_sha256: hash(bytes), file_bytes: bytes.length, can_reshare: input.canReshare };
  await readPrivateMultiviewSource({ ...row, created_at: new Date() });
  return row;
}
