import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateEstimatedCost, calculateH3EstimatedCost } from '@/lib/pricing';

const seedance = calculateEstimatedCost('720p', 5, 'Seedance 2.0');
const h3 = calculateH3EstimatedCost(5, 'H3 推荐');

assert.equal(seedance.pricingRuleId, 'default-seedance-v2');
assert.equal(h3.pricingRuleId, 'default-h3-local-video-v1');
assert.notEqual(h3.pricingRuleId, seedance.pricingRuleId, 'H3 成本规则不能和 Seedance 混用');
assert.equal(h3.resolution, 'H3 auto');
assert.equal(h3.model, 'H3 推荐');
assert.equal(h3.estimatedCost, 15);

const routeSource = readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
assert.match(routeSource, /calculateH3EstimatedCost\(duration, selectedModel\)/, 'H3 创建任务必须走独立成本计算');
assert.match(routeSource, /provider:\s*requestedProvider/, 'VideoTask/source metadata/操作日志必须记录 provider');
assert.match(routeSource, /pricing_rule_id:\s*pricing\.pricingRuleId/, '操作日志必须记录 pricing rule');
assert.match(routeSource, /recordTaskCostEstimate\(tx, task, pricing, user\.id\)/, 'H3 必须复用现有成本估算记录入口');
assert.match(routeSource, /task_failed_refund/, 'H3 创建失败必须复用冻结点数释放或退款路径');
assert.match(routeSource, /ProviderApiRequest endpoint 必须区分 H3|h3\.generate/, 'ProviderApiRequest 必须区分 H3 endpoint');

console.log('h3-cost-ledger smoke passed');
