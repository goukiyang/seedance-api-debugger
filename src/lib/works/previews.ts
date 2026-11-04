import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { assertMultiviewWorkConsumerLock, multiviewWorkAdmission } from '@/lib/video/multiview-work-render';
import { claimWorkRegistrationJob, failWorkRegistrationJob, workRegistrationLeaseWhere } from './ingestion';
import { worksRegistrationPaused, worksSchemaReady } from './source-policy';
import { openWorkStoredVideo, type WorkStoredVideoOrigin, type WorkStoredVideoTask } from './video-storage';
import { resolveExistingWorkVideoPoster, WORK_PREVIEW_MAX_BYTES as MAX_BYTES, workPreviewRootPath as rootPath } from './preview-files';
export { resolveWorkPreviewFile } from './preview-files';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function secureDirectory(directory: string) {
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const item = await fs.lstat(current);
    if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('WORKS_PREVIEW_STORAGE_INVALID');
  }
  await fs.chmod(directory, 0o700);
}
async function localSource(reference: string) {
  const relative = siteUploadPathFromUrl(reference) || (/^\/videos\/[a-zA-Z0-9_./-]+$/.test(reference) ? reference : null);
  if (!relative) throw new Error('WORKS_PREVIEW_LOCAL_SOURCE_REQUIRED');
  const candidate = path.resolve(process.cwd(), 'public', relative.slice(1));
  const actual = await fs.realpath(candidate);
  const roots = await Promise.all(['videos', 'uploads'].map(name => fs.realpath(path.join(process.cwd(), 'public', name)).catch(() => null)));
  if (!roots.some(root => root && actual.startsWith(root + path.sep))) throw new Error('WORKS_PREVIEW_SOURCE_INVALID');
  const entry = await fs.lstat(actual);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 1 || entry.size > 2 * 1024 ** 3) throw new Error('WORKS_PREVIEW_SOURCE_INVALID');
  const handle = await fs.open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = await handle.stat();
  if (entry.ino !== opened.ino || entry.dev !== opened.dev || entry.size !== opened.size) { await handle.close(); throw new Error('WORKS_PREVIEW_SOURCE_CHANGED'); }
  return { handle, before: opened };
}
async function run(binary: string, args: string[], fd: number, signal: AbortSignal, timeout: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe', fd], signal });
    let stdout = '', count = 0, overflow = false, spawnError: Error | null = null;
    let abortTimer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => { abortTimer = setTimeout(() => child.kill('SIGKILL'), 2000); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout!.on('data', chunk => { count += chunk.length; if (count > 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } else stdout += chunk.toString(); });
    child.stderr!.on('data', chunk => { count += chunk.length; if (count > 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } });
    // The shared media slot is released only after the encoder has actually exited.
    child.once('error', error => { spawnError = error; });
    child.once('close', code => {
      clearTimeout(timer); if (abortTimer) clearTimeout(abortTimer);
      signal.removeEventListener('abort', abort);
      if (code === 0 && !overflow && !spawnError && !signal.aborted) resolve(stdout);
      else reject(spawnError || new Error('WORKS_PREVIEW_ENCODER_DEFERRED'));
    });
  });
}
function probeInfo(raw: string) {
  const info = JSON.parse(raw), stream = info.streams?.find((item: { codec_type?: string }) => item.codec_type === 'video');
  const duration = Number(info.format?.duration), width = Number(stream?.width), height = Number(stream?.height);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new Error('WORKS_PREVIEW_MEDIA_INVALID');
  return { duration, width, height };
}
const probeArgs = (input: string) => ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', input];

type PosterCandidate = { work_id: string; id: string | null; task_id: string | null; source_url: string | null; source_updated_at: Date | null };

