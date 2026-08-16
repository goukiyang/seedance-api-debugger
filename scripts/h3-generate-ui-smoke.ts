import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const composerSource = readFileSync('src/components/GenerationComposer.tsx', 'utf8');
const actionBarSource = readFileSync('src/components/ComposerActionBar.tsx', 'utf8');
const machineStatusSource = readFileSync('src/components/H3MachineStatus.ts', 'utf8');
const generatePageSource = readFileSync('src/components/generate/GeneratePageClient.tsx', 'utf8');
const templatePageSource = readFileSync('src/components/templates/TemplateGenerateClient.tsx', 'utf8');

assert.match(actionBarSource, /只有多引擎并列时才显示/, '底部参数栏不能在单一路径下暴露重复的生成引擎入口');
assert.match(actionBarSource, /hasProviderOptions &&/, '生成引擎 chip 只有存在多个引擎选项时才显示');
assert.match(actionBarSource, /providerStatus/, '底部参数栏必须支持 H3 机器状态块');
assert.match(actionBarSource, /composer-provider-status-dot/, 'H3 状态块必须有基础灯点');
assert.match(actionBarSource, /composer-provider-status-action/, 'H3 状态块可以提供手动刷新兜底');
assert.match(actionBarSource, /composer-provider-status-summary/, '折叠参数栏摘要也必须能看到 H3 状态');
assert.match(actionBarSource, /auxiliaryOptions/, '底部参数栏必须支持 H3 LoRA 这类附加下拉选项');
assert.match(actionBarSource, /onAuxiliaryChange/, 'LoRA 下拉变化必须能回传页面状态');
assert.ok(
  actionBarSource.indexOf('/* 模型标签 */') < actionBarSource.indexOf('{shouldShowProviderStatus && providerStatus &&'),
  '模型下拉必须显示在 H3 状态块左侧',
);

assert.match(composerSource, /provider:\s*selectedProvider \|\| null/, '提交参数必须包含选中的 provider');
assert.match(composerSource, /h3LoraId:\s*selectedAuxiliary \|\| null/, '提交参数必须包含选中的 H3 LoRA');
assert.match(composerSource, /onModelChange\?: \(model: string\) => void/, '生成编辑器必须把模型切换回传给页面');
assert.match(composerSource, /providerStatus/, '生成编辑器必须把状态块传给底部参数栏');

assert.match(machineStatusSource, /buildH3MachineStatus/, 'H3 状态判断必须复用共享 helper');
assert.match(machineStatusSource, /selectedProvider === 'h3'/, 'H3 状态只应该在用户选中 H3 模型后显示');
assert.match(machineStatusSource, /H3 可用 · 免费 · 队列空闲/, 'H3 状态必须能表达免费和队列空闲');
assert.match(machineStatusSource, /队列中/, 'H3 状态必须能表达队列忙');
assert.match(machineStatusSource, /健康检查已过期/, 'H3 旧健康快照必须显示待检查，不能继续假绿灯');
assert.match(machineStatusSource, /cost_model === 'free_local'/, 'H3 免费标识必须以后端计费快照为依据');
assert.match(machineStatusSource, /isH3HealthCheckDue/, 'H3 必须有自动健康检查到期判断');
assert.match(machineStatusSource, /H3_AUTO_CHECK_INTERVAL_MS = 10 \* 60 \* 1000/, 'H3 自动检查应在快照快过期前刷新');
assert.doesNotMatch(machineStatusSource, /worker_url|public_base_url|admin_token/, '前端状态 helper 不能展示内部地址或 admin token');
assert.doesNotMatch(machineStatusSource, /API 设置/, 'H3 状态块不能再把用户引导到 API 设置');

