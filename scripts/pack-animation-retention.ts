import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import yazl from "yazl";
import { validateAnimationSequence } from "../src/lib/animation/schema";
import type { AnimationEntry, AnimationFileRole, AnimationPose, AnimationSequence } from "../src/lib/animation/types";

const MAX_ENTRIES = 500;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32_000_000;
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const ACTION_FILENAME_FILTER = new RegExp("[^\\p{L}\\p{N}_.-]", "gu");

interface RetentionEntry {
  action: string;
  playback_group: string;
  entry_index: number;
  source_manifest_action?: unknown;
  source_version?: string;
  source_manifest_entry?: { candidate_frame?: number | null; sha256?: string; hd_sha256?: string; native_sha256?: string; [key: string]: unknown } | null;
  candidate_frame?: number | null;
  hd_sha256?: string;
  native_sha256?: string;
  stored_path: string;
  mother_path: string;
  source_original: string;
  hold: number;
  logical_canvas: [number, number];
  texture_canvas: [number, number];
  native_canvas: [number, number];
  texture_pixels_per_logical_pixel: number;
  user_accepted_for_retention: boolean;
  selected_for_future_package: boolean;
  historical_review?: unknown;
}

interface SourceRecord {
  id: string;
  path: string;
  name: string;
  role: AnimationFileRole;
  sha256: string;
}

interface ZipInput {
  localPath?: string;
  buffer?: Buffer;
  archivePath: string;
  expectedBytes?: number;
  expectedSha256?: string;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function rejectSymlinkWithinRoot(root: string, target: string): Promise<void> {
  if (!inside(root, target)) throw new Error("source path resolves outside --allowed-root");
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) throw new Error(`source path contains a symlink inside --allowed-root: ${current}`);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`source parent is not a directory: ${current}`);
  }
}

async function resolveAllowedPath(candidate: string, rootAlias: string, rootReal: string, label: string): Promise<{ absolute: string; relative: string }> {
  const absolute = path.resolve(candidate);
  const relative = inside(rootAlias, absolute)
    ? path.relative(rootAlias, absolute)
    : inside(rootReal, absolute)
      ? path.relative(rootReal, absolute)
      : null;
  if (relative === null) throw new Error(`${label} is not inside --allowed-root`);
  const normalized = path.resolve(rootReal, relative);
  if (!inside(rootReal, normalized)) throw new Error(`${label} escapes --allowed-root`);
  await rejectSymlinkWithinRoot(rootReal, normalized);
  const realPath = await fs.realpath(normalized);
  if (realPath !== normalized) throw new Error(`${label} changed while resolving inside --allowed-root`);
  return { absolute: realPath, relative: path.relative(rootReal, realPath).split(path.sep).join("/") };
}

function safeRelative(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 1_024 || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  if (value.normalize("NFC") !== value) throw new Error(`${label} is not NFC-normalized`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.length > 255 || part.includes(":"))) {
    throw new Error(`${label} contains an unsafe path component`);
  }
  return value;
}

