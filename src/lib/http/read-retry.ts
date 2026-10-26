// Read-only GETs only: transient 502/503/504 (SQLite lock waits surface as 503) get a bounded retry instead of an error banner.
export async function fetchReadWithRetry(url: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
  if (init.method && init.method !== 'GET') throw new Error('fetchReadWithRetry is for read-only GET requests');
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { cache: 'no-store', ...init });
    if (attempt >= attempts || ![502, 503, 504].includes(response.status)) return response;
    await new Promise(resolve => setTimeout(resolve, 600 * attempt));
  }
}
