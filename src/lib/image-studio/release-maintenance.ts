import fs from 'node:fs';
import path from 'node:path';
import { isImageStudioDraining } from '@/lib/pricing/isolation';

// This ordinary run-owned marker is deliberately separate from the permanent
// root-owned +i pricing barrier at storage/image-studio-drain.
export const STUDIO_RELEASE_MAINTENANCE_FILE = 'image-studio-release-maintenance.v1';

export function isStudioReleaseMaintenance(root = process.cwd()) {
  return fs.existsSync(path.join(root, 'storage', STUDIO_RELEASE_MAINTENANCE_FILE));
}

export function isStudioReleaseBlocked(root = process.cwd()) {
  return isStudioReleaseMaintenance(root) || isImageStudioDraining(root);
}
