/** Import from your own website's BACKEND. Never embed a caller Key in a browser. */
export class LocalImages {
  constructor(baseUrl, apiKey) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS API base URL');
    this.base = baseUrl.replace(/\/$/, ''); this.key = apiKey;
  }
  async request(method, route, body) {
    const response = await fetch(this.base + '/api/local-images/' + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${this.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw Object.assign(new Error(failure.error || `HTTP_${response.status}`), { status: response.status });
    }
    return response;
  }
  async models() { return (await this.request('GET', 'models')).json(); }
  // Persist requestId in your own DB BEFORE calling submit. On network failure, keep it.
  async submit(requestId, executionProfileId, params, projectId = null) {
    return (await this.request('POST', 'tasks', { requestId, executionProfileId, params, projectId })).json();
  }
  // Read-only recovery after an unknown submission. A 404 is not proof of rejection.
  async findOriginalRequest(requestId) { return (await this.request('GET', `requests/${encodeURIComponent(requestId)}`)).json(); }
  async status(taskId) { return (await this.request('GET', `tasks/${encodeURIComponent(taskId)}`)).json(); }
  async download(taskId) { return (await this.request('GET', `tasks/${encodeURIComponent(taskId)}/outputs/image-1`)).arrayBuffer(); }
}
