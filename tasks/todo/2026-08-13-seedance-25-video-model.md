# Seedance 2.5 视频模型线上接入规划

## 1. 大白话目标复述

给线上 sd2 服务器版本增加 Seedance 2.5 视频模型。用户在生成页底部参数栏点击当前的 `Seedance 2.0` 模型 chip 时，可以选择 `Seedance 2.5`；提交后后端必须真的把 2.5 模型 ID 发给 Seedance Provider，任务记录、后台产出、成本和无线画布能力都能看到实际模型，不允许页面显示 2.5 但后台仍跑 2.0。

本轮落点固定为 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，完成后必须部署到线上 `sd2.youdoodesign.com` / `sd2.youdooart.com` 当前生产服务。当前规划不授权真实付费生成；真实 2.5 生成验收需用户另行明确授权。

文档依据：用户提供的 `https://model.seedance-api.net/docs?menu=apiSeedance25`。该动态文档中 `ApiSeedance25` 与 `ApiSeedance25FullFeatured` 样例继续使用 `/server/api/call` 和 `/server/api/getResult`，请求字段沿用 `apiKey`、`content`、`generate_audio`、`ratio`、`duration`、`watermark`、`resolution`、`model`、`clientRequestId`；2.5 查询结果返回模型 `dreamina-seedance-2-5-260628`，Full-Featured 请求样例也直接使用该模型 ID。

## 2. 具体可执行任务

- [ ] T1. 建立 Seedance 视频模型白名单
  - 修改对象：`src/lib/provider/jimeng.ts`，必要时新增 `src/lib/provider/seedance-models.ts` 或在现有 provider 文件内保持最小封装。
  - 做法：定义允许模型列表，至少包含当前稳定 `dreamina-seedance-2-0-260128` 和新增 `dreamina-seedance-2-5-260628`；保留 2.0 为默认，2.5 作为可选项。
  - 完成标准：只有白名单模型能进入 provider payload；未知 `body.model` 自动回退默认或返回清晰 400，不能透传任意模型字符串。

- [ ] T2. 打通 `/api/tasks/create` 的模型选择
  - 修改对象：`src/app/api/tasks/create/route.ts`。
  - 做法：读取 `body.model`，通过白名单解析出 `selectedModel`；创建 `VideoTask.model`、`providerInput.model`、`ProviderApiRequest.requestPayload`、`taskParams`、返回 JSON 都使用同一个 `selectedModel`。
  - 完成标准：任务记录、provider 请求、响应里的模型一致；页面选 2.5 时不会仍写死 2.0。

- [ ] T3. 让 Provider 适配器使用入参模型
  - 修改对象：`src/lib/provider/jimeng.ts` 和 `src/types/index.ts`。
  - 做法：给 `CreateVideoInput` 增加可选 `model`；`createVideoTask` 不再内部硬编码模型，而是使用解析后的白名单模型；`getProviderConfig` 暴露默认模型和 `model_options`。
  - 完成标准：mock fetch 测试能断言 POST 到 Seedance 的 payload.model 是用户选择的 2.5。

- [ ] T4. 把 2.5 入口放到用户标注的位置
  - 修改对象：`src/components/generate/GeneratePageClient.tsx`、`src/components/GenerationComposer.tsx`、`src/components/ComposerActionBar.tsx`。
  - 做法：普通生成页也传入模型选项；入口使用页面底部参数栏当前 `Seedance 2.0` chip，点击后下拉显示 `Seedance 2.0` 和 `Seedance 2.5`，不新增第二个生成页、不新增顶部大按钮。
  - 完成标准：`https://sd2.youdooart.com/generate` 中用户标注的 chip 文案可切换；选择 2.5 后 chip 显示 `Seedance 2.5`，提交体包含 2.5 模型 ID。

- [ ] T5. 前端体验规则
  - 做法：2.0 默认继续是稳定选项；2.5 只作为当前任务的可见选择项。模型下拉只显示用户能理解的名称和短说明，不暴露 API key、base URL、endpoint 等内部信息。
  - 完成标准：主流程仍是“写提示词 -> 选参数 -> 提交”；低频模型细节只放在下拉小字或后台，不干扰生成。

