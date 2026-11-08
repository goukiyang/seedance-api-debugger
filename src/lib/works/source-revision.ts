import { createHash } from 'node:crypto';

/** The existing persisted video identity, shared by admission and successful-use records. */
export function workVideoSourceRevision(source: string, stamp: Date, bytes: number | null) {
  return createHash('sha256').update(JSON.stringify([source, stamp.toISOString(), bytes])).digest('hex');
}
