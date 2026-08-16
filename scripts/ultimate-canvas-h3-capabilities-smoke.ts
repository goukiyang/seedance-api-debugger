import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bootstrapSource = readFileSync('src/app/api/tools/ultimate-canvas/bootstrap/route.ts', 'utf8');

assert.match(bootstrapSource, /getH3ApiSettings/, '无线画布 bootstrap 必须读取 H3 配置');
assert.match(bootstrapSource, /safeH3ConfigDto/, '无线画布 bootstrap 只能暴露 H3 安全 DTO');
assert.match(bootstrapSource, /providers:\s*\[/, '视频能力必须声明可用 provider 列表');
assert.match(bootstrapSource, /id:\s*'h3'/, '视频 provider 列表必须包含 H3');
assert.match(bootstrapSource, /h3_video:\s*\{/, '视频能力必须暴露 h3_video 状态');
assert.match(bootstrapSource, /configured:\s*h3VideoConfig\.configured/, '无线画布必须区分 H3 已配置和已健康可用');
assert.match(bootstrapSource, /default_lora_id:\s*h3VideoConfig\.default_lora_id/, '无线画布必须暴露 H3 默认 LoRA');
assert.match(bootstrapSource, /lora_options:\s*h3VideoConfig\.lora_options/, '无线画布必须暴露 H3 LoRA 候选项');
assert.match(bootstrapSource, /health:\s*h3VideoConfig\.health\s*\?/, '无线画布必须暴露安全健康状态方便前端解释禁用原因');
assert.equal(bootstrapSource.includes('worker_url'), false, '无线画布不能暴露内部 worker_url');
assert.match(bootstrapSource, /provider_options:\s*h3VideoConfig\.ready/, '视频交互能力必须声明 H3 是否可选');
assert.match(bootstrapSource, /多余参考图、参考视频和音频第一版只作为可见上下文/, '画布能力说明必须明确 H3 不支持素材的处理方式');
assert.match(bootstrapSource, /H3 可通过 lora_id 选择 LoRA/, '画布能力说明必须告诉工具页如何选择 H3 LoRA');
assert.equal(bootstrapSource.includes('admin_token'), false, '无线画布 bootstrap 不能暴露 H3 admin token');
assert.equal(bootstrapSource.includes('api_token'), false, '无线画布 bootstrap 不能暴露 H3 user token');

console.log('ultimate-canvas-h3-capabilities smoke passed');