- [ ] T6. 同步无线画布和外部 API 能力
  - 修改对象：`src/app/api/config/route.ts`、`src/app/api/tools/ultimate-canvas/bootstrap/route.ts`、必要时 `public/tools/ultimate-canvas/*` 和 `docs/sd2-external-api-integration.md`。
  - 做法：`/api/config` 返回 `model_options`；无线画布 `capabilities.video` 至少显示当前默认模型和允许模型列表。外部 API 文档更新为“支持 Seedance 2.0 / 2.5 白名单模型”，不新建独立文档。
  - 完成标准：站内生成页、无线画布、外部 API 说明不互相矛盾。

- [ ] T7. 补最小回归测试
  - 新增或修改脚本：建议新增 `scripts/seedance-model-select-smoke.ts`，并扩展 `scripts/provider-create-error-smoke.ts` 或新增 provider payload mock。
  - 覆盖点：前端普通生成页传 `modelOptions`；后端读取 `body.model`；任务创建、provider payload 和日志摘要都使用 `selectedModel`；未知模型不会透传。
  - 完成标准：测试不调用真实 Provider，不消耗点数。

- [ ] T8. 本地验证、Git、线上部署
  - 验证命令：`npx tsx scripts/seedance-model-select-smoke.ts`、相关 provider mock smoke、`npm run lint`、`npm run build`。
  - Git：保护当前已有 `tasks/todo.md`、`tasks/todo/hygiene-log.md` 脏改；本轮改动用精确暂存，形成清晰 commit 并 push。
  - 部署：执行 `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`、`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2`。
  - 公网验证：检查 `https://sd2.youdoodesign.com/api/config` 和 `https://sd2.youdooart.com/api/config` 返回模型列表；检查 `https://sd2.youdooart.com/generate` 的前端资源或 DOM 包含 `Seedance 2.5`；等待约 70 秒后再次确认 `youdoo-sites status sd2` 和 LaunchAgent `runs` 没异常增长。

- [ ] T9. 真实 2.5 生成验收（需要单独授权）
  - 停止条件：没有用户明确授权真实扣费前，不跑真实 Seedance 2.5 生成。
  - 授权后最小样例：4 秒、480p、单张小参考图或纯文本，传 `x-paid-generation-intent` 和 `x-paid-generation-reason`。
  - 完成标准：任务成功、视频可下载、`VideoTask.model` 为 2.5、`CreditLedger` 和 `CostLedger` 闭环。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [ ] R1. 入口位置验收
  - 检查对象：`https://sd2.youdooart.com/generate` 用户标注的底部参数栏模型 chip。
  - 通过标准：2.5 入口就在当前 `Seedance 2.0` chip 的下拉里，不是新页面、新顶部按钮或隐藏后台项。
  - 证据来源：公网 DOM、截图或 Playwright 定位结果。

- [ ] R2. 后端真实模型验收
  - 检查对象：`src/app/api/tasks/create/route.ts`、`src/lib/provider/jimeng.ts`、测试输出。
  - 通过标准：选择 2.5 后 provider payload、`VideoTask.model`、`ProviderApiRequest` 摘要使用同一个 2.5 模型 ID；未知模型不会透传。
  - 证据来源：mock fetch smoke、任务创建代码、必要时数据库只读查询。

- [ ] R3. 线上部署验收
  - 检查对象：`youdoo-sites build/restart/status sd2`、公网 `/api/config`、公网 `/generate`。
  - 通过标准：新构建已加载，公网可见 2.5 模型选项；健康守护周期后服务仍稳定。
  - 证据来源：命令输出、公网 HTTP 响应、静态资源或 DOM 证据。

- [ ] R4. 固定审核线程只读审查
  - 检查对象：全部实现 diff、测试结果、Git 状态、线上证据。
  - 通过标准：派给 `审核001 - sd2 固定只读审查`；审核线程只读审查并把发现追加到 `tasks/audit-001-review.md`，回执包含通过/不通过、证据、缺口和下一步。
  - 证据来源：审核线程回执，固定收尾语 `审核完成，等待推进`。

## 4. 审查内容是否对齐目标

- [ ] A1. R1 是否对齐入口目标
  - 判断：R1 能证明用户标注的位置已经成为 2.5 入口。

- [ ] A2. R2 是否对齐真实调用目标
  - 判断：R2 能防止“页面显示 2.5、实际调用 2.0”的假完成。

- [ ] A3. R3 是否对齐线上服务器版本目标
  - 判断：R3 能证明不是本地完成，而是线上 sd2 当前生产服务可见。

- [ ] A4. R4 是否对齐固定审核规则
  - 判断：R4 能证明审查由固定只读审核线程完成，当前执行线程不把自测冒充独立审核。
