export async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = response.headers.get('content-type') || 'unknown content-type';
    const compactBody = text.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(
      `生成服务返回异常页面 (HTTP ${response.status}, ${contentType})${compactBody ? `：${compactBody}` : ''}`,
    );
  }
}
