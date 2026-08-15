import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { taskCostFailureClassification } from '@/lib/costs/ledger';
import { calculateEstimatedCost, calculateH3EstimatedCost } from '@/lib/pricing';

const seedance = calculateEstimatedCost('720p', 5, 'Seedance 2.0');
const h3 = calculateH3EstimatedCost(5, 'H3 推荐');

assert.equal(seedance.pricingRuleId, 'default-seedance-v2');
assert.equal(h3.pricingRuleId, 'default-h3-local-video-v1');
assert.notEqual(h3.pricingRuleId, seedance.pricingRuleId, 'H3 成本规则不能和 Seedance 混用');
assert.equal(h3.resolution, 'H3 auto');
assert.equal(h3.model, 'H3 推荐');
assert.equal(h3.estimatedCost, 15);

const baseH3Task = {
  id: 'task-h3-001',
  user_id: 'user_1',
  project_id: null,
  provider: 'h3',
  model: 'H3 推荐',
  duration: 5,
};
assert.equal(taskCostFailureClassification(baseH3Task, 'failed').eventType, 'provider_request_failed');
assert.equal(taskCostFailureClassification({
  ...baseH3Task,
  provider_task_id: 'h3-job-001',
}, 'failed').eventType, 'job_failed');
assert.equal(taskCostFailureClassification({
  ...baseH3Task,
  provider_task_id: 'h3-job-001',
}, 'cancelled').eventType, 'job_cancelled');
assert.equal(taskCostFailureClassification({
  ...baseH3Task,
  provider_task_id: 'h3-job-001',
  error_code: 'output_download_failed',
}, 'failed').eventType, 'output_download_failed');
assert.equal(taskCostFailureClassification({
  ...baseH3Task,
  provider_task_id: 'h3-job-001',
  raw_status_response: JSON.stringify({ code: 'h3_done_without_output' }),
}, 'failed').eventType, 'output_download_failed');

const routeSource = readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
const auditSource = readFileSync('src/lib/costs/audit.ts', 'utf8');
assert.match(routeSource, /calculateH3EstimatedCost\(duration, selectedModel\)/, 'H3 创建任务必须走独立成本计算');
assert.match(routeSource, /provider:\s*requestedProvider/, 'VideoTask/source metadata/操作日志必须记录 provider');
assert.match(routeSource, /pricing_rule_id:\s*pricing\.pricingRuleId/, '操作日志必须记录 pricing rule');
assert.match(routeSource, /recordTaskCostEstimate\(tx, task, pricing, user\.id\)/, 'H3 必须复用现有成本估算记录入口');
assert.match(routeSource, /task_failed_refund/, 'H3 创建失败必须复用冻结点数释放或退款路径');
assert.match(routeSource, /ProviderApiRequest endpoint 必须区分 H3|h3\.generate/, 'ProviderApiRequest 必须区分 H3 endpoint');
assert.match(auditSource, /provider_request_failed/, '成本审计必须把 H3 请求失败视为终态成本事件');
assert.match(auditSource, /job_failed/, '成本审计必须把 H3 job 失败视为终态成本事件');
assert.match(auditSource, /job_cancelled/, '成本审计必须把 H3 取消视为终态成本事件');
assert.match(auditSource, /output_download_failed/, '成本审计必须把 H3 输出下载失败视为终态成本事件');

console.log('h3-cost-ledger smoke passed');
