// Memory identity only: never stores authentication credentials or grants access.
let ownerId: string | null = null;
let epoch = 0;

export function setUploadSessionOwner(next: string | null) {
  if (next !== ownerId) { ownerId = next; epoch++; }
}

export function uploadSession() { return { ownerId, epoch }; }
