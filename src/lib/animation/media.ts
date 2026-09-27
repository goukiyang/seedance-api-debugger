import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import yazl from "yazl";
import packageInfo from "../../../package.json";
import { validateAnimationSequence } from "./schema";
import type {
  AnimationEntry,
  AnimationFileRole,
  AnimationImportResult,
  AnimationLocalFile,
  AnimationPose,
  AnimationSequence,
} from "./types";

const MAX_FILES = 2_000;
const MAX_SINGLE_BYTES = 1024 * 1024 * 1024;
const MAX_IMAGE_BYTES = 256 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2_147_483_647;
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_VIDEO_FRAMES = 600;
const MAX_VIDEO_DURATION_SECONDS = 60;
const MAX_PROCESS_OUTPUT = 6 * 1024 * 1024;
const PROCESSOR_TIMEOUT_MS = 30_000;
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE_SET = new Set<AnimationFileRole>(["pose", "mother", "reference", "video", "candidate"]);
const SAFE_EXTRACT_SCRIPT = path.resolve(process.cwd(), "scripts/animation-safe-extract.py");

export function checkedAnimationByteBudget(currentBytes: number, addedBytes: number, limitBytes = MAX_TOTAL_BYTES): number {
  if (![currentBytes, addedBytes, limitBytes].every(Number.isSafeInteger) || currentBytes < 0 || addedBytes < 0 || limitBytes <= 0) {
    throw new RangeError("animation media byte budget values must be non-negative safe integers");
  }
  const total = currentBytes + addedBytes;
  if (!Number.isSafeInteger(total) || total > limitBytes) throw new RangeError("animation media byte budget exceeded");
  return total;
}

function byteLimitTransform(limitBytes: number, errorMessage: string): Transform {
  let writtenBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        writtenBytes = checkedAnimationByteBudget(writtenBytes, chunk.length, limitBytes);
      } catch {
        callback(new Error(errorMessage));
        return;
      }
      callback(null, chunk);
    },
  });
}

interface BundleFileRecord {
  id: string;
  path: string;
  name: string;
  role: AnimationFileRole;
  sha256?: string;
}

interface BundleManifest {
  schema_version: 1;
  sequence: AnimationSequence;
  files: BundleFileRecord[];
  [key: string]: unknown;
}

interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
}

interface MediaInspection {
  sha256: string;
  bytes: number;
  mime: "image/png" | "video/mp4";
  width: number;
  height: number;
  hasAlpha: boolean;
  frameCount?: number;
  durationSeconds?: number;
}

interface OutputEntry {
  localPath: string;
  archivePath: string;
  record: BundleFileRecord;
  inspection: MediaInspection;
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalDirectory(directoryPath: string): Promise<string> {
  const realPath = await fs.realpath(path.resolve(directoryPath));
  if (!(await fs.stat(realPath)).isDirectory()) throw new Error("expected an existing directory");
  return realPath;
}

async function newPathInDirectory(targetPath: string): Promise<{ parent: string; target: string }> {
  const absolute = path.resolve(targetPath);
  const parent = await canonicalDirectory(path.dirname(absolute));
  return { parent, target: path.join(parent, path.basename(absolute)) };
}

async function assertRegularFile(filePath: string, maxBytes = MAX_SINGLE_BYTES): Promise<{ bytes: number; realPath: string }> {
  const absolute = path.resolve(filePath);
  const realParent = await fs.realpath(path.dirname(absolute));
  const realPath = path.join(realParent, path.basename(absolute));
  const info = await fs.lstat(realPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("media input must be a regular non-symlink file");
  if (info.size <= 0 || info.size > maxBytes) throw new Error(`media input size is outside the ${maxBytes}-byte limit`);
  if (await fs.realpath(realPath) !== realPath) throw new Error("media input path changed during validation");
  return { bytes: info.size, realPath };
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    throwIfAborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function runProcess(
  executable: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes?: number; signal?: AbortSignal },
): Promise<ProcessResult> {
  throwIfAborted(options.signal);
  const maxOutput = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 300);
    };
    const onAbort = () => terminate(abortError());
    const timeout = setTimeout(() => terminate(new Error(`${executable} exceeded its time budget`)), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      if (terminationError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) return terminate(new Error(`${executable} exceeded its output limit`));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (terminationError) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutput) return terminate(new Error(`${executable} exceeded its diagnostic output limit`));
      stderr.push(chunk);
    });
    child.on("error", (error) => terminate(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminationError) {
        reject(terminationError);
        return;
      }
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code !== 0) {
        const detail = result.stderr.toString("utf8").trim().slice(0, 1200);
        reject(new Error(`${executable} failed (${signal ?? code})${detail ? `: ${detail}` : ""}`));
      } else {
        resolve(result);
      }
    });
  });
}

function safeBundlePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) throw new TypeError("bundle file path is invalid");
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new TypeError(`unsafe bundle path: ${value}`);
  }
  if (value.normalize("NFC") !== value) throw new TypeError(`bundle path is not NFC-normalized: ${value}`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.length > 255 || part.includes(":"))) {
    throw new TypeError(`unsafe bundle path segment: ${value}`);
  }
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not supported`);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(input, key)) throw new TypeError(`${label}.${key} is required`);
}

function validateBundleManifest(value: unknown): BundleManifest {
  const input = object(value, "manifest");
  exactKeys(input, ["schema_version", "sequence", "files"], ["processor", "audit", "timing", "sources", "transformations"], "manifest");
  if (input.schema_version !== 1) throw new TypeError("manifest.schema_version must be 1");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) {
    throw new TypeError(`manifest.files must contain between 1 and ${MAX_FILES} records`);
  }

  const paths = new Map<string, string>();
  const ids = new Set<string>();
  const files = input.files.map((raw, index): BundleFileRecord => {
    const item = object(raw, `manifest.files[${index}]`);
    exactKeys(item, ["id", "path", "name", "role"], ["sha256"], `manifest.files[${index}]`);
    if (typeof item.id !== "string" || !ID_PATTERN.test(item.id) || ids.has(item.id)) {
      throw new TypeError(`manifest.files[${index}].id is invalid or duplicated`);
    }
    ids.add(item.id);
    const filePath = safeBundlePath(item.path);
    if (filePath === "manifest.json") throw new TypeError("media path cannot be manifest.json");
    const folded = filePath.normalize("NFKC").toLocaleLowerCase("und");
    const previous = paths.get(folded);
    if (previous) throw new TypeError(`bundle paths collide after Unicode/case normalization: ${previous}, ${filePath}`);
    paths.set(folded, filePath);
    if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 255) {
      throw new TypeError(`manifest.files[${index}].name is invalid`);
    }
    if (typeof item.role !== "string" || !ROLE_SET.has(item.role as AnimationFileRole)) {
      throw new TypeError(`manifest.files[${index}].role is invalid`);
    }
    if (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256))) {
      throw new TypeError(`manifest.files[${index}].sha256 is invalid`);
    }
    const extension = path.posix.extname(filePath).toLowerCase();
    const role = item.role as AnimationFileRole;
    if (extension === ".png") {
      if (role === "video") throw new TypeError("video role must contain an MP4 file");
    } else if (extension === ".mp4") {
      if (role !== "video" && role !== "candidate") throw new TypeError("MP4 files are allowed only for video or candidate roles");
    } else {
      throw new TypeError(`unsupported media extension: ${extension || "(none)"}`);
    }
    return {
      id: item.id,
      path: filePath,
      name: item.name,
      role,
      ...(typeof item.sha256 === "string" ? { sha256: item.sha256.toLowerCase() } : {}),
    };
  });
  return {
    schema_version: 1,
    sequence: validateAnimationSequence(input.sequence),
    files,
    ...Object.fromEntries(["processor", "audit", "timing", "sources", "transformations"].filter((key) => input[key] !== undefined).map((key) => [key, input[key]])),
  };
}

function referencedFileIds(sequence: AnimationSequence): Set<string> {
  const ids = new Set<string>();
  for (const pose of sequence.poses) {
    ids.add(pose.file_id);
    if (pose.mother_file_id) ids.add(pose.mother_file_id);
    if (pose.source.video_file_id) ids.add(pose.source.video_file_id);
  }
  for (const entry of sequence.entries) if (entry.reference_file_id) ids.add(entry.reference_file_id);
  return ids;
}

function assertSequenceFiles(sequence: AnimationSequence, files: Array<{ id: string; role: AnimationFileRole }>): Map<string, { id: string; role: AnimationFileRole }> {
  if (files.length > MAX_FILES) throw new TypeError(`media file count exceeds ${MAX_FILES}`);
  const byId = new Map<string, { id: string; role: AnimationFileRole }>();
  for (const file of files) {
    if (!ID_PATTERN.test(file.id) || byId.has(file.id)) throw new TypeError(`duplicate or invalid media file id: ${file.id}`);
    byId.set(file.id, file);
  }
  for (const id of Array.from(referencedFileIds(sequence))) if (!byId.has(id)) throw new TypeError(`sequence references missing file ${id}`);
  for (const pose of sequence.poses) {
    const image = byId.get(pose.file_id)!;
    if (image.role !== "pose" && image.role !== "candidate") throw new TypeError(`pose ${pose.id} must reference a pose or candidate file`);
    if (pose.mother_file_id && byId.get(pose.mother_file_id)!.role !== "mother") {
      throw new TypeError(`pose ${pose.id} mother_file_id must reference a mother file`);
    }
    if (pose.source.video_file_id) {
      const source = byId.get(pose.source.video_file_id)!;
      if (source.role !== "video" && source.role !== "candidate") throw new TypeError(`pose ${pose.id} source video has an invalid role`);
    }
  }
  for (const entry of sequence.entries) {
    const referenceId = entry.reference_file_id;
    if (referenceId) {
      const reference = byId.get(referenceId)!;
      if (reference.role !== "reference" && reference.role !== "candidate" && reference.role !== "pose") {
        throw new TypeError(`entry ${entry.id} reference_file_id has an invalid role`);
      }
    }
  }
  return byId;
}

function assertReferenceGeometryMatches(
  entry: AnimationEntry,
  reference: Pick<MediaInspection, "width" | "height">,
  required: boolean,
): boolean {
  const geometry = entry.reference_geometry;
  if (!geometry) {
    if (required) throw new Error(`reference geometry is required for entry ${entry.id}`);
    return false;
  }
  const matches = (pixels: number, logical: number): boolean => {
    const ratio = pixels / logical;
    return Math.abs(ratio - geometry.pixels_per_unit) <= Math.max(1e-6, geometry.pixels_per_unit * 1e-6);
  };
  if (!matches(reference.width, geometry.logical_width) || !matches(reference.height, geometry.logical_height)) {
    throw new Error(`reference_geometry for entry ${entry.id} does not match decoded PNG dimensions`);
  }
  return true;
}

async function runSafeExtract(zipPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  const result = await runProcess(
    "python3",
    [
      SAFE_EXTRACT_SCRIPT,
      "--zip", zipPath,
      "--output", outputPath,
      "--max-files", String(MAX_FILES),
      "--max-single-bytes", String(MAX_SINGLE_BYTES),
      "--max-total-bytes", String(MAX_TOTAL_BYTES),
      "--max-archive-bytes", String(MAX_TOTAL_BYTES),
      "--max-manifest-bytes", String(4 * 1024 * 1024),
      "--max-seconds", "120",
    ],
    { timeoutMs: 125_000, maxOutputBytes: 64 * 1024, signal },
  );
  try {
    const summary = JSON.parse(result.stdout.toString("utf8")) as { member_count?: unknown; total_bytes?: unknown };
    if (!Number.isSafeInteger(summary.member_count) || (summary.member_count as number) < 1 || (summary.member_count as number) > MAX_FILES + 1 ||
      typeof summary.total_bytes !== "number" || summary.total_bytes < 1 || summary.total_bytes > MAX_TOTAL_BYTES) {
      throw new Error("safe extractor returned an invalid byte summary");
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("safe extractor returned invalid status data");
    throw error;
  }
}

async function readManifest(extractedRoot: string): Promise<BundleManifest> {
  const manifestPath = path.join(extractedRoot, "manifest.json");
  const info = await fs.stat(manifestPath);
  if (info.size > 4 * 1024 * 1024) throw new Error("manifest exceeds its byte limit");
  return validateBundleManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown);
}

async function readPrefix(filePath: string, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function probeVideo(filePath: string, signal?: AbortSignal): Promise<{ width: number; height: number; frameCount: number; durationSeconds: number }> {
  const metadataResult = await runProcess(
    "ffprobe",
    [
      "-v", "error", "-protocol_whitelist", "file,pipe,data", "-threads:v", "1", "-max_alloc", String(256 * 1024 * 1024),
      "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height:format=duration",
      "-of", "json", filePath,
    ],
    { timeoutMs: PROCESSOR_TIMEOUT_MS, maxOutputBytes: 64 * 1024, signal },
  );
  const parsed = JSON.parse(metadataResult.stdout.toString("utf8")) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string | number }>;
    format?: { duration?: string | number };
  };
  const stream = parsed.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const durationSeconds = Number(stream?.duration ?? parsed.format?.duration);
  if (stream?.codec_type !== "video" || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("MP4 does not contain a readable video stream");
  }
  if (width > 16_384 || height > 16_384 || width * height > MAX_IMAGE_PIXELS) throw new Error("video frame dimensions exceed the pixel limit");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error(`video duration must be no greater than ${MAX_VIDEO_DURATION_SECONDS} seconds`);
  }

  const countResult = await runProcess(
    "ffprobe",
    [
      "-v", "error", "-protocol_whitelist", "file,pipe,data", "-threads:v", "1", "-max_alloc", String(256 * 1024 * 1024),
      "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames",
      "-of", "json", filePath,
    ],
    { timeoutMs: PROCESSOR_TIMEOUT_MS, maxOutputBytes: 64 * 1024, signal },
  );
  const counted = JSON.parse(countResult.stdout.toString("utf8")) as {
    streams?: Array<{ nb_read_frames?: string | number }>;
  };
  const frameCount = Number(counted.streams?.[0]?.nb_read_frames);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > MAX_VIDEO_FRAMES) {
    throw new Error(`video must contain between 1 and ${MAX_VIDEO_FRAMES} decoded frames`);
  }
  return { width, height, frameCount, durationSeconds };
}

async function inspectMediaFile(
  filePath: string,
  role: AnimationFileRole,
  expected?: { bytes?: number; sha256?: string; mime?: string; width?: number | null; height?: number | null },
  signal?: AbortSignal,
): Promise<MediaInspection> {
  const extension = path.extname(filePath).toLowerCase();
  const maxBytes = extension === ".mp4" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const stat = await assertRegularFile(filePath, maxBytes);
  if (expected?.bytes !== undefined && expected.bytes !== stat.bytes) throw new Error(`file byte count changed: ${path.basename(filePath)}`);
  const sha256 = await hashFile(filePath, signal);
  if (expected?.sha256 && expected.sha256.toLowerCase() !== sha256) throw new Error(`SHA-256 mismatch: ${path.basename(filePath)}`);

  if (extension === ".png") {
    if (role === "video") throw new Error("video role cannot contain PNG data");
    const signature = await readPrefix(filePath, 8);
    if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`PNG signature mismatch: ${path.basename(filePath)}`);
    const image = sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error", sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
      throw new Error(`invalid PNG image: ${path.basename(filePath)}`);
    }
    await image.stats();
    if (expected?.mime && expected.mime !== "image/png") throw new Error(`declared MIME does not match PNG bytes: ${path.basename(filePath)}`);
    if (expected?.width != null && expected.width !== metadata.width) throw new Error(`declared width does not match PNG: ${path.basename(filePath)}`);
    if (expected?.height != null && expected.height !== metadata.height) throw new Error(`declared height does not match PNG: ${path.basename(filePath)}`);
    return {
      sha256,
      bytes: stat.bytes,
      mime: "image/png",
      width: metadata.width,
      height: metadata.height,
      hasAlpha: Boolean(metadata.hasAlpha),
    };
  }

  if (extension === ".mp4") {
    if (role !== "video" && role !== "candidate") throw new Error("MP4 is allowed only as video or candidate media");
    const header = await readPrefix(filePath, 12);
    if (header.length < 12 || header.toString("ascii", 4, 8) !== "ftyp") throw new Error(`MP4 ftyp signature mismatch: ${path.basename(filePath)}`);
    const probe = await probeVideo(stat.realPath, signal);
    if (expected?.mime && expected.mime !== "video/mp4") throw new Error(`declared MIME does not match MP4 bytes: ${path.basename(filePath)}`);
    if (expected?.width != null && expected.width !== probe.width) throw new Error(`declared width does not match MP4: ${path.basename(filePath)}`);
    if (expected?.height != null && expected.height !== probe.height) throw new Error(`declared height does not match MP4: ${path.basename(filePath)}`);
    return { sha256, bytes: stat.bytes, mime: "video/mp4", width: probe.width, height: probe.height, hasAlpha: false, frameCount: probe.frameCount, durationSeconds: probe.durationSeconds };
  }
  throw new Error(`unsupported media extension: ${extension || "(none)"}`);
}

function safeDisplayName(value: string, extension: string): string {
  const basename = path.posix.basename(value.replace(/\\/g, "/"));
  const sanitized = basename.replace(/[\u0000-\u001f\u007f]/g, "_").trim().slice(0, 240);
  return `${sanitized.replace(/\.[^.]*$/, "") || "media"}${extension}`;
}

function extensionForMime(mime: string): ".png" | ".mp4" {
  if (mime === "image/png") return ".png";
  if (mime === "video/mp4") return ".mp4";
  throw new Error(`unsupported verified MIME ${mime}`);
}

function remapSequenceFileReferences(sequence: AnimationSequence, idMap: Map<string, string>): AnimationSequence {
  const remap = (id: string | undefined): string | undefined => id === undefined ? undefined : idMap.get(id) ?? (() => { throw new Error(`file reference ${id} was not imported`); })();
  return {
    ...sequence,
    poses: sequence.poses.map((pose) => ({
      ...pose,
      file_id: remap(pose.file_id)!,
      ...(pose.mother_file_id ? { mother_file_id: remap(pose.mother_file_id)! } : {}),
      source: { ...pose.source, ...(pose.source.video_file_id ? { video_file_id: remap(pose.source.video_file_id)! } : {}) },
    })),
    entries: sequence.entries.map((entry) => ({
      ...entry,
      ...(entry.reference_file_id ? { reference_file_id: remap(entry.reference_file_id)! } : {}),
    })),
  };
}

export async function importAnimationBundle(zipPath: string, outputDir: string): Promise<AnimationImportResult> {
  const archiveInfo = await assertRegularFile(zipPath, MAX_TOTAL_BYTES);
  const outputPath = await newPathInDirectory(outputDir);
  const outputAbsolute = outputPath.target;
  const parent = outputPath.parent;
  const baseName = path.basename(outputAbsolute);
  if (!baseName || baseName === "." || baseName === "..") throw new Error("outputDir must name a new directory");
  try {
    await fs.lstat(outputAbsolute);
    throw new Error("outputDir already exists; import never overwrites existing output");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (archiveInfo.bytes > MAX_TOTAL_BYTES) throw new Error("compressed bundle exceeds its byte limit");

  const staging = await fs.mkdtemp(path.join(parent, `.${baseName}.animation-import-`));
  const extractedRoot = path.join(staging, "extracted");
  const finalRoot = path.join(staging, "final");
  const warnings: string[] = [];
  let outputClaim: { dev: number; ino: number; links: Array<{ target: string; dev: number; ino: number }> } | undefined;
  try {
    await runSafeExtract(archiveInfo.realPath, extractedRoot);
    const manifest = await readManifest(extractedRoot);
    const fileById = assertSequenceFiles(manifest.sequence, manifest.files);
    const idMap = new Map<string, string>();
    const localFiles: AnimationLocalFile[] = [];
    const declaredPaths = new Set<string>(["manifest.json"]);
    let totalBytes = 0;

    await fs.mkdir(finalRoot, { mode: 0o700 });
    for (const record of manifest.files) {
      const sourcePath = path.resolve(extractedRoot, ...record.path.split("/"));
      if (!isWithin(extractedRoot, sourcePath) || declaredPaths.has(record.path)) throw new Error(`unsafe or duplicate extracted path: ${record.path}`);
      declaredPaths.add(record.path);
      const inspection = await inspectMediaFile(sourcePath, record.role, { sha256: record.sha256 });
      totalBytes += inspection.bytes;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("bundle media exceeds its total byte limit");
      if ((record.role === "pose" || record.role === "mother" || record.role === "candidate") && inspection.mime === "image/png" && !inspection.hasAlpha) {
        warnings.push(`${record.name}: PNG has no alpha channel`);
      }
      const randomId = randomUUID();
      const extension = extensionForMime(inspection.mime);
      const localName = `${randomId}${extension}`;
      const targetPath = path.join(finalRoot, localName);
      await fs.rename(sourcePath, targetPath);
      idMap.set(record.id, randomId);
      localFiles.push({
        id: randomId,
        name: safeDisplayName(record.name, extension),
        role: record.role,
        mime: inspection.mime,
        bytes: inspection.bytes,
        sha256: inspection.sha256,
        width: inspection.width,
        height: inspection.height,
        path: path.join(outputAbsolute, localName),
      });
    }

    for (const pose of manifest.sequence.poses) {
      const file = localFiles.find((item) => item.id === idMap.get(pose.file_id));
      if (!file) throw new Error(`pose ${pose.id} file was not imported`);
      if (file.mime !== "image/png") throw new Error(`pose ${pose.id} must reference PNG media`);
      if (file.width !== pose.width || file.height !== pose.height) throw new Error(`pose ${pose.id} dimensions do not match the decoded PNG`);
    }
    for (const pose of manifest.sequence.poses) {
      const motherFileId = pose.mother_file_id;
      if (motherFileId && !fileById.has(motherFileId)) throw new Error(`pose ${pose.id} mother file is missing`);
      const videoFileId = pose.source.video_file_id;
      if (videoFileId) {
        if (!fileById.has(videoFileId)) throw new Error(`pose ${pose.id} source video is missing`);
        const video = localFiles.find((item) => item.id === idMap.get(videoFileId));
        if (video?.mime !== "video/mp4") throw new Error(`pose ${pose.id} source_video_file_id must reference an MP4`);
      }
    }
    for (const entry of manifest.sequence.entries) {
      const referenceId = entry.reference_file_id;
      if (!referenceId) continue;
      const reference = localFiles.find((item) => item.id === idMap.get(referenceId));
      if (reference?.mime !== "image/png") throw new Error(`entry ${entry.id} reference_file_id must reference a PNG`);
    }

    const importedSequence = validateAnimationSequence(remapSequenceFileReferences(manifest.sequence, idMap));
    const importedFilesById = new Map(localFiles.map((file) => [file.id, file]));
    for (const entry of importedSequence.entries) {
      const referenceId = entry.reference_file_id;
      if (!referenceId) continue;
      const reference = importedFilesById.get(referenceId)!;
      if (reference.width === null || reference.height === null) throw new Error(`reference PNG dimensions are unavailable for entry ${entry.id}`);
      assertReferenceGeometryMatches(entry, { width: reference.width, height: reference.height }, false);
    }

    await fs.mkdir(outputAbsolute, { mode: 0o700 });
    const claimedStat = await fs.lstat(outputAbsolute);
    if (!claimedStat.isDirectory() || claimedStat.isSymbolicLink()) throw new Error("claimed import output is not a plain directory");
    const acquiredClaim: NonNullable<typeof outputClaim> = { dev: claimedStat.dev, ino: claimedStat.ino, links: [] };
    outputClaim = acquiredClaim;
    const outputHandle = await fs.open(outputAbsolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const outputStat = await outputHandle.stat();
      if (!outputStat.isDirectory() || outputStat.dev !== acquiredClaim.dev || outputStat.ino !== acquiredClaim.ino) {
        throw new Error("claimed import output changed while opening");
      }
    } finally {
      await outputHandle.close();
    }
    const claim = outputClaim;
    if (!claim) throw new Error("import output claim was not established");
    for (const file of localFiles) {
      const directoryInfo = await fs.lstat(outputAbsolute);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.dev !== claim.dev || directoryInfo.ino !== claim.ino) {
        throw new Error("claimed import output changed during publication");
      }
      const sourcePath = path.join(finalRoot, path.basename(file.path));
      const targetPath = path.join(outputAbsolute, path.basename(file.path));
      const sourceBefore = await fs.lstat(sourcePath);
      await fs.link(sourcePath, targetPath);
      claim.links.push({ target: targetPath, dev: sourceBefore.dev, ino: sourceBefore.ino });
      const [sourceAfter, targetStat] = await Promise.all([fs.lstat(sourcePath), fs.lstat(targetPath)]);
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || sourceAfter.dev !== targetStat.dev || sourceAfter.ino !== targetStat.ino) {
        throw new Error(`import output link verification failed for ${file.id}`);
      }
    }
    const publishedDirectory = await fs.lstat(outputAbsolute);
    if (!publishedDirectory.isDirectory() || publishedDirectory.isSymbolicLink() || publishedDirectory.dev !== claim.dev || publishedDirectory.ino !== claim.ino) {
      throw new Error("claimed import output changed before publication");
    }
    outputClaim = undefined;
    return {
      sequence: importedSequence,
      files: localFiles.map((file) => ({ ...file, path: path.join(outputAbsolute, path.basename(file.path)) })),
      warnings,
    };
  } catch (error) {
    if (outputClaim) {
      try {
        const current = await fs.lstat(outputAbsolute);
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === outputClaim.dev && current.ino === outputClaim.ino) {
          for (const link of outputClaim.links) {
            try {
              const info = await fs.lstat(link.target);
              if (info.isFile() && !info.isSymbolicLink() && info.dev === link.dev && info.ino === link.ino) await fs.unlink(link.target);
            } catch (cleanupError) {
              if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
            }
          }
          await fs.rmdir(outputAbsolute);
        }
      } catch {
        // Preserve the path if ownership cannot be proven or external content remains.
      }
    }
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function validateLocalFile(file: AnimationLocalFile, signal?: AbortSignal): Promise<MediaInspection> {
  if (!ID_PATTERN.test(file.id) || !ROLE_SET.has(file.role)) throw new TypeError(`invalid local file record ${file.id}`);
  if (!path.isAbsolute(file.path)) throw new TypeError("local media paths must be absolute");
  if (!file.sha256 || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new TypeError(`local file ${file.id} has no valid SHA-256`);
  return inspectMediaFile(file.path, file.role, { bytes: file.bytes, sha256: file.sha256, mime: file.mime, width: file.width, height: file.height }, signal);
}

async function writeZip(zipPath: string, files: Array<{ localPath?: string; buffer?: Buffer; archivePath: string; compress?: boolean }>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const zip = new yazl.ZipFile();
  const output = createWriteStream(zipPath, { flags: "wx", mode: 0o600 });
  const writing = pipeline(
    zip.outputStream as NodeJS.ReadableStream,
    byteLimitTransform(MAX_TOTAL_BYTES, "export ZIP exceeds the 2,147,483,647-byte limit"),
    output,
    signal ? { signal } : {},
  );
  try {
    for (const file of files) {
      throwIfAborted(signal);
      const compress = file.compress ?? false;
      const options = {
        mtime: FIXED_ZIP_DATE,
        mode: 0o100600,
        compress,
        ...(compress ? { compressionLevel: 6 } : {}),
        forceDosTimestamp: true,
      };
      if (file.localPath) zip.addFile(file.localPath, file.archivePath, options);
      else if (file.buffer) zip.addBuffer(file.buffer, file.archivePath, options);
      else throw new Error(`ZIP entry ${file.archivePath} has no source`);
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

async function linkNoReplace(source: string, target: string): Promise<void> {
  await fs.link(source, target);
}

function geometryForOutput(pose: AnimationPose, width: number, height: number): Pick<AnimationPose, "width" | "height" | "logical_width" | "logical_height" | "pixels_per_unit"> {
  if (pose.pixels_per_unit === null) {
    return { width, height, logical_width: null, logical_height: null, pixels_per_unit: null };
  }
  return {
    width,
    height,
    logical_width: width / pose.pixels_per_unit,
    logical_height: height / pose.pixels_per_unit,
    pixels_per_unit: pose.pixels_per_unit,
  };
}

async function bakeTransform(
  sourcePath: string,
  destinationPath: string,
  pose: AnimationPose,
  scale: number,
  translateX: number,
  translateY: number,
  signal?: AbortSignal,
): Promise<{ width: number; height: number; bytes: number; translate_pixels_x: number; translate_pixels_y: number; padding: { top: number; right: number; bottom: number; left: number } }> {
  if ((translateX !== 0 || translateY !== 0) && pose.pixels_per_unit === null) {
    throw new Error(`pose ${pose.id} has logical translation but no trusted pixels_per_unit`);
  }
  const metadata = await sharp(sourcePath, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error", sequentialRead: true }).metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height) throw new Error(`pose ${pose.id} is not a valid PNG`);
  const resizedWidth = Math.max(1, Math.round(metadata.width * scale));
  const resizedHeight = Math.max(1, Math.round(metadata.height * scale));
  const ppu = pose.pixels_per_unit;
  const shiftX = ppu === null ? 0 : translateX * ppu;
  const shiftY = ppu === null ? 0 : translateY * ppu;
  const offsetX = Math.ceil(Math.abs(shiftX));
  const offsetY = Math.ceil(Math.abs(shiftY));
  const left = shiftX < 0 ? offsetX : 0;
  const right = shiftX > 0 ? offsetX : 0;
  const top = shiftY < 0 ? offsetY : 0;
  const bottom = shiftY > 0 ? offsetY : 0;
  const originX = left + shiftX;
  const originY = top + shiftY;
  const width = resizedWidth + left + right;
  const height = resizedHeight + top + bottom;
  if (width > 16_384 || height > 16_384 || width * height > MAX_IMAGE_PIXELS) throw new Error(`transform for pose ${pose.id} exceeds the image geometry limit`);
  throwIfAborted(signal);

  const resized = await sharp(sourcePath, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error", sequentialRead: true })
    .resize(resizedWidth, resizedHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer();
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    if ((y & 127) === 0) throwIfAborted(signal);
    const sourceY = y - originY;
    const y0 = Math.floor(sourceY);
    const fy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - originX;
      const x0 = Math.floor(sourceX);
      const fx = sourceX - x0;
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let dy = 0; dy <= 1; dy += 1) {
        const sy = y0 + dy;
        const wy = dy === 0 ? 1 - fy : fy;
        if (sy < 0 || sy >= resizedHeight || wy === 0) continue;
        for (let dx = 0; dx <= 1; dx += 1) {
          const sx = x0 + dx;
          const wx = dx === 0 ? 1 - fx : fx;
          if (sx < 0 || sx >= resizedWidth || wx === 0) continue;
          const sourceIndex = (sy * resizedWidth + sx) * 4;
          const weight = wx * wy;
          const sampleAlpha = resized[sourceIndex + 3] / 255;
          alpha += sampleAlpha * weight;
          red += resized[sourceIndex] * sampleAlpha * weight;
          green += resized[sourceIndex + 1] * sampleAlpha * weight;
          blue += resized[sourceIndex + 2] * sampleAlpha * weight;
        }
      }
      const targetIndex = (y * width + x) * 4;
      output[targetIndex + 3] = Math.round(alpha * 255);
      if (alpha > 0) {
        output[targetIndex] = Math.round(red / alpha);
        output[targetIndex + 1] = Math.round(green / alpha);
        output[targetIndex + 2] = Math.round(blue / alpha);
      }
    }
  }
  throwIfAborted(signal);
  const image = sharp(output, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: false });
  throwIfAborted(signal);
  const destination = createWriteStream(destinationPath, { flags: "wx", mode: 0o600 });
  await pipeline(
    image as NodeJS.ReadableStream,
    byteLimitTransform(MAX_IMAGE_BYTES, `transformed PNG for pose ${pose.id} exceeds the single-image byte limit`),
    destination,
    signal ? { signal } : {},
  );
  const stat = await assertRegularFile(destinationPath, MAX_IMAGE_BYTES);
  return {
    width,
    height,
    bytes: stat.bytes,
    translate_pixels_x: shiftX,
    translate_pixels_y: shiftY,
    padding: { top, right, bottom, left },
  };
}

async function verifyCompletedBundle(zipPath: string, workDir: string, expected: BundleManifest, signal?: AbortSignal): Promise<void> {
  const extracted = path.join(workDir, "verified");
  await runSafeExtract(zipPath, extracted, signal);
  const actual = await readManifest(extracted);
  if (actual.files.length !== expected.files.length || actual.sequence.entries.length !== expected.sequence.entries.length) {
    throw new Error("completed ZIP manifest did not survive validation");
  }
  const declared = new Map(actual.files.map((item) => [item.id, item]));
  const inspections = new Map<string, MediaInspection>();
  for (const expectedFile of expected.files) {
    const item = declared.get(expectedFile.id);
    if (!item || item.path !== expectedFile.path || item.sha256 !== expectedFile.sha256) throw new Error("completed ZIP file list differs from its staging manifest");
    const mediaPath = path.resolve(extracted, ...item.path.split("/"));
    const inspection = await inspectMediaFile(mediaPath, item.role, { sha256: item.sha256 }, signal);
    inspections.set(item.id, inspection);
    if (inspection.mime !== (path.extname(item.path).toLowerCase() === ".mp4" ? "video/mp4" : "image/png")) {
      throw new Error(`completed ZIP media type mismatch: ${item.path}`);
    }
  }
  validateAnimationSequence(actual.sequence);
  assertSequenceFiles(actual.sequence, actual.files);
  for (const entry of actual.sequence.entries) {
    const referenceId = entry.reference_file_id;
    if (!referenceId) continue;
    const inspection = inspections.get(referenceId);
    if (!inspection || inspection.mime !== "image/png") throw new Error(`completed ZIP reference for entry ${entry.id} is not a PNG`);
    assertReferenceGeometryMatches(entry, inspection, false);
  }
  if (JSON.stringify(actual.sequence) !== JSON.stringify(expected.sequence)) throw new Error("completed ZIP sequence differs from the validated export input");
}

export async function exportAnimationBundle(input: {
  sequence: AnimationSequence;
  files: AnimationLocalFile[];
  outputDir: string;
  mode: "work_copy" | "validated";
  signal?: AbortSignal;
}): Promise<{ path: string; bytes: number; sha256: string; entry_count: number; total_ticks: number; warnings: string[] }> {
  throwIfAborted(input.signal);
  if (input.mode !== "work_copy" && input.mode !== "validated") throw new TypeError("unsupported export mode");
  const sequence = validateAnimationSequence(input.sequence);
  const localById = new Map<string, AnimationLocalFile>();
  for (const file of input.files) {
    if (localById.has(file.id)) throw new TypeError(`duplicate local file id ${file.id}`);
    localById.set(file.id, file);
  }
  assertSequenceFiles(sequence, input.files);
  if (input.mode === "validated" && (sequence.tick_rate === null || !sequence.tick_rate_verified)) {
    throw new Error("validated export requires a present, explicitly verified tick_rate");
  }

  const outputRoot = await canonicalDirectory(input.outputDir);
  const workDir = await fs.mkdtemp(path.join(outputRoot, ".animation-export-"));
  let finalPath: string | undefined;
  let finalCreated = false;
  const warnings: string[] = [];
  try {
    const imagesDir = path.join(workDir, "images");
    await fs.mkdir(imagesDir, { mode: 0o700 });
    const inspected = new Map<string, MediaInspection>();
    const usedOriginalIds = referencedFileIds(sequence);
    for (const id of Array.from(usedOriginalIds)) {
      const file = localById.get(id);
      if (!file) throw new Error(`sequence references missing local file ${id}`);
      const inspection = await validateLocalFile(file, input.signal);
      inspected.set(id, inspection);
      if (file.mime === "image/png" && file.width != null && file.height != null && (file.width !== inspection.width || file.height !== inspection.height)) {
        throw new Error(`local file dimensions changed for ${file.id}`);
      }
    }
    for (const pose of sequence.poses) {
      if (pose.source.video_file_id && inspected.get(pose.source.video_file_id)?.mime !== "video/mp4") {
        throw new Error(`pose ${pose.id} source_video_file_id must reference an inspected MP4`);
      }
    }
    for (const entry of sequence.entries) {
      const referenceId = entry.reference_file_id;
      if (referenceId && inspected.get(referenceId)?.mime !== "image/png") {
        throw new Error(`entry ${entry.id} reference_file_id must reference an inspected PNG`);
      }
      if (referenceId) {
        const reference = inspected.get(referenceId)!;
        const hasReferenceGeometry = assertReferenceGeometryMatches(entry, reference, input.mode === "validated");
        if (!hasReferenceGeometry) warnings.push(`Entry ${entry.id} reference geometry is unknown; no scale was inferred.`);
      }
    }

    const poseById = new Map(sequence.poses.map((pose) => [pose.id, pose]));
    const exportedPoses: AnimationPose[] = [];
    const exportedEntries: AnimationEntry[] = [];
    const records = new Map<string, BundleFileRecord>();
    const outputFiles: OutputEntry[] = [];
    const transformRecords: Array<Record<string, unknown>> = [];
    const processedPoseTransforms = new Map<string, { poseId: string; fileId: string }>();
    let totalMediaBytes = 0;
    let derivedIndex = 0;
    let derivedPoseIndex = 0;
    const usedIds = new Set([
      ...sequence.poses.map((pose) => pose.id),
      ...sequence.entries.map((entry) => entry.id),
      ...input.files.map((file) => file.id),
    ]);
    const nextStableId = (prefix: string, index: number): string => {
      let suffix = index;
      let candidate = `${prefix}-${String(suffix).padStart(4, "0")}`;
      while (usedIds.has(candidate)) {
        suffix += 1;
        candidate = `${prefix}-${String(suffix).padStart(4, "0")}`;
      }
      usedIds.add(candidate);
      return candidate;
    };

    const includeOriginal = (fileId: string): string => {
      const existing = records.get(fileId);
      if (existing) return existing.path;
      const file = localById.get(fileId)!;
      const inspection = inspected.get(fileId)!;
      const extension = extensionForMime(inspection.mime);
      const archivePath = `assets/${fileId}${extension}`;
      const record: BundleFileRecord = {
        id: file.id,
        path: archivePath,
        name: safeDisplayName(file.name, extension),
        role: file.role,
        sha256: inspection.sha256,
      };
      records.set(fileId, record);
      outputFiles.push({ localPath: file.path, archivePath, record, inspection });
      return archivePath;
    };

    for (const fileId of Array.from(usedOriginalIds)) {
      totalMediaBytes = checkedAnimationByteBudget(totalMediaBytes, inspected.get(fileId)!.bytes);
      includeOriginal(fileId);
    }
    for (const entry of sequence.entries) {
      throwIfAborted(input.signal);
      const originalPose = poseById.get(entry.pose_id)!;
      const transformKey = JSON.stringify([originalPose.id, sequence.global_scale, entry.translate_x, entry.translate_y]);
      let mapped = processedPoseTransforms.get(transformKey);
      const transformed = sequence.global_scale !== 1 || entry.translate_x !== 0 || entry.translate_y !== 0;
      if (!mapped) {
        if (!transformed) {
          mapped = { poseId: originalPose.id, fileId: originalPose.file_id };
          processedPoseTransforms.set(transformKey, mapped);
          exportedPoses.push({ ...originalPose, source: { ...originalPose.source } });
        } else {
          const sourceFile = localById.get(originalPose.file_id)!;
          const derivedFileId = nextStableId("export-derived-file", ++derivedIndex);
          const derivedPoseId = nextStableId("export-derived-pose", ++derivedPoseIndex);
          const destination = path.join(imagesDir, `${derivedFileId}.png`);
          checkedAnimationByteBudget(totalMediaBytes, MAX_IMAGE_BYTES);
          const geometry = await bakeTransform(
            sourceFile.path,
            destination,
            originalPose,
            sequence.global_scale,
            entry.translate_x,
            entry.translate_y,
            input.signal,
          );
          totalMediaBytes = checkedAnimationByteBudget(totalMediaBytes, geometry.bytes);
          const inspection = await inspectMediaFile(destination, "pose", undefined, input.signal);
          if (inspection.bytes !== geometry.bytes) throw new Error(`transformed PNG size changed during inspection for pose ${originalPose.id}`);
          const outputPose: AnimationPose = {
            ...originalPose,
            id: derivedPoseId,
            file_id: derivedFileId,
            ...geometryForOutput(originalPose, geometry.width, geometry.height),
            source: { ...originalPose.source },
          };
          const archivePath = `poses/${derivedFileId}.png`;
          const record: BundleFileRecord = {
            id: derivedFileId,
            path: archivePath,
            name: safeDisplayName(`${originalPose.label}.png`, ".png"),
            role: "pose",
            sha256: inspection.sha256,
          };
          records.set(derivedFileId, record);
          outputFiles.push({ localPath: destination, archivePath, record, inspection });
          mapped = { poseId: derivedPoseId, fileId: derivedFileId };
          processedPoseTransforms.set(transformKey, mapped);
          exportedPoses.push(outputPose);
          transformRecords.push({
            entry_id: entry.id,
            source_pose_id: originalPose.id,
            source_file_id: originalPose.file_id,
            output_pose_id: derivedPoseId,
            output_file_id: derivedFileId,
            global_scale: sequence.global_scale,
            translate_x: entry.translate_x,
            translate_y: entry.translate_y,
            translate_pixels_x: geometry.translate_pixels_x,
            translate_pixels_y: geometry.translate_pixels_y,
            output_padding_pixels: geometry.padding,
            subpixel_sampling: "premultiplied-alpha-bilinear",
            applied: true,
            crop_detected: false,
          });
        }
      }
      if (originalPose.mother_file_id) includeOriginal(originalPose.mother_file_id);
      const referenceId = entry.reference_file_id;
      if (referenceId) includeOriginal(referenceId);
      if (originalPose.source.video_file_id) includeOriginal(originalPose.source.video_file_id);
      exportedEntries.push({ ...entry, pose_id: mapped.poseId, translate_x: 0, translate_y: 0 });
    }

    const transformedSequence: AnimationSequence = {
      ...sequence,
      global_scale: 1,
      poses: exportedPoses,
      entries: exportedEntries,
      ...(input.mode === "work_copy" ? { tick_rate: null, tick_rate_verified: false } : {}),
    };
    const checkedSequence = validateAnimationSequence(transformedSequence);
    assertSequenceFiles(checkedSequence, Array.from(records.values(), ({ id, role }) => ({ id, role })));
    for (const pose of checkedSequence.poses) {
      const file = records.get(pose.file_id) ?? outputFiles.find((entry) => entry.record.id === pose.file_id)?.record;
      const inspection = inspected.get(pose.file_id) ?? outputFiles.find((entry) => entry.record.id === pose.file_id)?.inspection;
      if (!file || !inspection) throw new Error(`exported pose ${pose.id} has no validated output file`);
      if (inspection.mime !== "image/png") throw new Error(`pose ${pose.id} must export as PNG media`);
      if (inspection.width !== pose.width || inspection.height !== pose.height) throw new Error(`exported pose ${pose.id} dimensions do not match its image`);
      if (input.mode === "validated" && !inspection.hasAlpha) throw new Error(`validated export requires an RGBA PNG for pose ${pose.id}`);
      if (pose.mother_file_id && input.mode === "validated") {
        const mother = inspected.get(pose.mother_file_id);
        if (!mother?.hasAlpha) throw new Error(`validated export requires an RGBA mother PNG for pose ${pose.id}`);
      }
    }
    if (input.mode === "validated") {
      for (const entry of checkedSequence.entries) {
        const pose = checkedSequence.poses.find((item) => item.id === entry.pose_id)!;
        if (pose.logical_width === null || pose.logical_height === null || pose.pixels_per_unit === null) {
          throw new Error(`validated export requires complete logical geometry for pose ${pose.id}`);
        }
      }
    } else {
      warnings.push("工作副本的 tick 速率标为未知；hold 保留原值，游戏内时长与导入结果仍未验证。");
      if (!sequence.tick_rate_verified || sequence.tick_rate === null) warnings.push("当前输入没有已验证的 tick 速率。");
      if (checkedSequence.poses.some((pose) => pose.pixels_per_unit === null)) warnings.push("部分候选帧缺少逻辑尺寸倍率；按原像素保留，未推断 native 尺寸适配比例。");
    }
    if (input.mode === "validated") warnings.push("validated 仅表示媒体、RGBA 与几何检查通过；不代表人工审核或游戏内导入实测通过。");

    const manifestFiles: BundleFileRecord[] = Array.from(records.values());
    const baseRecords = new Set(manifestFiles.map((record) => record.id));
    for (const file of outputFiles) {
      if (!baseRecords.has(file.record.id)) manifestFiles.push(file.record);
    }
    if (manifestFiles.length + 1 > MAX_FILES) throw new Error(`export exceeds ${MAX_FILES} ZIP entries`);
    const ticks = checkedSequence.entries.reduce((sum, entry) => sum + entry.hold_ticks, 0);
    if (!Number.isSafeInteger(ticks)) throw new Error("total_ticks exceeds the safe integer range");
    const outputInspection = (fileId: string): MediaInspection | undefined =>
      inspected.get(fileId) ?? outputFiles.find((file) => file.record.id === fileId)?.inspection;
    const sourceGeometry: Array<Record<string, unknown>> = [];
    for (const pose of checkedSequence.poses) {
      const image = outputInspection(pose.file_id);
      if (image) sourceGeometry.push({
        file_id: pose.file_id,
        pose_id: pose.id,
        kind: "selected-pose",
        geometry: {
          image_width: image.width,
          image_height: image.height,
          logical_canvas_width: pose.logical_width,
          logical_canvas_height: pose.logical_height,
          pixels_per_logical_pixel: pose.pixels_per_unit,
          mapping: pose.pixels_per_unit === null ? "unknown" : "sequence-geometry-validated",
        },
      });
      if (pose.mother_file_id) {
        const mother = outputInspection(pose.mother_file_id);
        if (mother) sourceGeometry.push({
          file_id: pose.mother_file_id,
          pose_id: pose.id,
          kind: "native-mother",
          geometry: { image_width: mother.width, image_height: mother.height, pixels_per_logical_pixel: null, mapping: "native-scale-not-inferred" },
        });
      }
    }
    for (const entry of checkedSequence.entries) {
      const referenceId = entry.reference_file_id;
      if (!referenceId) continue;
      const reference = outputInspection(referenceId);
      const geometry = entry.reference_geometry;
      sourceGeometry.push({
        file_id: referenceId,
        entry_id: entry.id,
        kind: "original-reference",
        geometry: {
          image_width: reference?.width ?? null,
          image_height: reference?.height ?? null,
          logical_canvas_width: geometry?.logical_width ?? null,
          logical_canvas_height: geometry?.logical_height ?? null,
          pixels_per_logical_pixel: geometry?.pixels_per_unit ?? null,
          source: geometry?.source ?? null,
          mapping: geometry ? "entry-reference-geometry-validated" : "unknown-no-reference-geometry",
        },
      });
    }
    const manifest: BundleManifest = {
      schema_version: 1,
      sequence: checkedSequence,
      files: manifestFiles,
      processor: { name: "animation-media", schema_version: 1, app_version: packageInfo.version },
      timing: {
        tick_rate: checkedSequence.tick_rate,
        tick_rate_verified: checkedSequence.tick_rate_verified,
        status: input.mode === "work_copy" ? "unknown" : "sequence-verified-not-game-tested",
        entry_holds: checkedSequence.entries.map((entry) => ({ entry_id: entry.id, hold_ticks: entry.hold_ticks, original_hold_ticks: entry.original_hold_ticks })),
        total_ticks: ticks,
      },
      audit: {
        user_accepted_for_retention: checkedSequence.user_accepted_for_retention,
        historical_review: checkedSequence.historical_review,
        media_checks: input.mode === "validated" ? "rgba-and-geometry-checked" : "work-copy-only",
        game_import: "unverified",
        automatic_review_pass: false,
      },
      sources: [...checkedSequence.poses.map((pose) => ({ pose_id: pose.id, source: pose.source })), ...sourceGeometry],
      transformations: transformRecords,
    };
    const serializedManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const zipEntries = [
      { buffer: serializedManifest, archivePath: "manifest.json", compress: true },
      ...outputFiles.map((file) => ({ localPath: file.localPath, archivePath: file.archivePath, compress: false })),
    ];
    if (zipEntries.length > MAX_FILES) throw new Error(`export exceeds ${MAX_FILES} ZIP entries`);

    const tempZip = path.join(workDir, "bundle.zip");
    await writeZip(tempZip, zipEntries, input.signal);
    const verified = { ...manifest, sequence: checkedSequence, files: manifestFiles } as BundleManifest;
    await verifyCompletedBundle(tempZip, workDir, verified, input.signal);
    throwIfAborted(input.signal);
    finalPath = path.join(outputRoot, `animation-${randomUUID()}.zip`);
    await linkNoReplace(tempZip, finalPath);
    finalCreated = true;
    const outputStat = await fs.stat(finalPath);
    const sha256 = await hashFile(finalPath, input.signal);
    throwIfAborted(input.signal);
    return { path: finalPath, bytes: outputStat.size, sha256, entry_count: checkedSequence.entries.length, total_ticks: ticks, warnings };
  } catch (error) {
    if (finalPath && finalCreated) await fs.rm(finalPath, { force: true });
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

export async function extractAnimationFrame(input: {
  file: AnimationLocalFile;
  index: number;
  outputDir: string;
  signal?: AbortSignal;
}): Promise<{ file: AnimationLocalFile; pose: AnimationPose }> {
  throwIfAborted(input.signal);
  if ((input.file.role !== "video" && input.file.role !== "candidate") || input.file.mime !== "video/mp4" ||
    path.extname(input.file.path).toLowerCase() !== ".mp4" || !UUID_PATTERN.test(input.file.id) || path.basename(input.file.path) !== `${input.file.id}.mp4`) {
    throw new TypeError("frame extraction accepts only an imported UUID-named video or candidate MP4");
  }
  if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= MAX_VIDEO_FRAMES) {
    throw new TypeError(`frame index must be between 0 and ${MAX_VIDEO_FRAMES - 1}`);
  }
  const inspection = await validateLocalFile(input.file, input.signal);
  const outputRoot = await canonicalDirectory(input.outputDir);

  const probe = await runProcess(
    "ffprobe",
    [
      "-v", "error", "-protocol_whitelist", "file,pipe,data", "-threads:v", "1", "-max_alloc", String(256 * 1024 * 1024),
      "-select_streams", "v:0", "-show_frames",
      "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", input.file.path,
    ],
    { timeoutMs: PROCESSOR_TIMEOUT_MS, maxOutputBytes: MAX_PROCESS_OUTPUT, signal: input.signal },
  );
  const frameData = JSON.parse(probe.stdout.toString("utf8")) as { frames?: Array<{ best_effort_timestamp_time?: string }> };
  const frames = frameData.frames;
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > MAX_VIDEO_FRAMES || input.index >= frames.length) {
    throw new Error(`video frame index ${input.index} is outside its bounded decoded frame list`);
  }
  const ptsSeconds = Number(frames[input.index].best_effort_timestamp_time);
  if (!Number.isFinite(ptsSeconds)) throw new Error(`frame ${input.index} has no finite presentation timestamp`);

  const tempPath = path.join(outputRoot, `.animation-frame-${randomUUID()}.tmp.png`);
  const fileId = randomUUID();
  const finalPath = path.join(outputRoot, `${fileId}.png`);
  let finalCreated = false;
  try {
    await runProcess(
      "ffmpeg",
      [
        "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe,data", "-threads:v", "1",
        "-filter_threads", "1", "-max_alloc", String(256 * 1024 * 1024), "-i", input.file.path,
        "-map", "0:v:0", "-vf", `select=eq(n\\,${input.index})`,
        "-fps_mode", "passthrough", "-frames:v", "1", "-c:v", "png", "-compression_level", "0",
        "-fs", String(MAX_IMAGE_BYTES), "-f", "image2", tempPath,
      ],
      { timeoutMs: PROCESSOR_TIMEOUT_MS, maxOutputBytes: 64 * 1024, signal: input.signal },
    );
    const extracted = await inspectMediaFile(tempPath, "candidate", undefined, input.signal);
    if (extracted.width !== inspection.width || extracted.height !== inspection.height) {
      throw new Error("extracted PNG dimensions differ from the probed video stream");
    }
    throwIfAborted(input.signal);
    await linkNoReplace(tempPath, finalPath);
    finalCreated = true;
    const file: AnimationLocalFile = {
      id: fileId,
      name: `frame-${input.index}.png`,
      role: "candidate",
      mime: "image/png",
      bytes: extracted.bytes,
      sha256: extracted.sha256,
      width: extracted.width,
      height: extracted.height,
      path: finalPath,
    };
    const pose: AnimationPose = {
      id: `pose-${fileId}`,
      file_id: fileId,
      label: `Frame ${input.index}`,
      width: extracted.width,
      height: extracted.height,
      logical_width: null,
      logical_height: null,
      pixels_per_unit: null,
      source: { video_file_id: input.file.id, frame_index: input.index, pts_seconds: ptsSeconds, note: "FFmpeg lossless PNG extraction; no matting or logical-size adaptation applied." },
    };
    throwIfAborted(input.signal);
    return { file, pose };
  } catch (error) {
    if (finalCreated) await fs.rm(finalPath, { force: true });
    throw error;
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}