assert.match(generatePageSource, /fetch\('\/api\/config'/, '普通生成页必须读取公开配置判断 H3 是否可用');
assert.match(generatePageSource, /normalizeH3VideoConfig/, '普通生成页必须安全归一化 H3 配置');
assert.match(generatePageSource, /h3DisabledReason/, '普通生成页必须把 H3 健康检查缺口显示成管理员可读原因');
assert.match(generatePageSource, /buildH3MachineStatus/, '普通生成页必须接入 H3 状态判断');
assert.match(generatePageSource, /providerStatus=\{h3MachineStatus\}/, '普通生成页必须把 H3 状态传入编辑器');
assert.match(generatePageSource, /H3_INLINE_MODEL_ID/, '普通生成页必须把 H3 当作模型选项处理');
assert.match(generatePageSource, /H3 本地模型/, '普通生成页必须把 H3 显示为模型选项');
assert.match(generatePageSource, /triggerH3AutoCheck/, '普通生成页必须自动刷新 H3 状态');
assert.match(generatePageSource, /window\.addEventListener\('focus', triggerH3AutoCheck\)/, '普通生成页回到页面时必须补刷新 H3 状态');
assert.match(generatePageSource, /setInterval\(triggerH3AutoCheck, H3_AUTO_CHECK_MIN_GAP_MS\)/, '普通生成页打开期间必须定期判断是否需要刷新 H3 状态');
assert.match(generatePageSource, /actionLabel: '刷新'/, '普通生成页手动动作只能是刷新兜底，不应要求用户检查状态');
assert.match(generatePageSource, /currentUser\?\.role === 'admin'/, 'H3 未配置时只给管理员显示禁用提示');
assert.match(generatePageSource, /providerOptions=\{\[\]\}/, '普通生成页不能再单独暴露 H3 引擎下拉');
assert.match(generatePageSource, /onModelChange=\{handleGenerationModelChange\}/, '普通生成页必须由模型选择驱动 provider');
assert.match(generatePageSource, /provider:\s*isIpSurface \? undefined : requestedProvider/, '普通生成提交必须透传 provider');
assert.match(generatePageSource, /model:\s*requestedModel \|\| undefined/, '普通生成提交必须把 H3 模型映射成默认 preset');
assert.match(generatePageSource, /h3VideoConfig\?\.lora_options\.find\(\(option\) => option\.id === params\.h3LoraId\)\?\.id/, '普通生成提交前必须用最新 H3 LoRA 配置过滤旧值');
assert.match(generatePageSource, /lora_id:\s*selectedH3Model \? requestedH3LoraId : undefined/, '普通生成提交必须把过滤后的 H3 LoRA 选择透传给后端');
assert.match(generatePageSource, /auxiliaryOptions=\{activeH3LoraOptions\}/, '普通生成页必须只在 H3 模型下显示 LoRA 下拉');
assert.match(generatePageSource, /data\.provider \|\| \(isIpSurface \? 'volcengine_ark' : requestedProvider\)/, '最近任务 provider 必须跟创建结果或用户选择一致');

assert.match(templatePageSource, /fetch\('\/api\/config'/, '模板生成页必须读取 H3 公开配置');
assert.match(templatePageSource, /h3DisabledReason/, '模板生成页必须把 H3 健康检查缺口显示成管理员可读原因');
assert.match(templatePageSource, /buildH3MachineStatus/, '模板生成页必须接入 H3 状态判断');
assert.match(templatePageSource, /providerStatus=\{h3MachineStatus\}/, '模板生成页必须把 H3 状态传入编辑器');
assert.match(templatePageSource, /provider:\s*requestedProvider/, '模板生成提交必须透传 provider');
assert.match(templatePageSource, /model:\s*requestedModel \|\| undefined/, '模板生成提交必须把 H3 模型映射成默认 preset');
assert.match(templatePageSource, /h3VideoConfig\?\.lora_options\.find\(\(option\) => option\.id === params\.h3LoraId\)\?\.id/, '模板生成提交前必须用最新 H3 LoRA 配置过滤旧值');
assert.match(templatePageSource, /lora_id:\s*selectedH3Model \? requestedH3LoraId : undefined/, '模板生成提交必须把过滤后的 H3 LoRA 选择透传给后端');
assert.match(templatePageSource, /auxiliaryOptions=\{activeH3LoraOptions\}/, '模板生成页必须只在 H3 模型下显示 LoRA 下拉');
assert.match(templatePageSource, /providerOptions=\{\[\]\}/, '模板生成页不能再单独暴露 H3 引擎下拉');
assert.match(templatePageSource, /onModelChange=\{handleGenerationModelChange\}/, '模板生成页必须由模型选择驱动 provider');
assert.match(templatePageSource, /H3 本地模型/, '模板生成页必须复用 H3 模型入口');
assert.match(templatePageSource, /triggerH3AutoCheck/, '模板生成页必须自动刷新 H3 状态');
assert.match(templatePageSource, /window\.addEventListener\('focus', triggerH3AutoCheck\)/, '模板生成页回到页面时必须补刷新 H3 状态');
assert.match(templatePageSource, /setInterval\(triggerH3AutoCheck, H3_AUTO_CHECK_MIN_GAP_MS\)/, '模板生成页打开期间必须定期判断是否需要刷新 H3 状态');

console.log('h3-generate-ui smoke passed');
