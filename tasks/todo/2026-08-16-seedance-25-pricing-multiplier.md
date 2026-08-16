# Seedance 2.5 按 2.0 的 1.5 倍扣费

## 1. 大白话目标复述

官方确认 Seedance 2.5 的扣费费率是 Seedance 2.0 的 1.5 倍。系统现在已经能选择和传递 2.0 / 2.5 模型，但内部点数预估、冻结和扣点仍共用一套 Seedance 规则。这次要把 2.5 的内部扣点配置成 2.0 的 1.5 倍，确保普通生成页、无线画布和外部 API 只要走统一创建任务接口，都会拿到一致的扣点规则。

完成标准：选择 2.0 时维持原有扣点；选择 2.5 时预估、冻结、成功扣点和 pricing snapshot 都体现 `1.5` 倍；供应商真实美元成本仍只使用 provider 返回的 `actual_cost + currency_or_credit_type`，不拿内部点数反推美元。

## 2. 具体可执行任务

- [x] T1. 服务端扣点规则改成按模型区分
  - 文件：`src/lib/pricing.ts`
  - 做法：新增 Seedance 2.0 / 2.5 模型倍率解析；2.0 倍率 `1.0`，2.5 倍率 `1.5`；`calculateEstimatedCost` 根据模型 ID 或模型标签计算最终点数。
  - 完成标准：2.0 仍按原规则；2.5 点数为同参数 2.0 的 1.5 倍并向上取整；pricing snapshot 记录模型、倍率和公式。
- [x] T2. 创建任务和估价接口都传入模型
  - 文件：`src/app/api/tasks/create/route.ts`、`src/app/api/tasks/estimate/route.ts`
  - 做法：创建任务已经有 `selectedModel`，确认扣点计算用模型 ID；估价接口补 `model` 参数解析，返回对应模型成本。
  - 完成标准：普通生成、无线画布、外部 API 只要传 `model`，统一由后端计算对应扣点；未传模型保持默认 2.0。
- [x] T3. 前端即时估价跟后端规则对齐
  - 文件：`src/lib/pricing-client.ts`、`src/components/GenerationComposer.tsx`
  - 做法：客户端估价函数支持模型参数；生成页把当前选择模型传入即时点数估算。
  - 完成标准：用户切到 2.5 时，提交按钮旁的预估点数同步变高；2.0 不变。
- [x] T4. 补无付费验证
  - 文件：`scripts/seedance-model-select-smoke.ts`
  - 做法：加入 2.0 / 2.5 扣点差异断言；确认 `/api/tasks/estimate` 源码支持模型参数；不触发真实生成。
  - 完成标准：smoke 脚本能证明 2.5 是 2.0 的 1.5 倍，且模型仍进入 provider payload。
- [x] T5. 文档口径同步
  - 文件：`docs/sd2-external-api-integration.md`
  - 做法：对外说明 `model` 会影响平台内部点数扣费；2.5 是 2.0 的 1.5 倍；官方美元成本以任务完成后的 provider 字段为准。
  - 完成标准：外部接入方知道扣点差异，不会把点数当美元。
- [x] T6. 外部配置接口暴露模型倍率
  - 文件：`src/app/api/codex/config/route.ts`
  - 做法：`supported_settings.model` 返回 2.0 / 2.5 的 ID、标签、默认项和 `internal_credit_multiplier`。
  - 完成标准：外部接入方调用 `/api/codex/config` 即可发现 2.5 是 1.5 倍内部点数。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [x] R1. 扣点规则验收
  - 检查对象：`src/lib/pricing.ts`、`src/lib/pricing-client.ts`、`scripts/seedance-model-select-smoke.ts`
  - 通过标准：2.0 倍率为 `1.0`，2.5 倍率为 `1.5`；2.5 同参数成本等于 2.0 成本乘 1.5 后向上取整；未知模型不绕过后端白名单。
  - 证据来源：smoke 脚本输出、源码断言。
- [x] R2. 链路验收
  - 检查对象：`src/app/api/tasks/create/route.ts`、`src/app/api/tasks/estimate/route.ts`、`src/components/GenerationComposer.tsx`
  - 通过标准：创建任务、估价接口、前端即时估价都使用同一个模型参数；未传模型默认 2.0；无线画布和外部 API 因复用创建任务接口自动生效。
  - 证据来源：源码检查、smoke 脚本、lint/build。
- [x] R3. 成本口径验收
  - 检查对象：`docs/sd2-external-api-integration.md`、成本账本相关说明
  - 通过标准：平台内部点数和供应商 USD 成本仍清楚分离；没有写成“2.5 美元一定是 2.0 的 1.5 倍”这类未经 provider result 逐单确认的话。
  - 证据来源：文档 diff、后台已有 `provider_official_amount_micros` 逻辑不改动。

只读审查结果：独立子 agent `01a00984-bc28-7353-874c-a937a1af07ec` 判定“通过”，并指出 `/api/codex/config` 需补充模型枚举和倍率说明；该补项已作为 T6 完成。主线程复验命令：`npx tsx scripts/seedance-model-select-smoke.ts`、`npx tsx scripts/provider-create-error-smoke.ts`、`npm run lint`、`npm run build`、点数复核 `4s: 2.0=12 / 2.5=18；5s: 2.0=15 / 2.5=23`。

## 4. 审查内容是否对齐目标

- [x] A1. R1 是否对齐目标
  - 判断：R1 能证明“2.5 按 2.0 的 1.5 倍扣点”，不是只证明模型选项存在。
- [x] A2. R2 是否对齐目标
  - 判断：R2 能覆盖普通生成页、无线画布和外部 API 的统一入口，避免只改单个页面显示。
- [x] A3. R3 是否对齐目标
  - 判断：R3 能防止内部点数和供应商美元成本混淆，保留真实成本字段的权威性。
