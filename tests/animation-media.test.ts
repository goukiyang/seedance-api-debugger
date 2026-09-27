import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import sharp from "sharp";
import packageInfo from "../package.json";
import { checkedAnimationByteBudget, exportAnimationBundle, extractAnimationFrame, importAnimationBundle } from "../src/lib/animation/media";
import { validateAnimationSequence } from "../src/lib/animation/schema";
import { copyVerifiedRetentionSource } from "../scripts/pack-animation-retention";
import type { AnimationLocalFile, AnimationSequence } from "../src/lib/animation/types";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeExecutable(filePath: string, source: string): Promise<void> {
  await fs.writeFile(filePath, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await fs.chmod(filePath, 0o700);
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function writePng(filePath: string, width = 4, height = 4, alpha = true): Promise<void> {
  await sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 200, g: 20, b: 10, alpha: 0.8 } : { r: 200, g: 20, b: 10 },
    },
  }).png().toFile(filePath);
}

async function localPng(filePath: string, id = "pose-file-1", role: AnimationLocalFile["role"] = "pose"): Promise<AnimationLocalFile> {
  const info = await fs.stat(filePath);
  const metadata = await sharp(filePath).metadata();
  return {
    id,
    name: path.basename(filePath),
    role,
    mime: "image/png",
    bytes: info.size,
    sha256: await hashFile(filePath),
    width: metadata.width!,
    height: metadata.height!,
    path: filePath,
  };
}

function sequenceFor(file: AnimationLocalFile, options: Partial<AnimationSequence> = {}): AnimationSequence {
  return {
    schema_version: 1,
    title: "roll candidate",
    preview_fps: 30,
    tick_rate: null,
    tick_rate_verified: false,
    global_scale: 1,
    poses: [{
      id: "roll-pose-1",
      file_id: file.id,
      label: "roll frame 42",
      width: file.width!,
      height: file.height!,
      logical_width: file.width,
      logical_height: file.height,
      pixels_per_unit: 1,
      source: { version: "R6", frame_index: 42, pts_seconds: 1.75, note: "historical review retained" },
    }],
    entries: [{
      id: "roll-entry-1",
      action: "042_翻滚起身_GetUp_Roll",
      pose_id: "roll-pose-1",
      hold_ticks: 6,
      original_hold_ticks: 6,
      locked: true,
      translate_x: 0,
      translate_y: 0,
    }],
    notes: "retention candidate, not game-tested",
    user_accepted_for_retention: true,
    historical_review: "kept for traceability; not an automatic pass",
    ...options,
  };
}

async function runRetentionCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = path.join(process.cwd(), "scripts/pack-animation-retention.ts");
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code] = await once(child, "close") as [number | null];
  return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

