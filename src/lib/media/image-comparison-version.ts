import { createHash } from 'node:crypto';
import { hdSource } from './hd-derivatives';

/** Call only after authorizing the selected original. Never registers an HD job. */
export async function comparisonOriginalVersion(source: string): Promise<string | null> {
  try {
    const original = await hdSource(source);
    return original ? `cmp2-${createHash('sha256').update(`comparison-original-v2:${original.version}`).digest('hex')}` : null;
  } catch { return null; } // Unknown is not evidence of a missing or changed file.
}
