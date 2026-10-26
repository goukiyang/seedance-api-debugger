import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = realpathSync(process.cwd());
const destination = path.resolve(process.argv[2] || '');
assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep), 'Receipt must stay in this candidate .role-tests directory');
const startedAt = Date.now();
const checks: string[] = [];
const sources = [
  'scripts/image-provider-admin-engineering.ts',
  'src/app/api/admin/image-studio/tasks/route.ts',
  'src/app/admin/image-studio/AdminImageStudioClient.tsx',
  'src/app/admin/image-studio/ImageStudioDiagnostics.module.css',
  'src/lib/image-studio/provider-error-diagnostics.ts',
  'src/lib/image-studio/provider-error-evidence.ts',
];
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const api = read(sources[1]);
const client = read(sources[2]);
const styles = read(sources[3]);

const auth = api.indexOf('await getAdminUser(request);');
const diagnosticsBranch = api.indexOf("if (params.has('diagnostics'))");
const listStart = api.indexOf("const cursor = text('cursor')");
assert.ok(auth >= 0 && diagnosticsBranch > auth && listStart > diagnosticsBranch, 'Admin authorization must precede the isolated diagnostics branch and list path');
const diagnosticsBranchSource = api.slice(diagnosticsBranch, listStart);
assert.match(diagnosticsBranchSource, /params\.getAll\('task_id'\)\.length !== 1/);
assert.match(diagnosticsBranchSource, /imageStudioTask\.findUnique/);
assert.match(diagnosticsBranchSource, /readStudioProviderErrorDiagnostics\(task\.id\)/);
assert.doesNotMatch(diagnosticsBranchSource, /\$transaction|\$queryRaw|\bfetch\s*\(|summaryStudio|resultStudio|generateStudio/);
checks.push('admin_auth_precedes_single_task_local_diagnostics_branch');

assert.equal((api.match(/NextResponse\.json/g) || []).length, 1, 'Every response must use the private no-store response helper');
assert.match(api, /const PRIVATE_HEADERS = \{ 'Cache-Control': 'private, no-store' \}/);
assert.match(diagnosticsBranchSource, /catch \{\s*return adminJson\(\{ error: '图片错误详情暂不可读，请重试' \}, 503\);\s*\}/);
assert.doesNotMatch(diagnosticsBranchSource, /console\.(?:error|warn|log)/);
checks.push('diagnostics_responses_are_private_fixed_and_do_not_log_raw_errors');

const apiProjectionStart = api.indexOf('function projectProviderErrorDiagnostics');
const apiProjectionEnd = api.indexOf('export async function GET');
assert.ok(apiProjectionStart >= 0 && apiProjectionEnd > apiProjectionStart);
const apiProjection = api.slice(apiProjectionStart, apiProjectionEnd);
for (const required of ['binding:', 'frozen:', 'request:', 'events:', 'unknownFields:', 'summarySource:', 'summary:']) assert.ok(apiProjection.includes(required));
for (const forbidden of ['...', 'prompt', 'snapshot_json', 'original_url', 'headers:', 'stack:', 'cause:']) assert.ok(!apiProjection.includes(forbidden), `API projection must omit ${forbidden}`);
const copyStart = client.indexOf('function safeDiagnosticsCopy');
const copyEnd = client.indexOf('function DiagnosticFields');
assert.ok(copyStart >= 0 && copyEnd > copyStart);
const copyProjection = client.slice(copyStart, copyEnd);
for (const required of ['binding:', 'frozen:', 'request:', 'events:', 'unknownFields:', 'summarySource:', 'summary:']) assert.ok(copyProjection.includes(required));
for (const forbidden of ['...', 'prompt', 'providerCostUsd', 'original_url', 'snapshot', 'headers:']) assert.ok(!copyProjection.includes(forbidden), `Clipboard projection must omit ${forbidden}`);
assert.match(client, /import type \{ StudioProviderErrorDiagnostics, StudioProviderErrorEvent, StudioProviderErrorReadResult \}/);
checks.push('api_and_clipboard_use_explicit_browser_safe_dto_allowlists');

const detailLoaderStart = client.indexOf('const loadDiagnostics = useCallback');
const detailLoaderEnd = client.indexOf('const expandedTaskId =');
assert.ok(detailLoaderStart >= 0 && detailLoaderEnd > detailLoaderStart);
const detailLoader = client.slice(detailLoaderStart, detailLoaderEnd);
assert.match(detailLoader, /new URLSearchParams\(\{ task_id: taskId, diagnostics: '1' \}\)/);
assert.match(detailLoader, /seq !== diagnosticsSequence\.current/);
assert.doesNotMatch(detailLoader, /setTasks|setPagination|router\.|method:\s*['"]POST|generate|confirm/);
assert.match(client, /diagnosticView\?\.accountId === accountId && diagnosticView\.taskId === task\.id/);
assert.match(client, /sd2-admin-image-diagnostics-expanded-v1:\$\{accountId\}/);
assert.match(client, /let taskId = explicitTaskId;\s*if \(taskId\) \{\s*try \{ localStorage\.setItem\(diagnosticsStorageKey\(accountId\), taskId\); \}/);
assert.match(client, /\} else \{\s*try \{ taskId = safeExpandedTaskId\(localStorage\.getItem\(diagnosticsStorageKey\(accountId\)\)\); \}/);
assert.match(client, /changeExpandedTask\(null\);\s*router\.replace\('\/admin\/image-studio\?page=1'/);
checks.push('single_task_detail_loading_account_target_sequence_and_reset_are_isolated');

type SyntheticView = { accountId: string; taskId: string; sequence: number };
const accepts = (view: SyntheticView, accountId: string, taskId: string, sequence: number) =>
  view.accountId === accountId && view.taskId === taskId && view.sequence === sequence;
const active: SyntheticView = { accountId: 'account-a', taskId: 'task-a', sequence: 2 };
assert.equal(accepts(active, 'account-a', 'task-a', 2), true);
assert.equal(accepts(active, 'account-b', 'task-a', 2), false);
assert.equal(accepts(active, 'account-a', 'task-b', 2), false);
assert.equal(accepts(active, 'account-a', 'task-a', 1), false);
assert.match(client, /列表、筛选和已有图片没有改变/);
assert.match(client, /task\.deletedAt && <span className="text-gray"> · 用户已隐藏<\/span>/);
assert.doesNotMatch(styles, /\bred\b|#[0-9a-fA-F]{3,8}|oklch\([^)]*\b(?:20|25|30)\b/);
checks.push('synthetic_late_response_and_local_failure_preserve_current_admin_surface');

const sourceSha256 = Object.fromEntries(sources.map(file => [file,
  createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]));
writeFileSync(destination, JSON.stringify({
  schema: 'image-provider-admin-engineering.v1',
  synthetic: true,
  completed: true,
  runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID,
  candidateRoot: root,
  startedAt,
  finishedAt: Date.now(),
  checks,
  sourceSha256,
  applicationDatabaseOpened: false,
  productionWrites: 0,
  forbiddenCalls: 0,
  paidRequests: 0,
  browserRuns: 0,
  scope: 'Static and synthetic admin diagnostics contract only; no business API, provider, browser or functional acceptance',
}), { mode: 0o600, flag: 'wx' });
console.log('IMAGE_PROVIDER_ADMIN_ENGINEERING_RECEIPT=' + destination);