function readBundleManifest(zipPath: string): Record<string, unknown> {
  const result = spawnSync("python3", ["-c", "import sys,zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read('manifest.json').decode('utf-8'))", zipPath], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("export byte budget counts original media and reserves transformed output before writing", () => {
  const limit = 10;
  const originals = checkedAnimationByteBudget(0, 3, limit);
  assert.equal(originals, 3);
  assert.equal(checkedAnimationByteBudget(originals, 7, limit), limit);
  assert.throws(() => checkedAnimationByteBudget(originals, 8, limit), /byte budget exceeded/);
  const afterOneTransform = checkedAnimationByteBudget(originals, 2, limit);
  assert.equal(afterOneTransform, 5);
  assert.throws(() => checkedAnimationByteBudget(afterOneTransform, 6, limit), /byte budget exceeded/);
});

test("default media byte budget matches Prisma Int maximum exactly", () => {
  const prismaIntMax = 2_147_483_647;
  assert.equal(checkedAnimationByteBudget(prismaIntMax - 1, 1), prismaIntMax);
  assert.throws(() => checkedAnimationByteBudget(prismaIntMax, 1), /byte budget exceeded/);
});

test("schema preserves native unknown scale and roll candidate 42 at hold 6", () => {
  const sequence = sequenceFor({
    id: "pose-file-1",
    name: "frame.png",
    role: "candidate",
    mime: "image/png",
    bytes: 100,
    sha256: "a".repeat(64),
    width: 640,
    height: 640,
    path: "/controlled/frame.png",
  });
  sequence.poses[0].width = 640;
  sequence.poses[0].height = 640;
  sequence.poses[0].logical_width = null;
  sequence.poses[0].logical_height = null;
  sequence.poses[0].pixels_per_unit = null;
  const result = validateAnimationSequence(sequence);
  assert.equal(result.poses[0].source.frame_index, 42);
  assert.equal(result.entries[0].action, "042_翻滚起身_GetUp_Roll");
  assert.equal(result.entries[0].hold_ticks, 6);
  assert.equal(result.poses[0].pixels_per_unit, null);
  assert.equal(result.user_accepted_for_retention, true);
  assert.match(result.historical_review, /not an automatic pass/);
});

test("schema rejects duplicate IDs, changed original hold, and inconsistent native geometry", () => {
  const file: AnimationLocalFile = {
    id: "pose-file-1", name: "pose.png", role: "pose", mime: "image/png", bytes: 1,
    sha256: "b".repeat(64), width: 8, height: 8, path: "/controlled/pose.png",
  };
  const base = sequenceFor(file);
  const duplicate = structuredClone(base);
  duplicate.poses.push({ ...duplicate.poses[0] });
  assert.throws(() => validateAnimationSequence(duplicate), /duplicate pose id/);

  const changedHold = structuredClone(base);
  changedHold.entries[0].hold_ticks = 7;
  assert.throws(() => validateAnimationSequence(changedHold), /hold_ticks must equal original_hold_ticks/);

  const inconsistent = structuredClone(base);
  inconsistent.poses[0].width = 640;
  inconsistent.poses[0].height = 640;
  inconsistent.poses[0].logical_width = 64;
  inconsistent.poses[0].logical_height = 64;
  inconsistent.poses[0].pixels_per_unit = 10;
  assert.doesNotThrow(() => validateAnimationSequence(inconsistent));
  inconsistent.poses[0].pixels_per_unit = 16;
  assert.throws(() => validateAnimationSequence(inconsistent), /dimensions do not match pixels_per_unit/);
});

test("schema bounds explicit reference geometry and requires its immutable file reference", () => {
  const file: AnimationLocalFile = {
    id: "pose-file-1", name: "pose.png", role: "pose", mime: "image/png", bytes: 1,
    sha256: "b".repeat(64), width: 8, height: 8, path: "/controlled/pose.png",
  };
  const base = sequenceFor(file);
  base.entries[0].reference_file_id = "reference-file-1";
  base.entries[0].reference_geometry = {
    logical_width: 4,
    logical_height: 2,
    pixels_per_unit: 2,
    source: "retention/manifest.json#canvas_policy.logical_canvas",
  };
  assert.deepEqual(validateAnimationSequence(base).entries[0].reference_geometry, base.entries[0].reference_geometry);

  const missingFile = structuredClone(base);
  delete missingFile.entries[0].reference_file_id;
  assert.throws(() => validateAnimationSequence(missingFile), /requires reference_file_id/);

  const nonFinite = structuredClone(base);
  nonFinite.entries[0].reference_geometry!.pixels_per_unit = Number.POSITIVE_INFINITY;
  assert.throws(() => validateAnimationSequence(nonFinite), /must be finite/);

  const nonPositive = structuredClone(base);
  nonPositive.entries[0].reference_geometry!.logical_width = 0;
  assert.throws(() => validateAnimationSequence(nonPositive), /must be finite and between/);

  const oversizedSource = structuredClone(base);
  oversizedSource.entries[0].reference_geometry!.source = "x".repeat(513);
  assert.throws(() => validateAnimationSequence(oversizedSource), /at most 512 characters/);
});

test("work-copy export round-trips without re-encoding PNG and marks tick rate unknown", async (t) => {
  const root = await makeTempDir("animation-export-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source.png");
  const outputDir = path.join(root, "out");
  const importedDir = path.join(root, "imported");
  await fs.mkdir(outputDir);
  await writePng(sourcePath);
  const file = await localPng(sourcePath);
  const referencePath = path.join(root, "reference.png");
  await writePng(referencePath, 4, 4);
  const reference = await localPng(referencePath, "reference-file-1", "reference");
  const sequence = sequenceFor(file);
  sequence.entries[0].reference_file_id = reference.id;
  const expectedSha = file.sha256;
  const result = await exportAnimationBundle({ sequence, files: [file, reference], outputDir, mode: "work_copy" });
  assert.equal(result.entry_count, 1);
  assert.equal(result.total_ticks, 6);
  assert.ok(result.warnings.some((warning) => warning.includes("tick")));
  const imported = await importAnimationBundle(result.path, importedDir);
  assert.equal(imported.sequence.tick_rate, null);
  assert.equal(imported.sequence.tick_rate_verified, false);
  assert.equal(imported.sequence.entries[0].hold_ticks, 6);
  assert.equal(imported.sequence.entries[0].reference_geometry, undefined);
  assert.equal(imported.files[0].sha256, expectedSha);
  assert.equal(await hashFile(imported.files[0].path), expectedSha);
  const manifest = readBundleManifest(result.path);
  assert.deepEqual(manifest.processor, {
    name: "animation-media",
    schema_version: 1,
    app_version: packageInfo.version,
  });
  const sourceLedger = manifest.sources as Array<{ kind: string; entry_id?: string; geometry?: Record<string, unknown> }>;
  const referenceRecord = sourceLedger.find((item) => item.kind === "original-reference" && item.entry_id === sequence.entries[0].id);
  assert.equal(referenceRecord?.geometry?.pixels_per_logical_pixel, null);
  assert.equal(referenceRecord?.geometry?.mapping, "unknown-no-reference-geometry");

  const legacyZipPath = path.join(root, "legacy-processor.zip");
  const legacyProcessor = spawnSync("python3", ["-c", [
    "import json,sys,zipfile",
    "with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], 'w') as target:",
    " for info in source.infolist():",
    "  data=source.read(info.filename)",
    "  if info.filename == 'manifest.json':",
    "   manifest=json.loads(data)",
    "   manifest['processor']={'name':'animation-media','schema_version':1}",
    "   data=json.dumps(manifest).encode()",
    "  target.writestr(info, data)",
  ].join("\n"), result.path, legacyZipPath], { encoding: "utf8", timeout: 5_000 });
  assert.equal(legacyProcessor.error, undefined, legacyProcessor.error?.message);
  assert.equal(legacyProcessor.status, 0, legacyProcessor.stderr);
  const legacyImported = await importAnimationBundle(legacyZipPath, path.join(root, "legacy-import"));
  assert.equal(legacyImported.sequence.entries[0].hold_ticks, 6);
});

test("explicit reference geometry is verified against decoded PNG and survives ID remapping", async (t) => {
  const root = await makeTempDir("animation-reference-geometry-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "out");
  await fs.mkdir(outputDir);
  const posePath = path.join(root, "pose.png");
  const referencePath = path.join(root, "reference.png");
  await writePng(posePath, 4, 4);
  await writePng(referencePath, 8, 4);
  const poseFile = await localPng(posePath);
  const referenceFile = await localPng(referencePath, "reference-file-1", "reference");
  const sequence = sequenceFor(poseFile);
  sequence.entries[0].reference_file_id = referenceFile.id;
  sequence.entries[0].reference_geometry = {
    logical_width: 4,
    logical_height: 2,
    pixels_per_unit: 2,
    source: "retention/manifest.json#canvas_policy.logical_canvas",
  };
  const expectedGeometry = structuredClone(sequence.entries[0].reference_geometry);
  const first = await exportAnimationBundle({ sequence, files: [poseFile, referenceFile], outputDir, mode: "work_copy" });
  const imported = await importAnimationBundle(first.path, path.join(root, "imported"));
  assert.notEqual(imported.sequence.entries[0].reference_file_id, referenceFile.id);
  assert.deepEqual(imported.sequence.entries[0].reference_geometry, expectedGeometry);

  const second = await exportAnimationBundle({ sequence: imported.sequence, files: imported.files, outputDir, mode: "work_copy" });
  const roundTrip = await importAnimationBundle(second.path, path.join(root, "roundtrip"));
  assert.deepEqual(roundTrip.sequence.entries[0].reference_geometry, expectedGeometry);

  const mismatched = structuredClone(sequence);
  mismatched.entries[0].reference_geometry!.pixels_per_unit = 3;
  await assert.rejects(
    exportAnimationBundle({ sequence: mismatched, files: [poseFile, referenceFile], outputDir, mode: "work_copy" }),
    /does not match decoded PNG dimensions/,
  );

  const badZip = path.join(root, "mismatched-reference.zip");
  const badManifest = {
    schema_version: 1,
    sequence: mismatched,
    files: [
      { id: poseFile.id, path: "assets/pose.png", name: poseFile.name, role: poseFile.role, sha256: poseFile.sha256 },
      { id: referenceFile.id, path: "assets/reference.png", name: referenceFile.name, role: referenceFile.role, sha256: referenceFile.sha256 },
    ],
  };
  const createdZip = spawnSync("python3", [
    "-c",
    "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.writestr('manifest.json',json.dumps(json.load(sys.stdin))); z.write(sys.argv[2],'assets/pose.png'); z.write(sys.argv[3],'assets/reference.png'); z.close()",
    badZip,
    posePath,
    referencePath,
  ], { input: JSON.stringify(badManifest), encoding: "utf8", timeout: 5_000 });
  assert.equal(createdZip.error, undefined, createdZip.error?.message);
  assert.equal(createdZip.status, 0, createdZip.stderr);
  await assert.rejects(importAnimationBundle(badZip, path.join(root, "rejected-import")), /does not match decoded PNG dimensions/);
});

test("transform export bakes scale and logical translation into expanded transparent PNG bounds", async (t) => {
  const root = await makeTempDir("animation-transform-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source.png");
  const outputDir = path.join(root, "out");
  const importedDir = path.join(root, "imported");
  await fs.mkdir(outputDir);
  await writePng(sourcePath);
  const file = await localPng(sourcePath);
  const sequence = sequenceFor(file, { global_scale: 2 });
  sequence.entries[0].translate_x = -1;
  sequence.entries[0].translate_y = 1;
  const result = await exportAnimationBundle({ sequence, files: [file], outputDir, mode: "work_copy" });
  const imported = await importAnimationBundle(result.path, importedDir);
  const pose = imported.sequence.poses[0];
  assert.equal(pose.width, 9);
  assert.equal(pose.height, 9);
  assert.equal(pose.pixels_per_unit, 1);
  assert.equal(imported.sequence.global_scale, 1);
  assert.equal(imported.sequence.entries[0].translate_x, 0);
  assert.equal(imported.sequence.entries[0].translate_y, 0);
  assert.equal((await sharp(imported.files.find((item) => item.id === pose.file_id)!.path).metadata()).hasAlpha, true);
  const pixels = await sharp(imported.files.find((item) => item.id === pose.file_id)!.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x: number, y: number) => pixels.data[(y * pixels.info.width + x) * 4 + 3];
  assert.equal(alphaAt(0, 0), 0);
  assert.ok(alphaAt(0, 1) > 0);
  assert.equal(alphaAt(8, 1), 0);
});

test("transform export preserves fractional logical offsets at subpixel positions", async (t) => {
  const root = await makeTempDir("animation-transform-fractional-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source.png");
  const outputDir = path.join(root, "out");
  await fs.mkdir(outputDir);
  await writePng(sourcePath);
  const file = await localPng(sourcePath);
  const sequence = sequenceFor(file);
  sequence.poses[0].logical_width = 2;
  sequence.poses[0].logical_height = 2;
  sequence.poses[0].pixels_per_unit = 2;
  sequence.entries[0].translate_x = 0.25;
  const result = await exportAnimationBundle({ sequence, files: [file], outputDir, mode: "work_copy" });
  const imported = await importAnimationBundle(result.path, path.join(root, "imported"));
  const pose = imported.sequence.poses[0];
  assert.equal(pose.width, 5);
  assert.equal(pose.height, 4);
  const pixels = await sharp(imported.files.find((item) => item.id === pose.file_id)!.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const edgeAlpha = pixels.data[3];
  const interiorAlpha = pixels.data[7];
  assert.ok(edgeAlpha > 0 && edgeAlpha < interiorAlpha);
  const manifest = readBundleManifest(result.path);
  const transformations = manifest.transformations as Array<Record<string, unknown>>;
  assert.equal(transformations[0].translate_pixels_x, 0.5);
  assert.equal(transformations[0].subpixel_sampling, "premultiplied-alpha-bilinear");
});

test("safe import rejects path traversal before publishing output", async (t) => {
  const root = await makeTempDir("animation-zip-traversal-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zipPath = path.join(root, "malicious.zip");
  const outputDir = path.join(root, "out");
  const sequence = {
    schema_version: 1,
    title: "bad path",
    preview_fps: 30,
    tick_rate: null,
    tick_rate_verified: false,
    global_scale: 1,
    poses: [{ id: "pose-1", file_id: "file-1", label: "x", width: 1, height: 1, logical_width: null, logical_height: null, pixels_per_unit: null, source: {} }],
    entries: [{ id: "entry-1", action: "roll", pose_id: "pose-1", hold_ticks: 6, original_hold_ticks: 6, locked: true, translate_x: 0, translate_y: 0 }],
    notes: "",
    user_accepted_for_retention: false,
    historical_review: "",
  };
  const manifest = Buffer.from(JSON.stringify({
    schema_version: 1,
    sequence,
    files: [{ id: "file-1", path: "../escape.png", name: "escape.png", role: "pose" }],
  }));
  const maliciousZip = spawnSync("python3", [
    "-c",
    "import sys,zipfile; archive=zipfile.ZipFile(sys.argv[1],'w'); archive.writestr('manifest.json',sys.stdin.buffer.read()); archive.writestr('../escape.png',b'not a PNG'); archive.close()",
    zipPath,
  ], { input: manifest, encoding: "utf8", timeout: 5_000 });
  assert.equal(maliciousZip.error, undefined, maliciousZip.error?.message);
  assert.equal(maliciousZip.status, 0, maliciousZip.stderr);
  await assert.rejects(importAnimationBundle(zipPath, outputDir), /unsafe ZIP path|path segment/i);
  await assert.rejects(fs.lstat(outputDir), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(root, "escape.png")), { code: "ENOENT" });
});

test("safe ZIP preflight rejects an oversized central directory before extraction", async (t) => {
  const root = await makeTempDir("animation-zip-central-limit-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zipPath = path.join(root, "oversized-central.zip");
  const outputDir = path.join(root, "out");
  const created = spawnSync("python3", [
    "-c",
    "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('manifest.json',b'{}'); z.close()",
    zipPath,
  ], { encoding: "utf8", timeout: 5_000 });
  assert.equal(created.error, undefined, created.error?.message);
  assert.equal(created.status, 0, created.stderr);
  const archive = await fs.readFile(zipPath);
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0);
  archive.writeUInt32LE(4 * 1024 * 1024 + 1, eocd + 12);
  await fs.writeFile(zipPath, archive);
  const helper = spawnSync("python3", [
    path.join(process.cwd(), "scripts/animation-safe-extract.py"),
    "--zip", zipPath,
    "--output", outputDir,
    "--max-files", "2000",
    "--max-single-bytes", "1024",
    "--max-total-bytes", "4096",
    "--max-archive-bytes", "4096",
    "--max-manifest-bytes", "1024",
    "--max-seconds", "5",
  ], { encoding: "utf8", timeout: 5_000 });
  assert.equal(helper.error, undefined, helper.error?.message);
  assert.equal(helper.status, 2);
  assert.match(helper.stderr, /central directory exceeds its byte limit/i);
  await assert.rejects(fs.lstat(outputDir), { code: "ENOENT" });
});

test("retention snapshot rejects a source changed after inspection and freezes verified bytes", async (t) => {
  const root = await makeTempDir("animation-retention-snapshot-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source.png");
  const snapshotPath = path.join(root, "snapshot.png");
  await writePng(sourcePath);
  const originalBytes = await fs.readFile(sourcePath);
  const expectedSha = await hashFile(sourcePath);
  const expectedBytes = originalBytes.length;

  await writePng(sourcePath, 5, 4);
  await assert.rejects(copyVerifiedRetentionSource(sourcePath, snapshotPath, expectedBytes, expectedSha), /changed after inspection/i);
  await assert.rejects(fs.lstat(snapshotPath), { code: "ENOENT" });

  await fs.writeFile(sourcePath, originalBytes);
  await copyVerifiedRetentionSource(sourcePath, snapshotPath, expectedBytes, expectedSha);
  await writePng(sourcePath, 4, 5);
  assert.equal(await hashFile(snapshotPath), expectedSha);
  assert.notEqual(await hashFile(sourcePath), expectedSha);
});

test("retention CLI maps seven source directories into four playback groups and preserves all 18 assets", async (t) => {
  const root = await makeTempDir("animation-retention-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const allowedRoot = path.join(root, "allowed");
  const manifestDir = path.join(allowedRoot, "retention");
  const selectedRoot = path.join(manifestDir, "selected");
  const motherRoot = path.join(manifestDir, "mothers");
  const referenceRoot = path.join(manifestDir, "references");
  const allowedRootAlias = path.join(root, "approved-root-alias");
  const outputZip = path.join(root, "retention.zip");
  await fs.mkdir(selectedRoot, { recursive: true });
  await fs.mkdir(motherRoot, { recursive: true });
  await fs.mkdir(referenceRoot, { recursive: true });
  await fs.symlink(allowedRoot, allowedRootAlias, "dir");

  const actionGroups = [
    { group: "walk", actions: [{ name: "walk", holds: [8, 8, 8, 8] }] },
    { group: "jump", actions: [{ name: "jump_up", holds: [14, 2] }, { name: "jump_down", holds: [12, 2] }, { name: "jump_end", holds: [18] }] },
    { group: "guard_break", actions: [{ name: "guard_break", holds: [6, 12, 6, 6] }] },
    { group: "roll", actions: [{ name: "042_翻滚起身_GetUp_Roll", holds: [6, 6, 6, 6] }, { name: "041_起身_GetUp", holds: [6] }] },
  ];
  const animations: Record<string, { ordered_entries: Array<Record<string, unknown>> }> = {};
  const playbackGroups: Record<string, { actions: string[]; entry_count: number; holds: number[]; ticks: number }> = {};
  const expectedHashes = new Map<string, string>();
  let serial = 0;

  for (const group of actionGroups) {
    const actionNames: string[] = [];
    const groupHolds: number[] = [];
    for (const action of group.actions) {
      actionNames.push(action.name);
      const orderedEntries: Array<Record<string, unknown>> = [];
      for (let entryIndex = 0; entryIndex < action.holds.length; entryIndex += 1) {
        const hold = action.holds[entryIndex];
        serial += 1;
        const selectedPath = path.join(selectedRoot, `${serial}.png`);
        const motherPath = path.join(motherRoot, `${serial}.png`);
        const referencePath = path.join(referenceRoot, `${serial}.png`);
        const sourceB = action.name.includes("Roll") || action.name.includes("GetUp");
        const textureSize = sourceB ? 1536 : 1024;
        const multiplier = sourceB ? 24 : 16;
        await writePng(selectedPath, textureSize, textureSize, true);
        await writePng(motherPath, 640, 640, true);
        await writePng(referencePath, 64, 64, true);
        const selectedHash = await hashFile(selectedPath);
        const motherHash = await hashFile(motherPath);
        const referenceHash = await hashFile(referencePath);
        expectedHashes.set(`pose-${serial}`, selectedHash);
        expectedHashes.set(`mother-${serial}`, motherHash);
        expectedHashes.set(`reference-${serial}`, referenceHash);
        const actionDir = action.name;
        orderedEntries.push({
          action: action.name,
          entry_index: entryIndex + 1,
          source_version: sourceB ? "0.8.1" : "0.2.2",
          stored_path: `selected/${serial}.png`,
          mother_path: `mothers/${serial}.png`,
          source_original: path.join(allowedRootAlias, "retention", "references", `${serial}.png`),
          hold,
          logical_canvas: [64, 64],
          texture_canvas: [textureSize, textureSize],
          native_canvas: [640, 640],
          texture_pixels_per_logical_pixel: multiplier,
          hd_sha256: selectedHash,
          native_sha256: motherHash,
          source_manifest_entry: { sha256: referenceHash, candidate_frame: action.name.includes("翻滚") && entryIndex === 3 ? 42 : undefined },
          source_manifest_action: action.name === "041_起身_GetUp" ? "jump" : action.group,
          candidate_frame: action.name.includes("翻滚") && entryIndex === 3 ? 42 : null,
          user_accepted_for_retention: true,
          selected_for_future_package: true,
          historical_review: { pose_status: "historical-observation", action: actionDir },
        });
        groupHolds.push(hold);
      }
      animations[action.name] = { ordered_entries: orderedEntries };
    }
    playbackGroups[group.group] = { actions: actionNames, entry_count: groupHolds.length, holds: groupHolds, ticks: groupHolds.reduce((sum, hold) => sum + hold, 0) };
  }

  const sourceManifest = {
    manifest_id: "s1_guanyu_retention_user_selected",
    version: "0.1.0",
    canvas_policy: {
      logical_canvas: [64, 64],
      source_A_texture_canvas: [1024, 1024],
      source_A_multiplier: 16,
      source_B_texture_canvas: [1536, 1536],
      source_B_multiplier: 24,
      all_mother_canvas: [640, 640],
      native_mother_coordinate_space: "original_generated_pixels_not_game_aligned",
    },
    project: { name: "animation fixture" },
    counts: { game_entry_pngs: 18, independent_native_mother_pngs: 18, playback_ticks: 140 },
    animations,
    playback_groups: playbackGroups,
    selection_basis: { user_statement: "retain selected source", user_accepted_for_retention: true },
    history_fields_policy: "Keep historical review separate from technical validation.",
  };
  const manifestPath = path.join(manifestDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(sourceManifest));
  const cli = await runRetentionCli(["--manifest", path.join(allowedRootAlias, "retention/manifest.json"), "--allowed-root", allowedRootAlias, "--output", outputZip]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal((await fs.stat(outputZip)).isFile(), true);
  const imported = await importAnimationBundle(outputZip, path.join(root, "imported"));
  assert.equal(imported.sequence.entries.length, 18);
  assert.equal(imported.sequence.entries.reduce((sum, entry) => sum + entry.hold_ticks, 0), 140);
  assert.deepEqual(imported.sequence.entries.map((entry) => entry.action), [
    "walk", "walk", "walk", "walk",
    "jump", "jump", "jump", "jump", "jump",
    "guard_break", "guard_break", "guard_break", "guard_break",
    "roll", "roll", "roll", "roll", "roll",
  ]);
  assert.deepEqual(imported.sequence.entries.filter((entry) => entry.action === "walk").map((entry) => entry.hold_ticks), [8, 8, 8, 8]);
  assert.deepEqual(imported.sequence.entries.filter((entry) => entry.action === "jump").map((entry) => entry.hold_ticks), [14, 2, 12, 2, 18]);
  assert.deepEqual(imported.sequence.entries.filter((entry) => entry.action === "guard_break").map((entry) => entry.hold_ticks), [6, 12, 6, 6]);
  const rollEntries = imported.sequence.entries.filter((entry) => entry.action === "roll");
  assert.deepEqual(rollEntries.map((entry) => entry.hold_ticks), [6, 6, 6, 6, 6]);
  assert.deepEqual(["walk", "jump", "guard_break", "roll"].map((action) =>
    imported.sequence.entries.filter((entry) => entry.action === action).reduce((sum, entry) => sum + entry.hold_ticks, 0)), [32, 48, 30, 30]);
  assert.equal(rollEntries[rollEntries.length - 1]?.hold_ticks, 6);
  const finalRollPose = imported.sequence.poses.find((pose) => pose.id === rollEntries[rollEntries.length - 1]?.pose_id)!;
  const finalRollSource = JSON.parse(finalRollPose.source.note!) as Record<string, unknown>;
  assert.equal(finalRollSource.source_action, "041_起身_GetUp");
  assert.equal(finalRollSource.playback_group, "roll");
  assert.equal(finalRollSource.source_manifest_action, "jump");
  assert.equal(imported.files.length, 54);
  assert.equal(imported.files.filter((file) => file.role === "mother").length, 18);
  assert.equal(imported.files.filter((file) => file.role === "reference").length, 18);
  const firstReference = imported.files.find((file) => file.role === "reference")!;
  const firstPose = imported.sequence.poses[0];
  assert.equal(firstReference.width, 64);
  assert.equal(firstReference.height, 64);
  assert.equal(firstPose.logical_width, 64);
  assert.equal(firstPose.pixels_per_unit, 16);
  assert.equal(firstReference.width! / firstPose.logical_width!, 1);
  assert.notEqual(firstReference.width! / firstPose.logical_width!, firstPose.pixels_per_unit);
  const packagedManifest = readBundleManifest(outputZip);
  const packagedSources = packagedManifest.sources as Array<{ file_id: string; kind: string; source?: string; source_action?: string; playback_group?: string; geometry?: Record<string, unknown> }>;
  const packagedSequence = packagedManifest.sequence as AnimationSequence;
  assert.ok(packagedSources.some((source) => source.source_action === "041_起身_GetUp" && source.playback_group === "roll"));
  const packagedReferenceId = packagedSequence.entries[0].reference_file_id;
  const referenceGeometry = packagedSources.find((source) => source.file_id === packagedReferenceId && source.kind === "original-reference")?.geometry;
  assert.equal(referenceGeometry?.image_width, 64);
  assert.equal(referenceGeometry?.image_height, 64);
  assert.equal(referenceGeometry?.logical_canvas_width, 64);
  assert.equal(referenceGeometry?.logical_canvas_height, 64);
  assert.equal(referenceGeometry?.pixels_per_logical_pixel, 1);
  assert.notEqual(referenceGeometry?.pixels_per_logical_pixel, firstPose.pixels_per_unit);
  assert.equal(packagedSequence.entries[0].reference_geometry?.logical_width, 64);
  assert.equal(packagedSequence.entries[0].reference_geometry?.logical_height, 64);
  assert.equal(packagedSequence.entries[0].reference_geometry?.pixels_per_unit, 1);
  assert.equal(packagedSequence.entries[0].reference_geometry?.source, "retention/manifest.json#canvas_policy.logical_canvas");
  assert.notEqual(imported.sequence.entries[0].reference_file_id, packagedReferenceId);
  assert.ok(packagedReferenceId);
  const rollEntry = imported.sequence.entries.find((entry) => entry.action === "roll" && imported.sequence.poses.find((pose) => pose.id === entry.pose_id)?.source.frame_index === 42);
  assert.ok(rollEntry);
  assert.equal(rollEntry.hold_ticks, 6);
  const selected = imported.files.find((file) => file.id === imported.sequence.poses.find((pose) => pose.id === rollEntry.pose_id)?.file_id)!;
  assert.equal(selected.sha256, expectedHashes.get("pose-17"));

  const roundTripDir = path.join(root, "roundtrip-output");
  await fs.mkdir(roundTripDir);
  const exported = await exportAnimationBundle({ sequence: imported.sequence, files: imported.files, outputDir: roundTripDir, mode: "work_copy" });
  assert.equal(exported.entry_count, 18);
  assert.equal(exported.total_ticks, 140);
  const roundTrip = await importAnimationBundle(exported.path, path.join(root, "roundtrip-import"));
  assert.equal(roundTrip.sequence.entries.length, 18);
  assert.equal(roundTrip.sequence.entries.reduce((sum, entry) => sum + entry.hold_ticks, 0), 140);
  assert.equal(roundTrip.files.length, 54);
  for (const entry of roundTrip.sequence.entries) {
    assert.deepEqual(entry.reference_geometry, {
      logical_width: 64,
      logical_height: 64,
      pixels_per_unit: 1,
      source: "retention/manifest.json#canvas_policy.logical_canvas",
    });
    const reference = roundTrip.files.find((file) => file.id === entry.reference_file_id)!;
    assert.equal(reference.width, 64);
    assert.equal(reference.height, 64);
  }
  for (const role of ["pose", "mother", "reference"] as const) {
    const expected = Array.from(expectedHashes.entries())
      .filter(([key]) => key.startsWith(`${role}-`))
      .map(([, hash]) => hash)
      .sort();
    const actual = roundTrip.files.filter((file) => file.role === role).map((file) => file.sha256).sort();
    assert.equal(expected.length, 18, `${role} fixture must contain 18 non-empty expected hashes`);
    assert.ok(expected.every((hash) => /^[a-f0-9]{64}$/i.test(hash)), `${role} fixture hashes must be populated SHA-256 values`);
    assert.equal(actual.length, 18, `${role} roundtrip must contain all 18 PNGs`);
    assert.deepEqual(actual, expected, `${role} PNG bytes must survive import/export unchanged`);
  }

  const genericRaw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, any>;
  genericRaw.manifest_id = "unrelated-retention-package";
  await fs.writeFile(manifestPath, JSON.stringify(genericRaw));
  const genericZip = path.join(root, "generic-retention.zip");
  const genericCli = await runRetentionCli(["--manifest", path.join(allowedRootAlias, "retention/manifest.json"), "--allowed-root", allowedRootAlias, "--output", genericZip]);
  assert.equal(genericCli.code, 0, genericCli.stderr);
  const genericBundle = readBundleManifest(genericZip);
  const genericSequence = genericBundle.sequence as AnimationSequence;
  assert.equal(genericSequence.entries[0].reference_geometry, undefined);
  const genericSources = genericBundle.sources as Array<{ kind: string; geometry?: Record<string, unknown> }>;
  const genericReference = genericSources.find((source) => source.kind === "original-reference");
  assert.equal(genericReference?.geometry?.pixels_per_logical_pixel, null);
  assert.equal(genericReference?.geometry?.mapping, "unknown-no-confirmed-canvas-policy");

  const symlinkSource = path.join(selectedRoot, "source-alias.png");
  await fs.symlink(path.join(selectedRoot, "1.png"), symlinkSource);
  const alteredManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as typeof sourceManifest;
  alteredManifest.animations.walk.ordered_entries[0].stored_path = "selected/source-alias.png";
  await fs.writeFile(manifestPath, JSON.stringify(alteredManifest));
  const deniedOutput = path.join(root, "symlink-source.zip");
  const denied = await runRetentionCli(["--manifest", path.join(allowedRootAlias, "retention/manifest.json"), "--allowed-root", allowedRootAlias, "--output", deniedOutput]);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /symlink inside --allowed-root/i);
  await assert.rejects(fs.lstat(deniedOutput), { code: "ENOENT" });
});

test("extracts decoded frame 42 from a controlled MP4 and keeps the roll hold at 6", async (t) => {
  const availability = ["ffmpeg", "ffprobe"].map((tool) => spawnSync(tool, ["-version"], { stdio: "ignore", timeout: 3_000 }));
  if (availability.some((result) => result.error || result.status !== 0)) {
    t.skip("ffmpeg/ffprobe are unavailable");
    return;
  }

  const root = await makeTempDir("animation-frame-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const videoId = "00000000-0000-4000-8000-000000000042";
  const videoPath = path.join(root, `${videoId}.mp4`);
  const outputDir = path.join(root, "frames");
  await fs.mkdir(outputDir);
  const generated = spawnSync("ffmpeg", [
    "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=16x16:r=24:d=2",
    "-frames:v", "43", "-an", "-c:v", "mpeg4", "-q:v", "2", videoPath,
  ], { encoding: "utf8", timeout: 15_000 });
  if (generated.error || generated.status !== 0) {
    t.skip("local ffmpeg cannot create the small MP4 fixture");
    return;
  }
  const videoStat = await fs.stat(videoPath);
  const video: AnimationLocalFile = {
    id: videoId,
    name: "candidate.mp4",
    role: "video",
    mime: "video/mp4",
    bytes: videoStat.size,
    sha256: await hashFile(videoPath),
    width: 16,
    height: 16,
    path: videoPath,
  };
  const extracted = await extractAnimationFrame({ file: video, index: 42, outputDir });
  assert.equal(extracted.pose.source.frame_index, 42);
  assert.equal(typeof extracted.pose.source.pts_seconds, "number");
  assert.equal(extracted.pose.pixels_per_unit, null);
  const sequence = sequenceFor(extracted.file);
  sequence.poses[0] = { ...extracted.pose, id: "roll-pose-1" };
  sequence.poses[0].source.note = "R6 candidate 42; not auto-matted";
  sequence.entries[0].hold_ticks = 6;
  sequence.entries[0].original_hold_ticks = 6;
  const checked = validateAnimationSequence(sequence);
  assert.equal(checked.entries[0].hold_ticks, 6);
  assert.equal(checked.poses[0].source.frame_index, 42);
});

test("rejects oversized video dimensions before ffprobe decodes frame counts", async (t) => {
  const root = await makeTempDir("animation-video-dimensions-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  const probeLog = path.join(root, "ffprobe.log");
  await writeExecutable(path.join(bin, "ffprobe"), [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.FFPROBE_LOG, args.includes('-count_frames') ? 'count\\n' : 'metadata\\n');",
    "process.stdout.write(JSON.stringify({streams:[{codec_type:'video',width:20000,height:20000,duration:'1'}],format:{duration:'1'}}));",
  ].join("\n"));

  const videoId = "00000000-0000-4000-8000-000000000091";
  const videoPath = path.join(root, `${videoId}.mp4`);
  const outputDir = path.join(root, "frames");
  await fs.writeFile(videoPath, Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
  await fs.mkdir(outputDir);
  const stat = await fs.stat(videoPath);
  const file: AnimationLocalFile = {
    id: videoId, name: "candidate.mp4", role: "video", mime: "video/mp4",
    bytes: stat.size, sha256: await hashFile(videoPath), width: 16, height: 16, path: videoPath,
  };
  const previousPath = process.env.PATH;
  const previousProbeLog = process.env.FFPROBE_LOG;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  process.env.FFPROBE_LOG = probeLog;
  try {
    await assert.rejects(extractAnimationFrame({ file, index: 0, outputDir }), /dimensions exceed the pixel limit/);
    const calls = await fs.readFile(probeLog, "utf8");
    assert.match(calls, /metadata/);
    assert.doesNotMatch(calls, /count/);
    assert.deepEqual(await fs.readdir(outputDir), []);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousProbeLog === undefined) delete process.env.FFPROBE_LOG;
    else process.env.FFPROBE_LOG = previousProbeLog;
  }
});

test("rejects a sparse over-limit MP4 before hashing or probing it", async (t) => {
  const root = await makeTempDir("animation-video-byte-limit-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const videoId = "00000000-0000-4000-8000-000000000093";
  const videoPath = path.join(root, `${videoId}.mp4`);
  const outputDir = path.join(root, "frames");
  const handle = await fs.open(videoPath, "w");
  try {
    await handle.truncate(512 * 1024 * 1024 + 1);
  } finally {
    await handle.close();
  }
  await fs.mkdir(outputDir);
  await assert.rejects(extractAnimationFrame({
    file: {
      id: videoId, name: "candidate.mp4", role: "video", mime: "video/mp4",
      bytes: 512 * 1024 * 1024 + 1, sha256: "a".repeat(64), width: 16, height: 16, path: videoPath,
    },
    index: 0,
    outputDir,
  }), /size is outside/i);
  assert.deepEqual(await fs.readdir(outputDir), []);
});

test("caller timeout aborts stalled frame extraction and removes partial output", async (t) => {
  const root = await makeTempDir("animation-frame-cancel-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await writeExecutable(path.join(bin, "ffprobe"), [
    "const args = process.argv.slice(2);",
    "if (args.includes('-show_frames')) process.stdout.write(JSON.stringify({frames:[{best_effort_timestamp_time:'0.0'}]}));",
    "else if (args.includes('-count_frames')) process.stdout.write(JSON.stringify({streams:[{nb_read_frames:'1'}]}));",
    "else process.stdout.write(JSON.stringify({streams:[{codec_type:'video',width:16,height:16,duration:'1'}],format:{duration:'1'}}));",
  ].join("\n"));
  await writeExecutable(path.join(bin, "ffmpeg"), [
    "const fs = require('node:fs');",
    "const destination = process.argv[process.argv.length - 1];",
    "process.on('SIGTERM', () => process.exit(0));",
    "fs.writeFileSync(destination, Buffer.from('partial PNG'));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));

  const videoId = "00000000-0000-4000-8000-000000000092";
  const videoPath = path.join(root, `${videoId}.mp4`);
  const outputDir = path.join(root, "frames");
  await fs.writeFile(videoPath, Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
  await fs.mkdir(outputDir);
  const stat = await fs.stat(videoPath);
  const file: AnimationLocalFile = {
    id: videoId, name: "candidate.mp4", role: "video", mime: "video/mp4",
    bytes: stat.size, sha256: await hashFile(videoPath), width: 16, height: 16, path: videoPath,
  };
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  const controller = new AbortController();
  const operation = extractAnimationFrame({ file, index: 0, outputDir, signal: controller.signal });
  const handledOperation = operation.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    let partialOutputFound = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const names = await fs.readdir(outputDir);
      if (names.some((name) => name.endsWith(".tmp.png"))) {
        partialOutputFound = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(partialOutputFound, "fake ffmpeg should create its partial output before the caller deadline");
    const deadlineTimer = setTimeout(() => controller.abort(), 30);
    const settled = await handledOperation;
    clearTimeout(deadlineTimer);
    assert.ok("error" in settled);
    assert.equal((settled.error as Error).name, "AbortError");
    assert.deepEqual(await fs.readdir(outputDir), []);
  } finally {
    controller.abort();
    await handledOperation;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