/** Idle worker pass. At most one frame is encoded and no remote original is fetched. */
async function processWorkPosterPass(signal: AbortSignal) {
  const key = 'video_poster:v1';
  const checkpoint = await prisma.workDiscoveryCheckpoint.findUnique({ where: { source_kind: key } });
  if (checkpoint?.upper_at && checkpoint.upper_at > new Date()) return { state: 'empty' };
  const page = await prisma.$queryRaw<PosterCandidate[]>`WITH page AS MATERIALIZED (
    SELECT id, current_version_id, discoverable, withdrawn_at FROM Work
    WHERE id < ${checkpoint?.cursor_id || '\uffff'} ORDER BY id DESC LIMIT 24
  )
  SELECT page.id AS work_id, v.id, v.video_task_id AS task_id, v.source_url, v.source_updated_at FROM page
  LEFT JOIN WorkMediaVersion v ON v.id = page.current_version_id AND v.work_id = page.id
    AND page.discoverable = 1 AND page.withdrawn_at IS NULL AND v.thumbnail_url IS NULL
    AND v.video_task_id IS NOT NULL AND v.source_url LIKE '/videos/%'
  ORDER BY page.id DESC`;
  let cursor = checkpoint?.cursor_id || null;
  let encoded = false;
  for (const entry of page) {
    if (signal.aborted) return { state: 'yielded' };
    cursor = entry.work_id;
    if (!entry.id || !entry.task_id || !entry.source_url || !entry.source_updated_at ||
      await resolveExistingWorkVideoPoster(entry.task_id, entry.source_url, entry.source_updated_at)) continue;
    const input = await localSource(entry.source_url).catch(() => null);
    if (!input) continue;
    let temporary: string | null = null;
    try {
      await multiviewWorkAdmission();
      const root = rootPath(), directory = path.join(root, entry.id);
      await secureDirectory(directory);
      const disk = await fs.statfs(directory);
      if (disk.bavail * disk.bsize < 5 * 1024 ** 3) throw new Error('WORKS_PREVIEW_RESOURCE_WAIT');
      temporary = path.join(directory, `.poster-${randomUUID()}.jpg`);
      await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
        '-ss', '0.25', '-i', '/proc/self/fd/3', '-frames:v', '1', '-vf', "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease",
        '-threads', '1', '-q:v', '5', temporary], input.handle.fd, signal, 12_000);
      const after = await input.handle.stat(), output = await fs.stat(temporary);
      if (signal.aborted || after.ino !== input.before.ino || after.size !== input.before.size ||
        after.mtimeMs !== input.before.mtimeMs || after.ctimeMs !== input.before.ctimeMs ||
        output.size < 4 || output.size > 8 * 1024 ** 2) throw new Error('WORKS_POSTER_SOURCE_CHANGED');
      const poster = path.join(directory, 'poster.jpg');
      await fs.chmod(temporary, 0o600); await fs.rename(temporary, poster); temporary = null;
      await assertMultiviewWorkConsumerLock();
      const updated = await prisma.$executeRaw`UPDATE WorkMediaVersion SET thumbnail_url = ${poster}
        WHERE id = ${entry.id} AND thumbnail_url IS NULL AND EXISTS (
          SELECT 1 FROM Work w JOIN VideoTask t ON t.id = ${entry.task_id}
          WHERE w.id = ${entry.work_id} AND w.current_version_id = ${entry.id} AND w.withdrawn_at IS NULL
            AND w.discoverable = 1 AND t.local_video_path = ${entry.source_url} AND t.local_status = 'succeeded'
            AND t.retention_status IN ('active','retained')
            AND COALESCE(t.public_video_cached_at,t.delivery_completed_at) = ${entry.source_updated_at})`;
      encoded = updated === 1;
    } catch (error) {
      if (signal.aborted) return { state: 'yielded' };
      if (!(error instanceof Error) || !['WORKS_PREVIEW_ENCODER_DEFERRED', 'WORKS_POSTER_SOURCE_CHANGED'].includes(error.message)) throw error;
    } finally {
      await input.handle.close();
      if (temporary) await fs.rm(temporary, { force: true });
    }
    break; // Keep full preview jobs and multi-view saves ahead of historical poster work.
  }
  if (signal.aborted) return { state: 'yielded' };
  const finished = !page.length || page.length < 24 && cursor === page[page.length - 1].work_id;
  const data = { cursor_id: finished ? null : cursor, upper_at: finished ? new Date(Date.now() + 60 * 60_000) : null };
  await prisma.workDiscoveryCheckpoint.upsert({ where: { source_kind: key }, create: { source_kind: key, ...data }, update: data });
  return { state: encoded ? 'poster-pass' : 'empty' };
}

