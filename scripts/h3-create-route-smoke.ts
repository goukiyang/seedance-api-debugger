import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
const h3AssetsSource = readFileSync('src/lib/provider/h3-assets.ts', 'utf8');
const pricingSource = readFileSync('src/lib/pricing.ts', 'utf8');

assert.match(routeSource, /normalizeGenerationProvider/, '创建任务必须先解析 provider/engine');
assert.match(routeSource, /requestedProvider === H3_VIDEO_PROVIDER/, '创建任务必须有 H3 provider 分支');
assert.match(routeSource, /requestedProvider === 'seedance' && !isApiKeyConfigured\(\)/, 'Seedance API Key 检查不能阻塞 H3');
assert.match(routeSource, /getH3ApiSettings/, 'H3 任务必须读取后台 H3 配置');
assert.match(routeSource, /isH3Operational/, 'H3 必须健康检查通过后才允许普通生成');
assert.match(routeSource, /resolveH3LoraOption/, 'H3 任务必须用白名单解析 LoRA');
assert.match(routeSource, /h3LoraOptionToPayload/, 'H3 任务必须把 lora_id 转成 provider payload');
assert.match(routeSource, /typeof body\.lora_id === 'string'/, 'H3 任务必须支持 lora_id 请求字段');
assert.match(routeSource, /createH3VideoJob/, 'H3 任务必须通过 H3 adapter 创建');
assert.match(routeSource, /uploadH3ReferenceImagesForTask/, 'H3 首尾帧图片必须先转交给 H3');
assert.match(routeSource, /appendH3VisibleContext/, 'H3 不支持的素材必须转成可见上下文');
assert.match(routeSource, /provider:\s*requestedProvider/, 'VideoTask.provider 必须写入用户选择的 provider');
assert.match(routeSource, /endpoint:\s*requestedProvider === H3_VIDEO_PROVIDER \? 'h3.generate' : 'seedance.createVideoTask'/, 'ProviderApiRequest endpoint 必须区分 H3');
assert.match(routeSource, /const providerIdempotencyKey = requestedProvider === H3_VIDEO_PROVIDER[\s\S]*sourceRequestId \|\| idempotencyKey \|\| taskId/, 'H3 必须用外部请求号或本地任务 ID 作为幂等键');
assert.match(routeSource, /createH3VideoJob\(h3GeneratePayload,[\s\S]*idempotencyKey:\s*providerIdempotencyKey/, 'H3 提交必须把 Idempotency-Key 传给外部 API');
assert.match(routeSource, /step_key:\s*requestedProvider === H3_VIDEO_PROVIDER \? 'h3_submit' : 'seedance_submit'/, 'AgentRunStep 不能把 H3 写成 Seedance');
assert.match(routeSource, /summary:\s*requestedProvider === H3_VIDEO_PROVIDER \? '任务已提交 H3，等待生成结果回写'/, '模板 Memory 不能把 H3 写成 Seedance');
assert.match(routeSource, /providerResult\.provider_task_id/, 'H3 job_id 必须写回 provider_task_id');
assert.match(routeSource, /lora_id:\s*selectedH3Lora\?\.id \|\| null/, 'H3 任务参数必须记录所选 LoRA');
assert.match(routeSource, /lora:\s*selectedH3Lora \? h3LoraOptionToPayload\(selectedH3Lora\) : undefined/, 'H3 创建 payload 必须包含所选 LoRA');

assert.match(h3AssetsSource, /fetchH3ReferenceImageBytes/, 'H3 图片转交必须从现有素材 URL 读取字节');
assert.match(h3AssetsSource, /contentB64/, 'H3 图片转交必须上传 base64 内容');
assert.match(h3AssetsSource, /first_frame/, 'H3 图片转交必须支持首帧');
assert.match(h3AssetsSource, /last_frame/, 'H3 图片转交必须支持尾帧');
assert.match(h3AssetsSource, /sha256/, 'H3 图片转交必须记录 sha256');

assert.match(pricingSource, /calculateH3EstimatedCost/, 'H3 必须有独立免费成本规则，不能伪装成 Seedance 官方成本');
assert.match(pricingSource, /default-h3-local-video-v1/, 'H3 成本规则 ID 必须和 Seedance 区分');
assert.match(pricingSource, /const H3_VIDEO_COST_PER_SECOND = 0/, 'H3 是本地免费模型，不能按秒消耗用户点数');

console.log('h3-create-route smoke passed');
