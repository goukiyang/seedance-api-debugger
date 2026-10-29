import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, openAsBlob } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareVideoFeishuSource, type PreparedVideoFeishuSource } from '../src/lib/video/feishu-source';

const execute = promisify(execFile);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

async function main() {
  assert.equal(process.platform, 'linux', 'This fixture checks real Linux file descriptors');
  assert.equal(typeof openAsBlob, 'function', 'Use the production Node runtime with native file Blobs');
  const repository = process.cwd();
  assert.equal(existsSync(path.join(repository, '.env')), false, 'Use an isolated source copy without a production .env');
  const sourceHash = digest(await readFile(path.join(repository, 'src/lib/video/feishu-source.ts')));
  const previousTmp = process.env.TMPDIR, previousNodeEnv = process.env.NODE_ENV;
  const root = await mkdtemp(path.join(tmpdir(), 'video-feishu-source-lifecycle-'));
  const videoRoot = path.join(root, 'public/videos'), privateRoot = path.join(root, 'tmp/video-feishu');
  const active = new Set<PreparedVideoFeishuSource>(), checks: string[] = [];
  const descriptors = async () => {
    const names = await readdir('/proc/self/fd');
    const targets = await Promise.all(names.map(async name => {
      try { return await readlink(path.join('/proc/self/fd', name)); } catch { return ''; }
    }));
    return targets.filter(target => target.startsWith(root + path.sep));
  };
  const privateDirectories = async () => {
    try { return (await readdir(privateRoot)).filter(name => name.startsWith('delivery-')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const clean = async () => {
    await delay(0);
    assert.deepEqual(await privateDirectories(), [], 'The preparation must remove its own private copies');
    assert.deepEqual(await descriptors(), [], 'All fixture source/copy file descriptors must be closed');
  };
  try {
    await mkdir(videoRoot, { recursive: true }); await mkdir(path.join(root, 'tmp'));
    process.env.TMPDIR = path.join(root, 'tmp'); Object.assign(process.env, { NODE_ENV: 'test' }); process.chdir(root);
    const seed = path.join(root, 'synthetic.mp4');
    await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=96x96:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', seed], { timeout: 15_000, maxBuffer: 64 * 1024 });
    const bytes = await readFile(seed);
    const fixture = async (content: Uint8Array = bytes, name: (id: string) => string = id => id + '.mp4') => {
      const id = 'f03-' + randomUUID(), filename = name(id), file = path.join(videoRoot, filename);
      await writeFile(file, content, { mode: 0o600 });
      const task = { id, user_id: 'synthetic-owner', owner_user_id: 'synthetic-owner', project_id: null,
        retention_status: 'active', source_metadata_json: null, local_status: 'succeeded', local_video_path: '/videos/' + filename,
        public_video_url: null, public_video_storage_provider: null, public_video_storage_key: null, public_video_file_size: null,
        public_video_cached_at: null, delivery_status: 'completed', delivery_error: null } as Parameters<typeof prepareVideoFeishuSource>[0];
      return { task, file };
    };
    const prepare = async (task: Parameters<typeof prepareVideoFeishuSource>[0], signal?: AbortSignal) => {
      const result = await prepareVideoFeishuSource(task, { signal }); active.add(result); return result;
    };
    const close = async (result: PreparedVideoFeishuSource) => { await result.close(); active.delete(result); };

    const complete = await fixture(), ready = await prepare(complete.task);
    assert.equal(ready.mode, 'video'); assert.ok(ready.video); assert.equal(ready.hash, digest(bytes));
    assert.equal(digest(new Uint8Array(await ready.video.arrayBuffer())), digest(bytes), 'The outgoing original stays byte-identical');
    assert.equal(await ready.current(), true, 'Normal EOF and media probing must retain the real source descriptor');
    assert.equal((await descriptors()).filter(target => target === complete.file).length, 1);
    await Promise.all([ready.close(), ready.close(), ready.close()]); await close(ready);
    assert.equal(await ready.current(), false); await clean(); checks.push('complete_mp4_eof_current_and_idempotent_close');

    const generated = await fixture(bytes, id => `${id}-${Date.now().toString(36)}-${process.pid}.mp4`);
    const generatedReady = await prepare(generated.task);
    assert.equal(generatedReady.mode, 'video'); assert.equal(await generatedReady.current(), true);
    assert.equal(generatedReady.hash, digest(bytes)); await close(generatedReady); await clean();
    checks.push('current_generation_filename_accepts_only_same_task');

    for (const suffix of ['-n0tvalid-0.mp4', '-UPPERCASE-123.mp4', '-time-1-extra.mp4', '-0-123.mp4']) {
      const invalidName = await fixture(bytes, id => id + suffix);
      await assert.rejects(prepare(invalidName.task), /original_not_ready/); await clean();
    }
    await assert.rejects(prepare({ ...generated.task, id: 'f03-' + randomUUID() }), /original_not_ready/);
    await assert.rejects(prepare({ ...complete.task, local_video_path: '/videos/../videos/' + path.basename(complete.file) }), /original_not_ready/);
    await clean(); checks.push('foreign_task_forged_suffix_and_traversal_rejected');

    const replaced = await fixture(), beforeReplacement = await prepare(replaced.task);
    await rename(replaced.file, replaced.file + '.held'); await writeFile(replaced.file, bytes);
    assert.equal(digest(await readFile(replaced.file)), beforeReplacement.hash);
    assert.equal(await beforeReplacement.current(), false, 'Equal bytes at a replaced inode are not the frozen source');
    await close(beforeReplacement); await clean(); checks.push('same_bytes_path_replacement_rejected');

    const edited = await fixture(), beforeEdit = await prepare(edited.task);
    await delay(2);
    const writer = await open(edited.file, 'r+');
    try { await writer.write(Buffer.from([bytes[bytes.length - 1] ^ 1]), 0, 1, bytes.length - 1); }
    finally { await writer.close(); }
    assert.equal((await stat(edited.file)).size, bytes.length);
    assert.equal(await beforeEdit.current(), false, 'Same-size edits must fail the real path/fd version check');
    await close(beforeEdit); await clean(); checks.push('same_size_content_change_rejected');

    const protectedFile = await fixture(), beforeModeChange = await prepare(protectedFile.task);
    await delay(2); await chmod(protectedFile.file, 0o400);
    assert.equal(await beforeModeChange.current(), false, 'Permission changes must not retain an earlier source receipt');
    await close(beforeModeChange); await clean(); checks.push('source_permission_metadata_change_rejected');

    const invalid = await fixture(bytes.subarray(0, 32));
    await assert.rejects(prepare(invalid.task), /original_not_ready/);
    assert.equal((await stat(invalid.file)).size, 32); await clean(); checks.push('probe_failure_closes_source_and_private_copy');

    const cancelled = await fixture(Buffer.concat([bytes, Buffer.alloc(29_000_000 - bytes.length)]));
    const controller = new AbortController();
    let settled = false;
    const pending = prepare(cancelled.task, controller.signal).then(value => { settled = true; return { value }; },
      (error: unknown) => { settled = true; return { error }; });
    let observedCopy = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !observedCopy && !settled) {
      for (const directory of await privateDirectories()) {
        try {
          const size = (await stat(path.join(privateRoot, directory, 'original.mp4'))).size;
          if (size < 29_000_000) { observedCopy = true; break; }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!observedCopy) await delay(1);
    }
    controller.abort(); const outcome = await pending;
    if ('value' in outcome) { await close(outcome.value); assert.fail('An in-flight cancelled source must reject'); }
    assert.match(String(outcome.error), /original_not_ready/);
    assert.equal(observedCopy, true, 'Cancel a real in-progress copy rather than simulating a stream');
    assert.equal((await stat(cancelled.file)).size, 29_000_000); await clean(); checks.push('inflight_cancel_closes_source_and_private_copy');

    const afterReady = await fixture(), readyController = new AbortController();
    const cancelledReady = await prepare(afterReady.task, readyController.signal);
    assert.equal(await cancelledReady.current(), true); readyController.abort(); await close(cancelledReady);
    assert.equal(await cancelledReady.current(), false); await clean(); checks.push('prepared_cancel_closes_source_and_private_copy');

    const early = await fixture(), earlyController = new AbortController(); earlyController.abort();
    await assert.rejects(prepare(early.task, earlyController.signal), /original_not_ready/);
    await clean(); checks.push('already_cancelled_does_not_open_source');
    process.stdout.write(JSON.stringify({ status: 'PASS', sourceHash, checks, sourceDescriptorsAfter: 0,
      privateDirectoriesAfter: 0, externalRequests: 0, databaseWrites: 0, notificationWrites: 0 }) + '\n');
  } finally {
    await Promise.allSettled(Array.from(active).map(result => result.close())); process.chdir(repository);
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV'); else Object.assign(process.env, { NODE_ENV: previousNodeEnv });
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
