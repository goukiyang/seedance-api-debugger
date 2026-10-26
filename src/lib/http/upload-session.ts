// Memory identity only: never stores authentication credentials or grants access.
let ownerId: string | null = null;
let epoch = 0;
const listeners = new Set<() => void>();

export function setUploadSessionOwner(next: string | null) {
  if (next !== ownerId) { ownerId = next; epoch++; listeners.forEach(listener => listener()); }
}

export function uploadSession() { return { ownerId, epoch }; }
export function subscribeUploadSession(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