/** Called only by the existing multiview consumer while holding its cross-release flock. No GET ever encodes. */
export async function processNextWorkPreview(options: { signal?: AbortSignal } = {}) {
  if (options.signal?.aborted) return { state: 'yielded' };
  if (!await worksSchemaReady() || await worksRegistrationPaused()) return { state: 'paused' };
  await assertMultiviewWorkConsumerLock();
  const job = await claimWorkRegistrationJob(['media_preview'], 90_000);
  if (!job) return processWorkPosterPass(options.signal ?? new AbortController().signal);
  const controller = new AbortController();
  const yieldPreview = () => controller.abort();
  options.signal?.addEventListener('abort', yieldPreview, { once: true });
  if (options.signal?.aborted) yieldPreview();
  let renewal: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (!renewal) renewal = prisma.workRegistrationJob.updateMany({ where: workRegistrationLeaseWhere(job), data: { lease_until: new Date(Date.now() + 90_000) } })
      .then(result => { if (result.count !== 1) controller.abort(); }).catch(() => controller.abort()).finally(() => { renewal = null; });
  }, 20_000);
  let source: Awaited<ReturnType<typeof localSource>> | null = null;
  let temporary: string | null = null, stagedOriginal: string | null = null;
  let remote: WorkStoredVideoOrigin | null = null, remoteTask: WorkStoredVideoTask | null = null;
  try {
    const version = await prisma.workMediaVersion.findUnique({ where: { id: job.source_id }, include: { work: true } });
    if (!version || !version.source_url || version.work.current_version_id !== version.id || !version.video_task_id && !version.asset_id) {
      await prisma.workRegistrationJob.updateMany({ where: workRegistrationLeaseWhere(job), data: { status: 'superseded', lease_token: null, lease_until: null } });
      return { state: 'superseded' };
    }
    await multiviewWorkAdmission(); // Reuse the single consumer's load/memory/data-mount/free-space policy.
    const root = rootPath();
    await secureDirectory(root);
    const disk = await fs.statfs(root);
    if (disk.bavail * disk.bsize < 5 * 1024 ** 3 + MAX_BYTES) throw new Error('WORKS_PREVIEW_RESOURCE_WAIT');
    const directory = path.join(root, version.id);
    await secureDirectory(directory);
    try { source = await localSource(version.source_url); }
    catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (version.work.medium !== 'video' || !version.video_task_id
        || !missing && (!(error instanceof Error) || error.message !== 'WORKS_PREVIEW_LOCAL_SOURCE_REQUIRED')) throw error;
      const fresh = await prisma.workMediaVersion.findUnique({ where: { id: version.id }, include: { work: true } });
      const task = await prisma.videoTask.findUnique({ where: { id: version.video_task_id } });
      if (!fresh || fresh.work.current_version_id !== version.id || fresh.source_url !== version.source_url
        || fresh.source_updated_at?.getTime() !== version.source_updated_at?.getTime() || !task || !version.source_updated_at
        || !missing && (task.local_video_path !== null || task.public_video_url !== version.source_url)) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
      remoteTask = task;
      remote = await openWorkStoredVideo(task, { videoTaskId: version.video_task_id, sourceUrl: version.source_url, sourceUpdatedAt: version.source_updated_at }, controller.signal);
      const capacity = await fs.statfs(root);
      if (remote.size > 2 * 1024 ** 3 || capacity.bavail * capacity.bsize < 5 * 1024 ** 3 + MAX_BYTES + remote.size) throw new Error('WORKS_PREVIEW_RESOURCE_WAIT');
      stagedOriginal = path.join(directory, `.original-${randomUUID()}.mp4`);
      const handle = await fs.open(stagedOriginal, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      source = { handle, before: await handle.stat() };
      let count = 0;
      const deadline = setTimeout(() => controller.abort(), 60_000);
      try {
        const stream = await remote.stream();
        for await (const chunk of stream) {
          count += chunk.byteLength;
          if (controller.signal.aborted || count > remote.size) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
            if (written < 1) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
            offset += written;
          }
        }
        if (count !== remote.size || controller.signal.aborted || !await remote.current()) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
        source.before = await handle.stat();
      } finally { clearTimeout(deadline); }
    }
    if (version.work.medium === 'image' && version.asset_id) {
      if (source.before.size > 256 * 1024 ** 2) throw new Error('WORKS_PREVIEW_TOO_LARGE');
      const bytes = await source.handle.readFile();
      if (version.content_hash && hash(bytes) !== version.content_hash) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
      const posterBytes = await sharp(bytes, { animated: false, limitInputPixels: 64_000_000, failOn: 'warning' }).timeout({ seconds: 45 })
        .rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      const after = await source.handle.stat();
      if (after.size !== source.before.size || after.mtimeMs !== source.before.mtimeMs || after.ctimeMs !== source.before.ctimeMs) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
      const poster = path.join(directory, 'poster.webp');
      temporary = path.join(directory, `.prepare-${randomUUID()}.webp`);
      await fs.writeFile(temporary, posterBytes, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, poster); temporary = null;
      await assertMultiviewWorkConsumerLock();
      if (controller.signal.aborted) throw new Error('WORKS_PREVIEW_LEASE_LOST');
      await prisma.$transaction(async db => {
        if (!await db.workRegistrationJob.findFirst({ where: workRegistrationLeaseWhere(job) })) throw new Error('WORKS_PREVIEW_LEASE_LOST');
        const current = await db.work.findUnique({ where: { id: version.work_id }, select: { current_version_id: true } });
        if (current?.current_version_id !== version.id) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
        const asset = await db.asset.findUnique({ where: { id: version.asset_id! } });
        if (!asset || asset.status !== 'active' || asset.type !== 'image' || asset.original_url !== version.source_url
          || asset.hash !== version.content_hash) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
        await db.workMediaVersion.update({ where: { id: version.id }, data: { thumbnail_url: poster, preview_status: 'ready', preview_hash: hash(posterBytes) } });
        await db.workRegistrationJob.updateMany({ where: workRegistrationLeaseWhere(job), data: { status: 'done', error_code: null, lease_token: null, lease_until: null } });
      });
      return { state: 'ready' };
    }
    if (version.work.medium !== 'video') throw new Error('WORKS_PREVIEW_SOURCE_INVALID');
    const binary = process.env.FFMPEG_PATH || 'ffmpeg', probe = process.env.FFPROBE_PATH || 'ffprobe';
    const info = probeInfo(await run(probe, probeArgs('/proc/self/fd/3'), source.handle.fd, controller.signal, 15_000));
    temporary = path.join(directory, `.prepare-${randomUUID()}.mp4`);
    await run(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', '/proc/self/fd/3',
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '48k', '-ac', '2',
      '-movflags', '+faststart', '-map_metadata', '-1', '-fs', String(MAX_BYTES), temporary], source.handle.fd, controller.signal, 4 * 60_000);
    await fs.chmod(temporary, 0o600);
    const generated = await fs.open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    let previewBytes: Buffer;
    try {
      const output = probeInfo(await run(probe, probeArgs('/proc/self/fd/3'), generated.fd, controller.signal, 15_000));
      if (output.duration < info.duration - Math.max(0.2, info.duration * 0.01) || output.width > 640 || output.height > 640) throw new Error('WORKS_PREVIEW_INCOMPLETE');
      const size = (await generated.stat()).size;
      if (!size || size > MAX_BYTES) throw new Error('WORKS_PREVIEW_TOO_LARGE');
      previewBytes = await generated.readFile();
    } finally { await generated.close(); }
    const poster = path.join(directory, 'poster.jpg');
    const cachedPoster = version.video_task_id && version.source_updated_at
      ? await resolveExistingWorkVideoPoster(version.video_task_id, version.source_url, version.source_updated_at) : null;
    let posterBytes = cachedPoster ? await fs.readFile(cachedPoster).catch(() => null) : null;
    if (!posterBytes) {
      const posterTemp = path.join(directory, `.poster-${randomUUID()}.jpg`);
      try {
        await run(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', '/proc/self/fd/3',
          '-frames:v', '1', '-vf', "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease", '-threads', '1', '-q:v', '5', posterTemp], source.handle.fd, controller.signal, 30_000);
        posterBytes = await fs.readFile(posterTemp);
      } finally { await fs.rm(posterTemp, { force: true }); }
    }
    const after = await source.handle.stat();
    if (source.before.ino !== after.ino || source.before.size !== after.size || source.before.mtimeMs !== after.mtimeMs || source.before.ctimeMs !== after.ctimeMs) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
    await fs.writeFile(poster, posterBytes, { mode: 0o600 });
    await fs.chmod(poster, 0o600);
    const preview = path.join(directory, 'preview.mp4');
    await fs.rename(temporary, preview); temporary = null;
    await assertMultiviewWorkConsumerLock();
    if (controller.signal.aborted) throw new Error('WORKS_PREVIEW_LEASE_LOST');
    if (remote && !await remote.current()) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
    await prisma.$transaction(async db => {
      if (!await db.workRegistrationJob.findFirst({ where: workRegistrationLeaseWhere(job) })) throw new Error('WORKS_PREVIEW_LEASE_LOST');
      const current = await db.work.findUnique({ where: { id: version.work_id }, select: { current_version_id: true } });
      if (current?.current_version_id !== version.id) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
      if (version.video_task_id) {
        const task = await db.videoTask.findUnique({ where: { id: version.video_task_id } });
        const stamp = task?.public_video_cached_at || task?.delivery_completed_at;
        if (!task || isTaskHiddenFromRegularUsers(task) || task.local_status !== 'succeeded'
          || (task.local_video_path || task.public_video_url) !== version.source_url || stamp?.getTime() !== version.source_updated_at?.getTime()
          || remoteTask && (task.public_video_storage_provider !== remoteTask.public_video_storage_provider || task.public_video_storage_key !== remoteTask.public_video_storage_key
            || task.public_video_url !== remoteTask.public_video_url || task.public_video_file_size !== remoteTask.public_video_file_size
            || task.public_video_cached_at?.getTime() !== remoteTask.public_video_cached_at?.getTime())) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
      } else {
        const asset = await db.asset.findUnique({ where: { id: version.asset_id! } });
        if (!asset || asset.type !== 'video' || asset.status !== 'active' || asset.owner_id !== version.work.author_id
          || asset.original_url !== version.source_url || asset.hash !== version.content_hash) throw new Error('WORKS_PREVIEW_SOURCE_CHANGED');
      }
      await db.workMediaVersion.update({ where: { id: version.id }, data: { preview_url: preview, preview_status: 'ready', preview_hash: hash(previewBytes),
        thumbnail_url: poster, width: info.width, height: info.height, duration: info.duration } });
      await db.workRegistrationJob.updateMany({ where: workRegistrationLeaseWhere(job), data: { status: 'done', error_code: null, lease_token: null, lease_until: null } });
    });
    return { state: 'ready' };
  } catch {
    if (options.signal?.aborted) {
      // A ready collage gets the one heavy-media slot. This is a local pause,
      // never an upstream failure or a new generation request. Avoid retry churn.
      await prisma.workRegistrationJob.updateMany({ where: workRegistrationLeaseWhere(job), data: {
        status: 'pending', attempts: { decrement: 1 }, run_after: new Date(Date.now() + 60_000),
        error_code: 'WORKS_PREVIEW_YIELDED', lease_token: null, lease_until: null,
      } });
      return { state: 'yielded' };
    }
    await failWorkRegistrationJob(job, 'WORKS_PREVIEW_DEFERRED');
    return { state: 'deferred' };
  } finally {
    options.signal?.removeEventListener('abort', yieldPreview);
    clearInterval(timer); if (renewal) await renewal;
    if (temporary) await fs.rm(temporary, { force: true });
    try { await source?.handle.close(); }
    finally { try { await remote?.close(); } finally { if (stagedOriginal) await fs.rm(stagedOriginal, { force: true }); } }
  }
}