function parseArgs(argv: string[]): { manifest: string; allowedRoot: string; output: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--manifest", "--allowed-root", "--output"].includes(key) || values.has(key)) {
      throw new Error(`unsupported or duplicate option: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    values.set(key, value);
    index += 1;
  }
  const manifest = values.get("--manifest");
  const allowedRoot = values.get("--allowed-root");
  const output = values.get("--output");
  if (!manifest || !allowedRoot || !output || values.size !== 3) {
    throw new Error("usage: tsx scripts/pack-animation-retention.ts --manifest <file> --allowed-root <dir> --output <new.zip>");
  }
  return { manifest: path.resolve(manifest), allowedRoot: path.resolve(allowedRoot), output: path.resolve(output) };
}

function safeName(sourcePath: string): string {
  const base = path.basename(sourcePath).normalize("NFC").replace(/[\u0000-\u001f\u007f:]/g, "_").trim();
  if (!base || base === "." || base === "..") throw new Error("source filename is invalid");
  return base.slice(-240);
}

async function resolveSource(value: unknown, label: string, manifestDir: string, allowedRootAlias: string, allowedRoot: string): Promise<{ absolute: string; relative: string }> {
  const raw = typeof value === "string" ? value : "";
  if (!raw || raw.length > 4_096 || raw.includes("\0") || raw.includes("\\")) throw new Error(`${label} is missing or invalid`);
  const candidate = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(manifestDir, safeRelative(raw, label));
  const resolved = await resolveAllowedPath(candidate, allowedRootAlias, allowedRoot, label);
  const info = await fs.lstat(resolved.absolute);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_SOURCE_BYTES) throw new Error(`${label} is not a bounded regular file`);
  if (path.extname(resolved.absolute).toLowerCase() !== ".png") throw new Error(`${label} must point to a PNG`);
  return resolved;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function copyVerifiedRetentionSource(
  sourcePath: string,
  destinationPath: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_SOURCE_BYTES || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("retention snapshot expectations are invalid");
  }
  const source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination: Awaited<ReturnType<typeof fs.open>> | undefined;
  let destinationCreated = false;
  let operationError: unknown;
  let operationFailed = false;
  try {
    try {
      const sourceInfo = await source.stat();
      if (!sourceInfo.isFile() || sourceInfo.size !== expectedBytes) throw new Error("retention source changed after inspection");
      destination = await fs.open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      destinationCreated = true;
      const hash = createHash("sha256");
      let copiedBytes = 0;
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        copiedBytes += bytesRead;
        if (copiedBytes > expectedBytes) throw new Error("retention source grew while making its snapshot");
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(buffer, written, bytesRead - written, position + written);
          if (result.bytesWritten <= 0) throw new Error("retention snapshot write made no progress");
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await destination.sync();
      if (copiedBytes !== expectedBytes || hash.digest("hex") !== expectedSha256.toLowerCase()) {
        throw new Error("retention source changed after inspection; snapshot hash did not match");
      }
    } catch (error) {
      operationError = error;
      operationFailed = true;
    }
  } finally {
    try {
      await source.close();
    } catch (error) {
      if (!operationFailed) operationError = error;
      operationFailed = true;
    }
    if (destination) {
      try {
        await destination.close();
      } catch (error) {
        if (!operationFailed) operationError = error;
        operationFailed = true;
      }
    }
  }
  if (operationFailed) {
    if (destinationCreated) await fs.rm(destinationPath, { force: true });
    throw operationError;
  }
}

async function inspectPng(filePath: string, label: string, requireAlpha: boolean): Promise<{ width: number; height: number; bytes: number; sha256: string }> {
  const info = await fs.stat(filePath);
  if (info.size <= 0 || info.size > MAX_SOURCE_BYTES) throw new Error(`${label} exceeds the per-file byte limit`);
  const image = sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error", sequentialRead: true });
  const metadata = await image.metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw new Error(`${label} is not a bounded PNG`);
  }
  if (requireAlpha && !metadata.hasAlpha) throw new Error(`${label} does not contain an alpha channel`);
  await image.stats();
  return { width: metadata.width, height: metadata.height, bytes: info.size, sha256: await sha256File(filePath) };
}

function verifyExpectedHash(actual: string, expected: unknown, label: string): void {
  if (expected === undefined || expected === null) return;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected) || actual !== expected.toLowerCase()) {
    throw new Error(`${label} SHA-256 does not match its retention manifest`);
  }
}

function validPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function dimensions(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} must contain width and height`);
  return [validPositiveInteger(value[0], `${label}[0]`), validPositiveInteger(value[1], `${label}[1]`)];
}

function pairEquals(value: unknown, expected: [number, number]): boolean {
  return Array.isArray(value) && value.length === 2 && value[0] === expected[0] && value[1] === expected[1];
}

