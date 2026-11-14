import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import ts from 'typescript';

const root = process.cwd(), requirePackage = createRequire(path.join(root, 'package.json'));
const sourceSha256: Record<string, string> = {}, cache = new Map<string, { exports: any }>();
const checks: string[] = [], logs: string[] = [];
let requests = 0, forbiddenCalls = 0;
const modules = new Map<string, unknown>([
  ['server-only', {}],
  ['@/lib/security/private-prompts.server', { isPrivatePromptError: () => false }],
  ['@/lib/security/private-prompt-send.server', { assertPrivateSend: () => {}, privatePromptFetch: () => { forbiddenCalls++; throw Error('Private send not expected'); } }],
  ['@/lib/video/private-storage.server', { privateMultiviewOrigins: () => [] }],
  ['@/lib/integrations/volcengine-ip', {
    VOLCENGINE_IP_CREATE_TASK_PATH: '/contents/generations/tasks',
    getVolcengineIpApiSettings: async () => ({ enabled: true, api_key: 'fixture-only', default_model: 'doubao-seedance-2-5-260628', base_url: 'https://ark.fixture.invalid/api/v3' }),
    isVolcengineIpApiReady: () => true,
  }],
]);
const source = (file: string) => {
  const bytes = fs.readFileSync(path.join(root, file)); sourceSha256[file] = createHash('sha256').update(bytes).digest('hex'); return bytes.toString();
};
function load(file: string): any {
  const absolute = path.resolve(root, file); if (cache.has(absolute)) return cache.get(absolute)!.exports;
  const mod = { exports: {} }; cache.set(absolute, mod);
  const code = ts.transpileModule(source(file), { fileName: absolute, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const localRequire = (name: string) => {
    if (modules.has(name)) return modules.get(name);
    if (name.startsWith('@/') || name.startsWith('.')) {
      const resolved = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : path.resolve(path.dirname(absolute), name);
      return load(path.relative(root, resolved + '.ts'));
    }
    return requirePackage(name);
  };
  Function('require', 'module', 'exports', '__filename', '__dirname', code)(localRequire, mod, mod.exports, absolute, path.dirname(absolute));
  return mod.exports;
}
async function main() {
  source('scripts/reference-create-diagnostic-engineering.ts');
  const privacyFile = 'src/lib/video/multiview-task-privacy.ts', privacySource = source(privacyFile);
  const privacyAst = ts.createSourceFile(privacyFile, privacySource, ts.ScriptTarget.Latest, true);
  const failure = privacyAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'privateMultiviewFailure');
  assert.ok(failure);
  const privacyCode = ts.transpileModule(failure.getText(privacyAst), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const privacyExports = {}; Function('exports', privacyCode)(privacyExports);
  modules.set('@/lib/video/multiview-task-privacy', privacyExports);
  process.env.SEEDANCE_API_KEY = 'fixture-only'; process.env.SEEDANCE_BASE_URL = 'https://seedance.fixture.invalid';
  const jimeng = load('src/lib/provider/jimeng.ts'), ip = load('src/lib/provider/volcengine-ip.ts');
  const diagnostic = load('src/lib/provider/create-diagnostic.ts'), redaction = load('src/lib/provider/reference-media-redaction.ts');
  const policy = load('src/lib/generation-retry/contracts.ts');
  const ticket = 'FIXTURE_TICKET_MUST_NOT_ESCAPE+/=', signed = `https://site.fixture.invalid/api/provider/reference-media?ticket=${encodeURIComponent(ticket)}&part=1`;
  const echoes = [
    ['literal', signed], ['slashescaped', signed.replaceAll('/', '\\/')], ['encoded_url', encodeURIComponent(signed)],
    ['ticket_only', ticket], ['encoded_ticket', encodeURIComponent(ticket)],
  ] as const;
  const credentials = [...new Set(echoes.map(([, value]) => value))];
  const assertNoCredential = (value: unknown, label: string) => {
    const observed = inspect(value, { depth: 20, showHidden: true, maxArrayLength: null, maxStringLength: null });
    for (const credential of credentials) assert.equal(observed.includes(credential), false, `${label}: known credential remained`);
  };
  const unrelated = 'https://public.fixture.invalid/video.mp4?keep=original';
  const sanitized = redaction.sanitizeProviderReferenceMedia({ message: `read ${signed}`, nested: [{ [signed]: signed }], unrelated,
    escaped: JSON.stringify({ echo: signed }).replaceAll('/', '\\/'),
    error: new Error(`network ${signed}`, { cause: new Error(`cause ${signed}`) }) });
  assert.equal(JSON.stringify(sanitized).includes(ticket), false); assert.equal(sanitized.unrelated, unrelated);
  assert.equal(sanitized.error.stack.includes(ticket), false); assert.equal(sanitized.error.cause.message.includes(ticket), false);
  checks.push('recursive_fixed_uri_redaction_preserves_unrelated_urls');
  const requestRedactor = redaction.createProviderReferenceMediaRedactor([signed, unrelated]);
  const unrelatedPrompt = `Keep this unrelated URL unchanged: ${unrelated}`;
  assert.equal(requestRedactor(unrelatedPrompt), unrelatedPrompt);
  assert.equal(redaction.createProviderReferenceMediaRedactor(['https://public.fixture.invalid/video.mp4?ticket=unrelated-ticket'])('unrelated-ticket'), 'unrelated-ticket');
  assertNoCredential(requestRedactor({ echoes: echoes.map(([, value]) => ({ message: value, [value]: value })),
    error: Object.assign(new Error(ticket, { cause: new Error(encodeURIComponent(signed)) }), { name: ticket, raw: signed }) }), 'request redactor recursive');
  checks.push('request_bound_exact_credentials_and_encoding_forms_only');

  const input = { generation_mode: 'all_in_one_reference', prompt: 'fixture', duration: 5, ratio: '16:9', resolution: '720p',
    model: 'dreamina-seedance-2-5-260628', reference_video_urls: [signed, unrelated] };
  const providerError = { error: { code: 'InvalidParameter.InvalidValue', param: 'content[1].video_url',
    message: `The parameter content[1].video_url is not accessible: resource not found ${signed}` }, request_id: 'fixture-request-123' };
  const realFetch = globalThis.fetch, realConsole = { log: console.log, warn: console.warn, error: console.error };
  const record = (...values: unknown[]) => logs.push(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  console.log = record; console.warn = record; console.error = record;
  let currentResponse: () => Promise<Response>;
  globalThis.fetch = async (url, init) => {
    requests++; assert.equal(String(url), 'https://seedance.fixture.invalid/call'); assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).has('cookie'), false);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.content.filter((item: any) => item.type === 'video_url').map((item: any) => item.video_url.url), [signed, unrelated]);
    assert.equal(body.content.find((item: any) => item.type === 'text')?.text, input.prompt);
    return currentResponse();
  };
  try {
    let captured: any;
    currentResponse = async () => Response.json(providerError, { headers: { 'x-request-id': 'header-request-123' } });
    await assert.rejects(() => jimeng.createVideoTask(input, (value: unknown) => { captured = value; }), (error: any) => {
      assert.equal(error.providerCreateDiagnostic, captured); assert.equal('retryFailure' in error, false);
      assert.equal(error.message.includes(ticket), false); return true;
    });
    assert.equal(captured.http_status, 200); assert.equal(captured.phase, 'response_validation');
    assert.deepEqual(captured.provider_error, { provider_code: 'InvalidParameter', parameter: 'content[1].video_url', request_id: 'header-request-123', reason: 'reference_unavailable' });
    assert.match(diagnostic.providerCreateFailureUserMessage(captured), /无法读取参考视频.*费用仍待核对/);
    const submission = load('src/components/generate/video-submission-state.ts');
    const safeMessage = diagnostic.providerCreateFailureUserMessage(captured);
    assert.equal(submission.videoSubmissionUnknownMessage({ status: 'submission_unknown', error_message: safeMessage }), safeMessage);
    assert.match(submission.videoSubmissionUnknownMessage({ status: 'submission_unknown' }), /费用仍待核对.*可离开/);
    assert.equal(submission.videoSubmissionUnknownMessage({ status: 'succeeded', error_message: safeMessage }), null);
    checks.push('unknown_ui_has_safe_reason_fee_pending_and_leaveable_state');
    assert.equal(policy.RETRY_RULES.length, 0); checks.push('http200_known_reason_separate_from_retry_and_fees');
    currentResponse = async () => Response.json({ id: 'accepted-fixture', ...providerError, echo: { message: signed, url: signed } });
    const accepted = await jimeng.createVideoTask(input, (value: unknown) => { captured = value; });
    assert.equal(accepted.provider_task_id, 'accepted-fixture'); assert.equal(captured.phase, 'complete'); assert.equal(captured.provider_error, undefined);
    assert.equal(JSON.stringify(accepted.raw).includes(ticket), false); checks.push('accepted_id_wins_and_success_raw_is_redacted');
    currentResponse = async () => { throw new Error(`connection lost ${signed}`, { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) }); };
    await assert.rejects(() => jimeng.createVideoTask(input, (value: unknown) => { captured = value; }), (error: any) => {
      assert.equal(error.message.includes(ticket), false); assert.equal('retryFailure' in error, false); return true;
    });
    assert.equal(captured.phase, 'fetch'); assert.equal(captured.http_status, null); assert.equal(captured.provider_error, undefined);
    assert.equal(captured.cause.code, 'ECONNRESET'); checks.push('network_failure_keeps_unknown_without_known_reason');
    currentResponse = async () => new Response(`upstream raw ${signed}`);
    await assert.rejects(() => jimeng.createVideoTask(input), (error: any) => !error.message.includes(ticket));
    checks.push('non_json_echo_redacted_before_error');
    currentResponse = async () => Response.json(providerError);
    await assert.rejects(() => jimeng.createVideoTask(input, (value: unknown) => { captured = value; }, { sensitiveRecipe: true }), (error: any) => {
      assert.equal(error.message.includes('content[1]'), false); return true;
    });
    assert.equal(captured.provider_error, undefined); checks.push('private_recipe_keeps_existing_safe_projection');
    for (const kind of ['success', 'error', 'network', 'body_error']) {
      const fetchImpl = async () => {
        requests++;
        if (kind === 'network') throw Error(`network ${signed}`);
        if (kind === 'body_error') return new Response(new ReadableStream({ start(controller) { controller.error(Error(`body read ${signed}`)); } }));
        return Response.json(kind === 'success' ? { id: 'ip-accepted', echo: signed } : providerError);
      };
      if (kind === 'success') {
        const result = await ip.createVolcengineIpVideoTask({ ...input, model: 'doubao-seedance-2-5-260628' }, { fetchImpl });
        assert.equal(JSON.stringify(result).includes(ticket), false);
      } else await assert.rejects(() => ip.createVolcengineIpVideoTask({ ...input, model: 'doubao-seedance-2-5-260628' }, { fetchImpl }), (error: any) => {
        assert.equal(error.message.includes(ticket), false); assert.equal(JSON.stringify(error).includes(ticket), false); return true;
      });
    }
    checks.push('ip_sdk_success_error_network_body_echo_redaction');
    const originalInput = structuredClone(input);
    for (const [form, echo] of echoes) for (const kind of ['success', 'json_error', 'non_json_error', 'network_cause', 'body_error']) {
      const errorBody = { ...providerError, error: { ...providerError.error, message: `resource not found ${echo}`, echo }, echo };
      currentResponse = async () => {
        if (kind === 'success') return Response.json({ id: 'matrix-accepted', echo, nested: { raw: echo } });
        if (kind === 'json_error') return Response.json(errorBody);
        if (kind === 'non_json_error') return new Response(`upstream error ${echo}`, { status: 502 });
        const failure = Object.assign(new Error(`network ${echo}`, { cause: Object.assign(new Error(`cause ${echo}`), { code: 'ECONNRESET' }) }), { name: echo, raw: echo });
        if (kind === 'network_cause') throw failure;
        return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
      };
      if (kind === 'success') assertNoCredential(await jimeng.createVideoTask(input, (value: unknown) => { captured = value; }), `ordinary ${form} success`);
      else await assert.rejects(() => jimeng.createVideoTask(input, (value: unknown) => { captured = value; }), (error: unknown) => {
        assertNoCredential(error, `ordinary ${form} ${kind}`); return true;
      });
      assertNoCredential(captured, `ordinary ${form} ${kind} diagnostic`);
      assert.deepEqual(input, originalInput);
      const fetchImpl = async (_url: unknown, init: RequestInit) => {
        requests++;
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body.content.filter((item: any) => item.type === 'video_url').map((item: any) => item.video_url.url), [signed, unrelated]);
        assert.equal(body.content.find((item: any) => item.type === 'text')?.text, input.prompt);
        return currentResponse();
      };
      if (kind === 'success') assertNoCredential(await ip.createVolcengineIpVideoTask({ ...input, model: 'doubao-seedance-2-5-260628' }, { fetchImpl }), `IP ${form} success`);
      else await assert.rejects(() => ip.createVolcengineIpVideoTask({ ...input, model: 'doubao-seedance-2-5-260628' }, { fetchImpl }), (error: unknown) => {
        assertNoCredential(error, `IP ${form} ${kind}`);
        if (kind !== 'body_error') assert.equal(error instanceof ip.VolcengineIpRequestError, true, 'IP request error classification retained');
        return true;
      });
      assert.deepEqual(input, originalInput);
    }
    checks.push('actual_ordinary_ip_boundary_all_echo_forms_success_json_nonjson_networkcause_body');
    assertNoCredential(logs, 'SDK console output');

    assert.equal(logs.join('\n').includes(ticket), false); checks.push('sdk_logs_do_not_contain_ticket');
    assert.equal(diagnostic.providerCreateKnownFailure({ error: { code: 'unknown-private-code', message: signed } }), undefined);
    const bad = diagnostic.providerCreateKnownFailure({ error: { code: 'InvalidParameter', param: signed, message: 'invalid input' }, request_id: signed });
    assert.deepEqual(bad, { provider_code: 'InvalidParameter', reason: 'invalid_parameter' }); checks.push('allowlisted_fields_only');
  } finally { globalThis.fetch = realFetch; Object.assign(console, realConsole); }
  assert.equal(forbiddenCalls, 0);
  const directory = path.join(root, '.role-tests'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receipt = path.join(directory, 'reference-create-diagnostic-receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({ completed: true, checks, sourceSha256, controlledProviderCalls: requests,
    externalProviderCalls: 0, productionWrites: 0, browserRuns: 0, forbiddenCalls }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ completed: true, checks: checks.length, receipt, controlledProviderCalls: requests }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
