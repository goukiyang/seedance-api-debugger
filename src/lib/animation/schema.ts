import type { AnimationEntry, AnimationPose, AnimationSequence } from "./types";

const MAX_ENTRIES = 500;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 32_000_000;
const MAX_STRING = 4_096;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type JsonRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`);
}

function record(value: unknown, path: string, required: string[], optional: string[] = []): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, "must be a plain object");
  }

  const result = value as JsonRecord;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not a supported field");
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      fail(`${path}.${key}`, "is required");
    }
  }
  return result;
}

function string(value: unknown, path: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.trim().length === 0)) {
    return fail(path, `must be a ${allowEmpty ? "string" : "non-empty string"} of at most ${max} characters`);
  }
  return value;
}

function id(value: unknown, path: string): string {
  const result = string(value, path, 128);
  if (!ID_PATTERN.test(result)) fail(path, "must use a stable ASCII identifier");
  return result;
}

function finite(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return fail(path, `must be finite and between ${min} and ${max}`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    return fail(path, `must be a positive integer no greater than ${max}`);
  }
  return value as number;
}

function optionalFinite(value: unknown, path: string, max: number): number | undefined {
  return value === undefined ? undefined : finite(value, path, -max, max);
}

function nullablePositive(value: unknown, path: string, max: number): number | null {
  return value === null ? null : finite(value, path, Number.MIN_VALUE, max);
}

function parsePose(value: unknown, index: number): AnimationPose {
  const path = `sequence.poses[${index}]`;
  const input = record(value, path, ["id", "file_id", "label", "width", "height", "logical_width", "logical_height", "pixels_per_unit", "source"], ["mother_file_id"]);
  const width = positiveInteger(input.width, `${path}.width`, MAX_DIMENSION);
  const height = positiveInteger(input.height, `${path}.height`, MAX_DIMENSION);
  if (width * height > MAX_PIXELS) fail(path, `image exceeds ${MAX_PIXELS} pixels`);

  const logicalWidth = nullablePositive(input.logical_width, `${path}.logical_width`, 1_000_000);
  const logicalHeight = nullablePositive(input.logical_height, `${path}.logical_height`, 1_000_000);
  const pixelsPerUnit = nullablePositive(input.pixels_per_unit, `${path}.pixels_per_unit`, 4_096);
  const allUnknown = logicalWidth === null && logicalHeight === null && pixelsPerUnit === null;
  const allKnown = logicalWidth !== null && logicalHeight !== null && pixelsPerUnit !== null;
  if (!allUnknown && !allKnown) {
    fail(path, "logical dimensions and pixels_per_unit must be all known or all null");
  }
  if (logicalWidth !== null && logicalHeight !== null && pixelsPerUnit !== null) {
    const widthRatio = width / logicalWidth;
    const heightRatio = height / logicalHeight;
    const tolerance = Math.max(1e-6, pixelsPerUnit * 1e-6);
    if (Math.abs(widthRatio - pixelsPerUnit) > tolerance || Math.abs(heightRatio - pixelsPerUnit) > tolerance) {
      fail(path, "native and logical dimensions do not match pixels_per_unit");
    }
  }

  const sourceInput = record(input.source, `${path}.source`, [], ["version", "video_file_id", "frame_index", "pts_seconds", "note"]);
  const source: AnimationPose["source"] = {};
  if (sourceInput.version !== undefined) source.version = string(sourceInput.version, `${path}.source.version`, 160);
  if (sourceInput.video_file_id !== undefined) source.video_file_id = id(sourceInput.video_file_id, `${path}.source.video_file_id`);
  if (sourceInput.frame_index !== undefined) {
    if (!Number.isSafeInteger(sourceInput.frame_index) || (sourceInput.frame_index as number) < 0 || (sourceInput.frame_index as number) > 1_000_000) {
      fail(`${path}.source.frame_index`, "must be a bounded zero-based integer");
    }
    source.frame_index = sourceInput.frame_index as number;
  }
  if (sourceInput.pts_seconds !== undefined) source.pts_seconds = finite(sourceInput.pts_seconds, `${path}.source.pts_seconds`, -1_000_000, 1_000_000);
  if (sourceInput.note !== undefined) source.note = string(sourceInput.note, `${path}.source.note`, 2_048, true);

  return {
    id: id(input.id, `${path}.id`),
    file_id: id(input.file_id, `${path}.file_id`),
    ...(input.mother_file_id === undefined ? {} : { mother_file_id: id(input.mother_file_id, `${path}.mother_file_id`) }),
    label: string(input.label, `${path}.label`, 160),
    width,
    height,
    logical_width: logicalWidth,
    logical_height: logicalHeight,
    pixels_per_unit: pixelsPerUnit,
    source,
  };
}

function parseReferenceGeometry(value: unknown, path: string): NonNullable<AnimationEntry["reference_geometry"]> {
  const input = record(value, path, ["logical_width", "logical_height", "pixels_per_unit", "source"]);
  return {
    logical_width: finite(input.logical_width, `${path}.logical_width`, Number.MIN_VALUE, 1_000_000),
    logical_height: finite(input.logical_height, `${path}.logical_height`, Number.MIN_VALUE, 1_000_000),
    pixels_per_unit: finite(input.pixels_per_unit, `${path}.pixels_per_unit`, Number.MIN_VALUE, 4_096),
    source: string(input.source, `${path}.source`, 512),
  };
}

function parseEntry(value: unknown, index: number): AnimationEntry {
  const path = `sequence.entries[${index}]`;
  const input = record(value, path, ["id", "action", "pose_id", "hold_ticks", "original_hold_ticks", "locked", "translate_x", "translate_y"], ["reference_file_id", "reference_geometry"]);
  const hold = positiveInteger(input.hold_ticks, `${path}.hold_ticks`, 1_000_000);
  const originalHold = positiveInteger(input.original_hold_ticks, `${path}.original_hold_ticks`, 1_000_000);
  if (hold !== originalHold) fail(path, "hold_ticks must equal original_hold_ticks");
  if (typeof input.locked !== "boolean") fail(`${path}.locked`, "must be a boolean");
  const referenceGeometry = input.reference_geometry === undefined
    ? undefined
    : parseReferenceGeometry(input.reference_geometry, `${path}.reference_geometry`);
  if (referenceGeometry && input.reference_file_id === undefined) {
    fail(`${path}.reference_geometry`, "requires reference_file_id");
  }

  return {
    id: id(input.id, `${path}.id`),
    action: string(input.action, `${path}.action`, 160),
    pose_id: id(input.pose_id, `${path}.pose_id`),
    ...(input.reference_file_id === undefined ? {} : { reference_file_id: id(input.reference_file_id, `${path}.reference_file_id`) }),
    ...(referenceGeometry ? { reference_geometry: referenceGeometry } : {}),
    hold_ticks: hold,
    original_hold_ticks: originalHold,
    locked: input.locked,
    translate_x: finite(input.translate_x, `${path}.translate_x`, -100_000, 100_000),
    translate_y: finite(input.translate_y, `${path}.translate_y`, -100_000, 100_000),
  };
}

export function validateAnimationSequence(value: unknown): AnimationSequence {
  const input = record(
    value,
    "sequence",
    ["schema_version", "title", "preview_fps", "tick_rate", "tick_rate_verified", "global_scale", "poses", "entries", "notes", "user_accepted_for_retention", "historical_review"],
  );
  if (input.schema_version !== 1) fail("sequence.schema_version", "only schema version 1 is supported");
  if (typeof input.tick_rate_verified !== "boolean") fail("sequence.tick_rate_verified", "must be a boolean");
  const tickRate = input.tick_rate === null ? null : finite(input.tick_rate, "sequence.tick_rate", Number.MIN_VALUE, 1_000);
  if (tickRate === null && input.tick_rate_verified) fail("sequence.tick_rate_verified", "cannot be true when tick_rate is unknown");
  if (typeof input.user_accepted_for_retention !== "boolean") fail("sequence.user_accepted_for_retention", "must be a boolean");
  if (!Array.isArray(input.poses) || input.poses.length < 1 || input.poses.length > MAX_ENTRIES) {
    fail("sequence.poses", `must contain between 1 and ${MAX_ENTRIES} poses`);
  }
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > MAX_ENTRIES) {
    fail("sequence.entries", `must contain between 1 and ${MAX_ENTRIES} entries`);
  }

  const poses = input.poses.map(parsePose);
  const entries = input.entries.map(parseEntry);
  const poseIds = new Set<string>();
  for (const pose of poses) {
    if (poseIds.has(pose.id)) fail("sequence.poses", `duplicate pose id ${pose.id}`);
    poseIds.add(pose.id);
  }
  const entryIds = new Set<string>();
  for (const entry of entries) {
    if (entryIds.has(entry.id)) fail("sequence.entries", `duplicate entry id ${entry.id}`);
    entryIds.add(entry.id);
    if (!poseIds.has(entry.pose_id)) fail(`sequence.entries.${entry.id}.pose_id`, "does not reference a sequence pose");
  }

  return {
    schema_version: 1,
    title: string(input.title, "sequence.title", 200),
    preview_fps: finite(input.preview_fps, "sequence.preview_fps", Number.MIN_VALUE, 1_000),
    tick_rate: tickRate,
    tick_rate_verified: input.tick_rate_verified,
    global_scale: finite(input.global_scale, "sequence.global_scale", Number.MIN_VALUE, 64),
    poses,
    entries,
    notes: string(input.notes, "sequence.notes", MAX_STRING, true),
    user_accepted_for_retention: input.user_accepted_for_retention,
    historical_review: string(input.historical_review, "sequence.historical_review", MAX_STRING, true),
  };
}
