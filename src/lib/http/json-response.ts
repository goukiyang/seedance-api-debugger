type ReadJsonResponseOptions = {
  invalidJsonMessage?: string;
  includeDiagnostics?: boolean;
};

function looksLikeHtmlDocument(contentType: string, body: string) {
  const lowerContentType = contentType.toLowerCase();
  const compactBody = body.replace(/\s+/g, ' ').trim().toLowerCase();
  return lowerContentType.includes('text/html')
    || compactBody.startsWith('<!doctype')
    || compactBody.startsWith('<html')
    || compactBody.includes('<html')
    || compactBody.includes('<!--[if ');
}

function nonJsonResponseMessage(response: Response, contentType: string, body: string) {
  if (looksLikeHtmlDocument(contentType, body)) {
    return `服务临时返回了异常页面（HTTP ${response.status}），系统没有拿到有效结果。请稍后重试；如果连续出现，请联系管理员查看服务日志。`;
  }

  return `服务响应格式错误（HTTP ${response.status}，${contentType}），系统没有拿到有效 JSON 结果。请刷新后重试；如果连续出现，请联系管理员查看服务日志。`;
}

export async function readJsonResponse<T>(
  response: Response,
  options: ReadJsonResponseOptions = {},
): Promise<T> {
  const text = await response.text();
  if (!text.trim()) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = response.headers.get('content-type') || 'unknown content-type';
    if (options.invalidJsonMessage) {
      const diagnostics = options.includeDiagnostics
        ? `（HTTP ${response.status}，${contentType}）`
        : '';
      throw new Error(`${options.invalidJsonMessage}${diagnostics}`);
    }
    throw new Error(nonJsonResponseMessage(response, contentType, text));
  }
}