function hasConfirmedGuanyuCanvasPolicy(raw: Record<string, any>): boolean {
  const policy = raw.canvas_policy;
  return raw.manifest_id === "s1_guanyu_retention_user_selected" && raw.version === "0.1.0" &&
    policy !== null && typeof policy === "object" &&
    pairEquals(policy.logical_canvas, [64, 64]) &&
    pairEquals(policy.source_A_texture_canvas, [1024, 1024]) && policy.source_A_multiplier === 16 &&
    pairEquals(policy.source_B_texture_canvas, [1536, 1536]) && policy.source_B_multiplier === 24 &&
    pairEquals(policy.all_mother_canvas, [640, 640]) &&
    policy.native_mother_coordinate_space === "original_generated_pixels_not_game_aligned";
}

function confirmedReferenceGeometry(
  policyConfirmed: boolean,
  manifestPath: string,
  allowedRoot: string,
  logical: [number, number],
  reference: { width: number; height: number },
): NonNullable<AnimationEntry["reference_geometry"]> | undefined {
  if (!policyConfirmed || logical[0] !== 64 || logical[1] !== 64 || reference.width !== 64 || reference.height !== 64) {
    return undefined;
  }
  const relativeManifest = path.relative(allowedRoot, manifestPath).split(path.sep).join("/");
  const source = `${relativeManifest}#canvas_policy.logical_canvas`;
  if (source.length > 512) throw new Error("canvas policy provenance exceeds the reference geometry source limit");
  return { logical_width: 64, logical_height: 64, pixels_per_unit: 1, source };
}

function compactHistoricalValue(value: unknown, limit = 2_048): string {
  const json = JSON.stringify(value ?? {});
  if (json.length > limit) throw new Error("historical review metadata exceeds the sequence field limit");
  return json;
}

async function collectEntries(raw: Record<string, any>): Promise<RetentionEntry[]> {
  if (!raw.animations || typeof raw.animations !== "object" || !raw.playback_groups || typeof raw.playback_groups !== "object") {
    throw new Error("retention manifest must include animations and playback_groups");
  }
  const ordered: RetentionEntry[] = [];
  const covered = new Set<string>();
  for (const [groupName, group] of Object.entries(raw.playback_groups as Record<string, any>)) {
    if (!Array.isArray(group.actions) || !group.actions.length) throw new Error(`playback group ${groupName} has no ordered actions`);
    const groupEntries: RetentionEntry[] = [];
    for (const action of group.actions as unknown[]) {
      if (typeof action !== "string" || covered.has(action)) throw new Error(`action in playback group ${groupName} is invalid or duplicated`);
      covered.add(action);
      const animation = (raw.animations as Record<string, any>)[action];
      if (!animation || !Array.isArray(animation.ordered_entries)) throw new Error(`animation ${String(action)} has no ordered_entries`);
      if (ordered.length + animation.ordered_entries.length > MAX_ENTRIES) throw new Error("retention manifest exceeds the entry limit");
      const entries = [...animation.ordered_entries].sort((left, right) => Number(left.entry_index) - Number(right.entry_index)) as RetentionEntry[];
      if (!entries.length) throw new Error(`animation ${action} has no entries`);
      entries.forEach((entry, index) => {
        if (entry.action !== action || entry.entry_index !== index + 1) throw new Error(`animation ${action} entry order is invalid`);
        if (!entry.selected_for_future_package || !entry.user_accepted_for_retention) throw new Error(`animation ${action} contains an unselected or unaccepted entry`);
        validPositiveInteger(entry.hold, `${action}[${entry.entry_index}].hold`);
        groupEntries.push({ ...entry, playback_group: groupName });
      });
    }
    const holds = groupEntries.map((entry) => entry.hold);
    if (group.entry_count !== holds.length || group.holds?.some((hold: number, index: number) => hold !== holds[index]) || group.holds?.length !== holds.length) {
      throw new Error(`playback group ${groupName} timing does not match its entries`);
    }
    if (group.playback_ticks !== undefined && group.playback_ticks !== holds.reduce((sum, hold) => sum + hold, 0)) {
      throw new Error(`playback group ${groupName} tick total is inconsistent`);
    }
    if (group.ticks !== undefined && group.ticks !== holds.reduce((sum, hold) => sum + hold, 0)) {
      throw new Error(`playback group ${groupName} tick total is inconsistent`);
    }
    ordered.push(...groupEntries);
  }
  const animationNames = Object.keys(raw.animations);
  if (animationNames.some((name) => !covered.has(name)) || ordered.length !== 18 || ordered.length > MAX_ENTRIES) {
    throw new Error("retention package requires all 18 selected entries in playback-group order");
  }
  return ordered;
}

