import assert from 'node:assert/strict';
import { buildStudioProviderErrorEvent } from '../src/lib/image-studio/provider-error-diagnostics';

// PA04: what the supplier said, by status; never a confirmed cause, never free text from the body.
const at = (transportHttpStatus: number, payload?: unknown, localCode?: string) =>
  buildStudioProviderErrorEvent({ phase: 'initial_request', dispatchObserved: true, transportHttpStatus, payload, localCode }).summary;
assert.match(at(451), /HTTP 451（按供应商说明为内容安全拦截/);
assert.match(at(429), /提交限流/);
assert.match(at(503), /不代表最终失败/);
assert.match(at(504), /生成超时/);
assert.match(at(502), /参考图传输/);
assert.match(at(200, { safe_error: { reason_code: 'service_http_503' } }), /内部服务返回 HTTP 503（按供应商说明/);
assert.match(at(200, undefined, 'empty_output'), /返回成功但没有图片/);
assert.match(at(418), /具体原因尚未证实/, 'unmapped statuses stay unknown');
assert.ok(!at(400, { error: { message: 'secret prompt text' } }).includes('secret'), 'body text never surfaces');
console.log('provider error summary smoke: ok');
