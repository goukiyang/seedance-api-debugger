#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readTypedJson } from './release-engine/v1/typed-files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/;

function rootJson(file, maximumBytes = 1024 * 1024) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file);
  return readTypedJson({ file, category: 'root_control', maximumBytes }).value;
}

function installedEntry(batchFile) {
  const batch = rootJson(batchFile);
  assert.equal(batch.schema, 'sd2-release-batch.v1'); assert.match(batch.taskId, UUID); assert.match(batch.attemptId, UUID);
  assert.equal(batch.runId, batch.attemptId); assert.equal(batch.engine?.schema, 'sd2-release-engine.v1');
  assert.ok(path.isAbsolute(batch.projectRoot));
  assert.equal(batch.engine.root,
    `${batch.projectRoot}/release-engines/${batch.engine.version}-${batch.engine.controllerSetSha256}`);
  const entry = path.join(batch.engine.root, 'release-entry.mjs');
  const stat = fs.lstatSync(entry); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
  assert.equal(fs.realpathSync(entry), entry); return entry;
}

function forward(entry, args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
  });
  if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.signal) throw Object.assign(new Error(`Installed release entry ended by ${result.signal}`), { code: 'ECHILD', signal: result.signal });
  process.exitCode = result.status ?? 1;
  return { status: result.status ?? null, signal: result.signal ?? null, error: null };
}

export async function sd2ReleaseCli(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'new-identity' && args.length <= 1) {
    const taskId = args[0] || randomUUID(); assert.match(taskId, UUID);
    const attemptId = randomUUID();
    process.stdout.write(JSON.stringify({ schema: 'sd2-release-operation-identity.v1', taskId, attemptId, runId: attemptId }) + '\n');
    return;
  }
  if (command === 'plan-install' && args.length === 1) {
    const module = await import(pathToFileURL(path.join(here, 'release-engine/v1/release-entry.mjs')).href);
    const value = module.validateEngineInstall(rootJson(args[0]));
    process.stdout.write(JSON.stringify({ schema: 'sd2-release-engine-transfer-plan.v1', sourceRoot: value.sourceRoot,
      targetRoot: value.engine.root, files: Object.entries(value.privateSha256).map(([name, sha256]) => ({ name, sha256 })),
      installCommand: ['install-engine', args[0]] }) + '\n');
    return;
  }
  if (command === 'install-engine' && args.length === 1) {
    const module = await import(pathToFileURL(path.join(here, 'release-engine/v1/release-entry.mjs')).href);
    process.stdout.write(JSON.stringify(module.installReleaseEngine(args[0])) + '\n'); return;
  }
  if (command === 'package' && args.length === 2) {
    const module = await import(pathToFileURL(path.join(here, 'release-engine/v1/release-entry.mjs')).href);
    process.stdout.write(JSON.stringify(await module.packageReleaseCandidates(args[0], args[1])) + '\n'); return;
  }
  const counts = { start: 2, status: 1, inspect: 1, resume: 2 };
  if (Object.hasOwn(counts, command) && args.length === counts[command]) return forward(installedEntry(args[0]), [command, ...args]);
  if (command === 'run' && args.length >= 2 && args.length <= 4) return forward(installedEntry(args[0]), [command, ...args]);
  throw new Error('Usage: sd2-release.mjs new-identity [TASK_UUID] | package CONTEXT.json REQUEST.json | plan-install INSTALL.json | install-engine INSTALL.json | start BATCH.json WINDOW.json | status BATCH.json | inspect BATCH.json | resume BATCH.json WINDOW.json | run BATCH.json WINDOW.json [PHASE [APPROVAL.json]]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  sd2ReleaseCli().catch(error => { process.stderr.write(String(error?.stack || error) + '\n'); process.exitCode = 1; });
}
