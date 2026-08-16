import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonResponse } from '../src/lib/http/json-response';
import {
  isProviderHtmlResponseError,
  isProviderReferenceMediaTooSmallError,
  normalizeProviderErrorMessage,
  providerCreateFailureUserMessage,
} from '../src/lib/provider/error-message';

const html502 = '<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <html><body>Bad gateway</body></html>';
const lowPixelProviderError = {
  error: {
    code: 'InvalidParameter',
    message: 'The parameter `content[5]` specified in the request is not valid: the parameter video pixel count specified in the request must be greater than or equal to 409600 for model dreamina-seedance-2-0 in r2v. Request id: smoke',
    param: 'content[5]',
    type: 'BadRequest',
  },
};

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

async function assertReadJsonResponseHidesHtml() {
  const response = new Response(html502, {
    status: 502,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });

  await assert.rejects(
    () => readJsonResponse(response),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /服务临时返回了异常页面/);
      assert.match(error.message, /HTTP 502/);
      assert.doesNotMatch(error.message, /<!DOCTYPE|<html|no-js ie6/i);
      return true;
    },
  );
}

async function assertProviderCreateExtractsErrorObject() {
  const originalFetch = globalThis.fetch;
  const previousApiKey = process.env.SEEDANCE_API_KEY;
  process.env.SEEDANCE_API_KEY = 'smoke-key';
  const { createVideoTask } = await import('../src/lib/provider/jimeng');
  globalThis.fetch = (async () => new Response(JSON.stringify(lowPixelProviderError), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => createVideoTask({
        prompt: 'smoke',
        generation_mode: 'all_in_one_reference',
        ratio: '9:16',
        duration: 6,
        resolution: '480p',
        reference_video_urls: ['https://example.invalid/tiny.mp4'],
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /InvalidParameter/);
        assert.match(error.message, /409600/);
        assert.doesNotMatch(error.message, /missing id/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousApiKey == null) delete process.env.SEEDANCE_API_KEY;
    else process.env.SEEDANCE_API_KEY = previousApiKey;
  }
}

async function assertProviderCreateHidesHtml() {
  const originalFetch = globalThis.fetch;
  const previousApiKey = process.env.SEEDANCE_API_KEY;
  process.env.SEEDANCE_API_KEY = 'smoke-key';
  const { createVideoTask } = await import('../src/lib/provider/jimeng');
  globalThis.fetch = (async () => new Response(html502, {
    status: 502,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => createVideoTask({
        prompt: 'smoke',
        generation_mode: 'all_in_one_reference',
        ratio: '9:16',
        duration: 6,
        resolution: '480p',
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Seedance 创建任务返回异常页面/);
        assert.doesNotMatch(error.message, /<!DOCTYPE|<html|no-js ie6/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousApiKey == null) delete process.env.SEEDANCE_API_KEY;
    else process.env.SEEDANCE_API_KEY = previousApiKey;
  }
}

async function main() {
  await assertReadJsonResponseHidesHtml();
  await assertProviderCreateExtractsErrorObject();
  await assertProviderCreateHidesHtml();

  const normalized = normalizeProviderErrorMessage(lowPixelProviderError.error);
  assert.ok(normalized);
  assert.ok(isProviderReferenceMediaTooSmallError(normalized), '像素过低 Provider 错误必须被归类为用户可修正素材问题');

  const userMessage = providerCreateFailureUserMessage(normalized);
  assert.equal(userMessage.code, 'REFERENCE_MEDIA_TOO_SMALL');
  assert.equal(userMessage.status, 400);
  assert.match(userMessage.message, /参考素材分辨率太低/);
  assert.match(userMessage.message, /已返还冻结点数/);
  assert.doesNotMatch(userMessage.message, /Create video task missing id|content\[5\]|InvalidParameter/);

  const htmlMessage = providerCreateFailureUserMessage('Seedance 创建任务返回异常页面（HTTP 502，text/html; charset=UTF-8）');
  assert.equal(htmlMessage.code, 'PROVIDER_HTML_RESPONSE');
  assert.equal(htmlMessage.status, 502);
  assert.ok(isProviderHtmlResponseError('Invalid JSON response: <!DOCTYPE html>'));
  assert.doesNotMatch(htmlMessage.message, /<!DOCTYPE|<html/i);

  const h3UnsupportedLoraMessage = providerCreateFailureUserMessage('[unsupported_lora] LoRA is not in the H3 allowlist');
  assert.equal(h3UnsupportedLoraMessage.code, 'H3_UNSUPPORTED_LORA');
  assert.equal(h3UnsupportedLoraMessage.status, 400);
  assert.match(h3UnsupportedLoraMessage.message, /不在 H3 服务白名单/);
  assert.match(h3UnsupportedLoraMessage.message, /已取消提交并返还冻结点数/);
  assert.doesNotMatch(h3UnsupportedLoraMessage.message, /allowlist/i);

  const unknownMessage = providerCreateFailureUserMessage('[NewProviderCode] provider changed a validation rule');
  assert.equal(unknownMessage.code, 'PROVIDER_CREATE_FAILED');
  assert.equal(unknownMessage.status, 502);
  assert.match(unknownMessage.message, /已记录错误摘要/);
  assert.match(unknownMessage.message, /已返还冻结点数/);
  assert.doesNotMatch(unknownMessage.message, /NewProviderCode|provider changed/i);

  const errorTranslator = read('src/components/ErrorTranslator.tsx');
  assert.match(errorTranslator, /REFERENCE_MEDIA_TOO_SMALL/, '错误翻译组件必须识别参考素材分辨率太低');
  assert.match(errorTranslator, /PROVIDER_HTML_RESPONSE/, '错误翻译组件必须识别 Provider HTML 异常页');
  assert.doesNotMatch(errorTranslator, /API 服务返回了非 JSON 格式的响应/, '错误翻译组件不能继续用容易误导的旧 JSON 泛化文案');

  const tasksCreateRoute = read('src/app/api/tasks/create/route.ts');
  assert.match(tasksCreateRoute, /error_message:\s*userFacingFailure\.message/, 'Agent 运行失败展示字段必须写用户友好文案。');
  assert.match(tasksCreateRoute, /output_json:\s*JSON\.stringify\(\{[\s\S]*error:\s*userFacingFailure\.code,[\s\S]*message:\s*userFacingFailure\.message,/, 'Agent 步骤输出必须写错误分类和用户友好文案。');
  assert.match(tasksCreateRoute, /metadata_json:\s*JSON\.stringify\(\{[\s\S]*error:\s*userFacingFailure\.code,[\s\S]*message:\s*userFacingFailure\.message,/, '模板记忆元数据必须写错误分类和用户友好文案。');
  assert.match(tasksCreateRoute, /errorCode:\s*userFacingFailure\.code/, 'Provider 请求失败记录必须写入归类后的错误码，方便后台补规则。');
  assert.match(tasksCreateRoute, /responseSummary:\s*\{[\s\S]*reference_media:\s*buildReferenceMediaFailureSummary/, 'Provider 请求失败记录必须写入参考素材结构化摘要。');
  assert.match(tasksCreateRoute, /host:\s*safeUrlHost\(url\)/, 'Provider 失败摘要只能记录 URL host，不能记录完整素材 URL。');
  assert.doesNotMatch(tasksCreateRoute, /error_message:\s*providerFailureMessage/, 'Agent 运行失败字段不能再直接写 Provider 原始错误。');

  console.log('provider-create-error-smoke: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
