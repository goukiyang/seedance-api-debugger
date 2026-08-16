# H3 LoRA 下拉选择闭环

## 1. 大白话目标复述

用户要的是：H3 的 LoRA 选择不能藏在后台默认配置里，要像模型一样在生成页给用户一个可见下拉项；系统可以先给一个默认值。做到完成的标准是：用户选择 H3 后能看到 LoRA 下拉，默认 LoRA 自动带出，提交生成时后端收到 `lora_id` 并转换成 H3 服务实际需要的 LoRA 配置，同时任务记录能追踪当时选择。

## 2. 具体可执行任务

- [x] T1. 配置层补 H3 LoRA 白名单
  - 修改文件：`src/lib/integrations/h3.ts`、`src/components/H3MachineStatus.ts`。
  - 做法：公开 `default_lora_id` 和 `lora_options`，只允许系统白名单里的 LoRA，不允许前端直接传任意文件名。
  - 完成标准：`/api/config` 返回 H3 LoRA 候选项，不泄露 token、内部地址或本机路径。

- [x] T2. 后端创建任务接收并转发 LoRA
  - 修改文件：`src/lib/provider/h3.ts`、`src/app/api/tasks/create/route.ts`。
  - 做法：接收 `lora_id`，后端映射成 `{ node_type, lora_name, strength, low_vram }` 后放入 H3 generate payload，并写入 snapshot、params 和 source metadata。
  - 完成标准：前端或外部接口传 `lora_id` 时，H3 provider 请求体里有对应 `lora`；非法 LoRA 返回清晰 400。

- [x] T3. 前端生成页显示 H3 LoRA 下拉
  - 修改文件：`src/components/ComposerActionBar.tsx`、`src/components/GenerationComposer.tsx`、`src/components/generate/GeneratePageClient.tsx`、`src/components/templates/TemplateGenerateClient.tsx`。
  - 做法：只在当前模型选中 H3 时显示 LoRA chip，下拉样式复用模型选择，默认选 `default_lora_id`。
  - 完成标准：普通生成页和模板生成页都能选 LoRA，并在提交体里带 `lora_id`。

- [x] T4. 补 smoke 验证
  - 修改文件：`scripts/h3-generate-ui-smoke.ts`、`scripts/h3-admin-settings-smoke.ts`、`scripts/h3-provider-adapter-smoke.ts`。
  - 做法：验证 LoRA 配置公开、UI 透传、provider payload 白名单映射。
  - 完成标准：相关 smoke、lint、build 至少通过本地验证；不跑真实 H3 视频生成。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [x] R1. LoRA 下拉是否真实闭环
  - 检查对象：`ComposerActionBar`、`GenerationComposer`、普通生成页、模板生成页、`/api/tasks/create`、H3 provider payload。
  - 通过标准：UI 能选，提交能带，后端能校验，provider 请求体能包含 LoRA，不是只做了前端展示。
  - 证据来源：smoke 脚本、lint/build、关键源码检查。

- [x] R2. 安全边界是否守住
  - 检查对象：`/api/config` 返回体、任务创建日志、provider request 记录。
  - 通过标准：不暴露 token、cookie、签名 URL、本机路径；前端不能传任意 LoRA 文件名绕过白名单。
  - 证据来源：配置 DTO、白名单函数、测试断言。

## 4. 审查内容是否对齐目标

- [x] A1. R1 是否对齐目标
  - 判断：R1 同时查页面、提交体和 provider 请求体，能证明“像模型一样可选”以及“选择后实际生效”。

- [x] A2. R2 是否对齐目标
  - 判断：R2 防止把 LoRA 选择做成不受控的文件名输入，符合外部接口和内部后台共用的安全要求。

## 5. 收尾记录

- 独立只读审查：子 agent 首次结论为“不通过”，指出 `src/lib/provider/h3.ts` 允许内部调用方直传任意 `lora` 对象，可能绕过 `lora_id` 白名单。
- 已修复：`src/lib/integrations/h3.ts` 增加 LoRA payload 反查；`src/lib/provider/h3.ts` 对直传 `lora` 也必须匹配白名单，否则拒绝。
- 已补测：`scripts/h3-provider-adapter-smoke.ts` 增加非法 `lora_id` 和未知 `lora` 对象拒绝断言。
- 验证结果：H3 smoke 全部通过；`npm run lint` 通过但仍有既有 warning；`npm run build` 通过。
- 未执行项：未跑真实 H3 视频生成，避免占用 GPU 和产生新任务；本次只验证生成接入和请求体闭环。

## 6. 2026-08-16 线上失败补充

- 现象：生成页选择 `LightX2V 8-step LoRA` 后，H3 创建阶段直接失败，页面显示“未知异常”。
- 根因：H3 API 0.3.2 当前 allowlist 只接受 `minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` 和 `minimax_h3_turbo_v4_step600_ema.safetensors`。8-step 文件即使机器上存在，也不等于 API 白名单可用。
- 修正：前端和外部 `/api/tasks/create` 只保留两个当前可用 LoRA；H3 返回 `code=unsupported_lora` 时显示明确中文原因，不再落到“未知异常”。
- 验收重点：以后新增 LoRA 必须以 H3 API allowlist / presets 实际可提交为准，不能只看机器文件是否存在。
