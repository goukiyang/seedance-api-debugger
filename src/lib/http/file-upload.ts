export function buildRawFileUploadRequest(file: File): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'upload.bin'),
      'X-File-Size': String(file.size),
    },
    body: file,
  };
}
