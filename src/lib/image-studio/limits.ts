export const MAX_REFERENCE_IMAGES = 10;
export const DEFAULT_STUDIO_PRIMARY_MAX = 1;
export const MAX_STUDIO_GENERATED_BYTES = 96 * 1024 * 1024;
export const MAX_STUDIO_GENERATED_BASE64 = Math.ceil(MAX_STUDIO_GENERATED_BYTES / 3) * 4;
// Execution stays below the ten-minute lease and the existing 660s graceful stop.
export const STUDIO_EXECUTION_MS = 480_000;
export const STUDIO_DOWNLOAD_WINDOW_MS = 180_000;
export const STUDIO_DOWNLOAD_EXTENDED_MS = 360_000;
export const STUDIO_RECOVERY_MS = 30 * 60_000;
export const STUDIO_CHECKPOINT_RETENTION_MS = 24 * 60 * 60_000;
export const STUDIO_MAX_DOWNLOAD_ATTEMPTS = 6;
