import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const composerSource = readFileSync('src/components/GenerationComposer.tsx', 'utf8');
const actionBarSource = readFileSync('src/components/ComposerActionBar.tsx', 'utf8');
const generatePageSource = readFileSync('src/components/generate/GeneratePageClient.tsx', 'utf8');
const templatePageSource = readFileSync('src/components/templates/TemplateGenerateClient.tsx', 'utf8');

assert.match(actionBarSource, /生成引擎/, '底部参数栏必须显示生成引擎入口');
assert.match(actionBarSource, /providerOptions/, '生成引擎必须是可配置下拉，不硬编码在页面里');
assert.match(actionBarSource, /disabledReason/, 'H3 未配置时管理员必须看到禁用原因');

assert.match(composerSource, /provider:\s*selectedProvider \|\| null/, '提交参数必须包含选中的 provider');
assert.match(composerSource, /onProviderChange/, '生成编辑器必须接收引擎切换回调');

assert.match(generatePageSource, /fetch\('\/api\/config'/, '普通生成页必须读取公开配置判断 H3 是否可用');
assert.match(generatePageSource, /normalizeH3VideoConfig/, '普通生成页必须安全归一化 H3 配置');
assert.match(generatePageSource, /h3DisabledReason/, '普通生成页必须把 H3 健康检查缺口显示成管理员可读原因');
assert.match(generatePageSource, /H3 本地工作站/, '普通生成页必须有 H3 本地工作站中文入口');
assert.match(generatePageSource, /currentUser\?\.role === 'admin'/, 'H3 未配置时只给管理员显示禁用提示');
assert.match(generatePageSource, /provider:\s*isIpSurface \? undefined : requestedProvider/, '普通生成提交必须透传 provider');
assert.match(generatePageSource, /data\.provider \|\| \(isIpSurface \? 'volcengine_ark' : requestedProvider\)/, '最近任务 provider 必须跟创建结果或用户选择一致');

assert.match(templatePageSource, /fetch\('\/api\/config'/, '模板生成页必须读取 H3 公开配置');
assert.match(templatePageSource, /h3DisabledReason/, '模板生成页必须把 H3 健康检查缺口显示成管理员可读原因');
assert.match(templatePageSource, /provider:\s*requestedProvider/, '模板生成提交必须透传 provider');
assert.match(templatePageSource, /model:\s*params\.model \|\| undefined/, '模板生成提交必须透传 H3 preset 或 Seedance model');
assert.match(templatePageSource, /H3 本地工作站/, '模板生成页必须复用 H3 引擎入口');

console.log('h3-generate-ui smoke passed');