async function writeZip(outputPath: string, inputs: ZipInput[]): Promise<void> {
  const zip = new yazl.ZipFile();
  const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const writing = pipeline(zip.outputStream as NodeJS.ReadableStream, output);
  try {
    zip.addBuffer(inputs[0].buffer!, inputs[0].archivePath, {
      mtime: FIXED_ZIP_DATE,
      mode: 0o100600,
      compress: true,
      compressionLevel: 6,
      forceDosTimestamp: true,
    });
    for (const input of inputs.slice(1)) {
      if (!input.localPath) throw new Error(`missing source for ${input.archivePath}`);
      zip.addFile(input.localPath, input.archivePath, {
        mtime: FIXED_ZIP_DATE,
        mode: 0o100600,
        compress: false,
        forceDosTimestamp: true,
      });
    }
    zip.end({ forceZip64Format: false, comment: "" });
    await writing;
  } catch (error) {
    (zip.outputStream as NodeJS.ReadableStream & { destroy(error?: Error): void }).destroy(error as Error);
    output.destroy(error as Error);
    await writing.catch(() => undefined);
    throw error;
  }
}

async function createBundle(args: { manifest: string; allowedRoot: string; output: string }): Promise<{ bytes: number; entryCount: number; ticks: number }> {
  const allowedRootAlias = path.resolve(args.allowedRoot);
  const allowedRoot = await fs.realpath(allowedRootAlias);
  const rootInfo = await fs.stat(allowedRoot);
  const manifestPath = (await resolveAllowedPath(args.manifest, allowedRootAlias, allowedRoot, "--manifest")).absolute;
  if (!rootInfo.isDirectory() || !inside(allowedRoot, manifestPath)) {
    throw new Error("manifest must be inside the real --allowed-root directory");
  }
  const outputParent = path.dirname(args.output);
  const realOutputParent = await fs.realpath(outputParent);
  if (!(await fs.stat(realOutputParent)).isDirectory()) throw new Error("--output parent must be an existing directory");
  const outputPath = path.join(realOutputParent, path.basename(args.output));
  if (path.extname(outputPath).toLowerCase() !== ".zip") throw new Error("--output must name a .zip file");
  if (inside(allowedRoot, outputPath)) throw new Error("--output must be outside --allowed-root to protect source files");
  try {
    await fs.lstat(outputPath);
    throw new Error("--output already exists; refusing to overwrite it");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const manifestInfo = await fs.stat(manifestPath);
  if (manifestInfo.size <= 0 || manifestInfo.size > MAX_MANIFEST_BYTES) throw new Error("retention manifest exceeds its byte limit");
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, any>;
  const confirmedCanvasPolicy = hasConfirmedGuanyuCanvasPolicy(raw);
  const entries = await collectEntries(raw);
  const manifestDir = path.dirname(manifestPath);
  const pending: Array<{ entry: RetentionEntry; selected: Awaited<ReturnType<typeof resolveSource>>; mother: Awaited<ReturnType<typeof resolveSource>>; reference: Awaited<ReturnType<typeof resolveSource>> }> = [];

  for (const entry of entries) {
    pending.push({
      entry,
      selected: await resolveSource(entry.stored_path, `${entry.action}[${entry.entry_index}].stored_path`, manifestDir, allowedRootAlias, allowedRoot),
      mother: await resolveSource(entry.mother_path, `${entry.action}[${entry.entry_index}].mother_path`, manifestDir, allowedRootAlias, allowedRoot),
      reference: await resolveSource(entry.source_original, `${entry.action}[${entry.entry_index}].source_original`, manifestDir, allowedRootAlias, allowedRoot),
    });
  }
  const allSources = pending.flatMap((item) => [item.selected.absolute, item.mother.absolute, item.reference.absolute]);
  if (allSources.length !== 54 || allSources.some((source) => !inside(allowedRoot, source))) {
    throw new Error("all 18 selected PNGs, 18 mothers and 18 original references must resolve inside --allowed-root");
  }

  const fileRecords: SourceRecord[] = [];
  const zipInputs: ZipInput[] = [];
  const poses: AnimationPose[] = [];
  const sequenceEntries: AnimationEntry[] = [];
  const sourceLedger: Array<Record<string, unknown>> = [];
  let totalSourceBytes = 0;
  let totalTicks = 0;

  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index];
    const number = String(index + 1).padStart(3, "0");
    const poseId = `pose-${number}`;
    const selectedId = `selected-${number}`;
    const motherId = `mother-${number}`;
    const referenceId = `reference-${number}`;
    const selectedName = safeName(item.selected.absolute);
    const motherName = safeName(item.mother.absolute);
    const referenceName = safeName(item.reference.absolute);
    const actionSegment = `${number}_${safeName(item.entry.action).replace(ACTION_FILENAME_FILTER, "_").slice(0, 96)}`;
    const selectedPath = `selected/${actionSegment}/${number}_${selectedName}`;
    const motherPath = `mothers/${actionSegment}/${number}_${motherName}`;
    const referencePath = `references/${actionSegment}/${number}_${referenceName}`;
    const selectedImage = await inspectPng(item.selected.absolute, selectedPath, true);
    const motherImage = await inspectPng(item.mother.absolute, motherPath, true);
    const referenceImage = await inspectPng(item.reference.absolute, referencePath, false);
    verifyExpectedHash(selectedImage.sha256, item.entry.hd_sha256 ?? item.entry.source_manifest_entry?.hd_sha256, selectedPath);
    verifyExpectedHash(motherImage.sha256, item.entry.native_sha256 ?? item.entry.source_manifest_entry?.native_sha256, motherPath);
    verifyExpectedHash(referenceImage.sha256, item.entry.source_manifest_entry?.sha256, referencePath);
    const logical = dimensions(item.entry.logical_canvas, `${item.entry.action}.logical_canvas`);
    const texture = dimensions(item.entry.texture_canvas, `${item.entry.action}.texture_canvas`);
    const pixelsPerUnit = validPositiveInteger(item.entry.texture_pixels_per_logical_pixel, `${item.entry.action}.texture_pixels_per_logical_pixel`);
    if (selectedImage.width !== texture[0] || selectedImage.height !== texture[1] || texture[0] / logical[0] !== pixelsPerUnit || texture[1] / logical[1] !== pixelsPerUnit) {
      throw new Error(`${item.entry.action}[${item.entry.entry_index}] texture/logical multiplier does not match decoded PNG dimensions`);
    }
    const native = dimensions(item.entry.native_canvas, `${item.entry.action}.native_canvas`);
    if (motherImage.width !== native[0] || motherImage.height !== native[1]) throw new Error(`${motherPath} dimensions differ from native_canvas`);
    const referenceGeometry = confirmedReferenceGeometry(confirmedCanvasPolicy, manifestPath, allowedRoot, logical, referenceImage);

    const selectedRecord: SourceRecord = { id: selectedId, path: selectedPath, name: selectedName, role: "pose", sha256: selectedImage.sha256 };
    const motherRecord: SourceRecord = { id: motherId, path: motherPath, name: motherName, role: "mother", sha256: motherImage.sha256 };
    const referenceRecord: SourceRecord = { id: referenceId, path: referencePath, name: referenceName, role: "reference", sha256: referenceImage.sha256 };
    fileRecords.push(selectedRecord, motherRecord, referenceRecord);
    zipInputs.push(
      { localPath: item.selected.absolute, archivePath: selectedPath, expectedBytes: selectedImage.bytes, expectedSha256: selectedImage.sha256 },
      { localPath: item.mother.absolute, archivePath: motherPath, expectedBytes: motherImage.bytes, expectedSha256: motherImage.sha256 },
      { localPath: item.reference.absolute, archivePath: referencePath, expectedBytes: referenceImage.bytes, expectedSha256: referenceImage.sha256 },
    );
    totalSourceBytes += selectedImage.bytes + motherImage.bytes + referenceImage.bytes;
    if (totalSourceBytes > MAX_TOTAL_BYTES) throw new Error("retention source set exceeds the total byte budget");

    const historical = compactHistoricalValue(item.entry.historical_review);
    const originalSourceEntry = JSON.parse(compactHistoricalValue(item.entry.source_manifest_entry)) as unknown;
    const sourceNote = JSON.stringify({
      source_action: item.entry.action,
      playback_group: item.entry.playback_group,
      source_manifest_action: item.entry.source_manifest_action ?? null,
      historical_review: JSON.parse(historical) as unknown,
      source_manifest_entry: originalSourceEntry,
      user_accepted_for_retention: item.entry.user_accepted_for_retention,
      selected_for_future_package: item.entry.selected_for_future_package,
    });
    if (sourceNote.length > 2_048) throw new Error("retention note exceeds the sequence field limit");
    const candidateFrameValue = item.entry.candidate_frame ?? item.entry.source_manifest_entry?.candidate_frame;
    const candidateFrame = typeof candidateFrameValue === "number" && Number.isSafeInteger(candidateFrameValue)
      ? candidateFrameValue
      : undefined;
    poses.push({
      id: poseId,
      file_id: selectedId,
      mother_file_id: motherId,
      label: `${item.entry.action} ${item.entry.entry_index}`,
      width: selectedImage.width,
      height: selectedImage.height,
      logical_width: logical[0],
      logical_height: logical[1],
      pixels_per_unit: pixelsPerUnit,
      source: {
        version: item.entry.source_version ?? "unknown",
        ...(candidateFrame === undefined ? {} : { frame_index: candidateFrame }),
        note: sourceNote,
      },
    });
    sequenceEntries.push({
      id: `entry-${number}`,
      action: item.entry.playback_group,
      pose_id: poseId,
      reference_file_id: referenceId,
      ...(referenceGeometry ? { reference_geometry: referenceGeometry } : {}),
      hold_ticks: item.entry.hold,
      original_hold_ticks: item.entry.hold,
      locked: true,
      translate_x: 0,
      translate_y: 0,
    });
    totalTicks += item.entry.hold;
    sourceLedger.push(
      {
        file_id: selectedId,
        kind: "selected-pose",
        source_action: item.entry.action,
        playback_group: item.entry.playback_group,
        source: item.selected.relative,
        sha256: selectedImage.sha256,
        geometry: { image_width: selectedImage.width, image_height: selectedImage.height, logical_canvas_width: logical[0], logical_canvas_height: logical[1], pixels_per_logical_pixel: pixelsPerUnit, mapping: "declared-and-validated" },
      },
      {
        file_id: motherId,
        kind: "native-mother",
        source_action: item.entry.action,
        playback_group: item.entry.playback_group,
        source: item.mother.relative,
        sha256: motherImage.sha256,
        geometry: { image_width: motherImage.width, image_height: motherImage.height, declared_native_width: native[0], declared_native_height: native[1], logical_canvas_width: logical[0], logical_canvas_height: logical[1], pixels_per_logical_pixel: null, mapping: "native-scale-not-inferred" },
      },
      {
        file_id: referenceId,
        kind: "original-reference",
        source_action: item.entry.action,
        playback_group: item.entry.playback_group,
        source: item.reference.relative,
        sha256: referenceImage.sha256,
        geometry: {
          image_width: referenceImage.width,
          image_height: referenceImage.height,
          logical_canvas_width: referenceGeometry?.logical_width ?? null,
          logical_canvas_height: referenceGeometry?.logical_height ?? null,
          pixels_per_logical_pixel: referenceGeometry?.pixels_per_unit ?? null,
          source: referenceGeometry?.source ?? null,
          mapping: referenceGeometry ? "confirmed-retention-canvas-policy" : confirmedCanvasPolicy ? "unknown-source-dimensions-do-not-match-policy" : "unknown-no-confirmed-canvas-policy",
        },
      },
    );
  }

  const selection = raw.selection_basis ?? {};
  const sequence: AnimationSequence = validateAnimationSequence({
    schema_version: 1,
    title: String(raw.project?.name ?? raw.manifest_id ?? "Animation retention"),
    preview_fps: 30,
    tick_rate: null,
    tick_rate_verified: false,
    global_scale: 1,
    poses,
    entries: sequenceEntries,
    notes: `保留清单 ${String(raw.manifest_id ?? "unknown")} v${String(raw.version ?? "unknown")}；${String(selection.user_statement ?? "保留输入选择")}。30fps 仅用于预览，真实游戏 tick 未验证。`,
    user_accepted_for_retention: sequenceEntries.length === 18 && pending.every((item) => item.entry.user_accepted_for_retention),
    historical_review: `${String(raw.history_fields_policy ?? "")}; 原历史观察逐条保存在 pose.source.note；本包不生成自动审核通过结论。`.slice(0, 4_096),
  });
  if (sequence.entries.length !== 18 || totalTicks !== 140) throw new Error("retention package must preserve 18 entries and 140 original ticks");

  const manifest = {
    schema_version: 1,
    sequence,
    files: fileRecords,
    processor: { name: "pack-animation-retention", schema_version: 1 },
    timing: {
      status: "unknown-game-tick-rate",
      preview_fps: 30,
      tick_rate: null,
      tick_rate_verified: false,
      total_ticks: totalTicks,
      entry_holds: sequence.entries.map((entry) => ({ entry_id: entry.id, action: entry.action, hold_ticks: entry.hold_ticks, original_hold_ticks: entry.original_hold_ticks })),
    },
    audit: {
      user_accepted_for_retention: sequence.user_accepted_for_retention,
      historical_review: sequence.historical_review,
      automatic_review_pass: false,
      game_import: "unverified",
      video_included: false,
      geometry_policy: "Reference geometry is recorded only for the recognized retention manifest policy when decoded reference and logical dimensions match 64x64; other mappings remain unknown. Native-mother scale is not inferred.",
    },
    sources: sourceLedger,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  zipInputs.unshift({ buffer: manifestBytes, archivePath: "manifest.json" });
  if (zipInputs.length > 2_000) throw new Error("retention package exceeds the ZIP entry limit");

  const sourceSnapshot = await fs.mkdtemp(path.join(realOutputParent, `.${path.basename(outputPath)}.${randomUUID()}.sources-`));
  const tempPath = path.join(sourceSnapshot, "bundle.tmp.zip");
  let createdOutput = false;
  try {
    const frozenInputs: ZipInput[] = [zipInputs[0]];
    for (let index = 1; index < zipInputs.length; index += 1) {
      const input = zipInputs[index];
      if (!input.localPath || input.expectedBytes === undefined || !input.expectedSha256) {
        throw new Error(`source snapshot expectations are missing for ${input.archivePath}`);
      }
      const snapshotPath = path.join(sourceSnapshot, `${String(index).padStart(4, "0")}.png`);
      await copyVerifiedRetentionSource(input.localPath, snapshotPath, input.expectedBytes, input.expectedSha256);
      frozenInputs.push({ localPath: snapshotPath, archivePath: input.archivePath });
    }
    await writeZip(tempPath, frozenInputs);
    try {
      await fs.link(tempPath, outputPath);
      createdOutput = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("--output appeared during packaging; refusing to overwrite it");
      throw error;
    }
    const result = await fs.stat(outputPath);
    return { bytes: result.size, entryCount: zipInputs.length, ticks: totalTicks };
  } catch (error) {
    if (createdOutput) await fs.rm(outputPath, { force: true });
    throw error;
  } finally {
    await fs.rm(tempPath, { force: true });
    await fs.rm(sourceSnapshot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await createBundle(args);
    process.stdout.write(JSON.stringify({ status: "created", output: args.output, ...result }) + "\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void main();
}
