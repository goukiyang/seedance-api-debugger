# GPT Image 独立生图页与固定上下文

## 1. 大白话目标复述

新增独立图片生成页面：所有登录用户可用；仅管理员编辑全站固定上下文，自动保存；参考图片选填，最多两张；正文输入、快捷与自定义生成张数、生成结果预览与单张/批量下载。不做连续修改。来源：本任务用户确认，2026-09-20。

生产目标 https://sd2.youdooart.com；部署源 /Volumes/Data/Projects/video-api-debugger-v12-full-todo。线上核实仍为 53d0274 / v0.2.1。本地 7e1940f 的批量下载修复未发布，不可随本任务默默上线。

## 2. 具体可执行任务

| 编号 | 任务 | 完成标准 | 当前状态 |
|---|---|---|---|
| I1 | 核对接口与现有能力 | 确认真实模型、计费及复用入口 | 进行中：模型已确认，积分待用户选择 |
| I2 | 实现生图页与上下文设置 | 权限、上传、生成、保存、下载完整衔接 | 进行中：页面、自动保存设置与适配器已写；执行/结果链路未完成 |
| I3 | 验证与发布 | 检查通过，线上页面可用并有回退点 | 未开始 |

- 实证：通过已有服务端配置调用中转 /v1/models，200，包含 gpt-image-2、gpt-image-2.5-flare、gpt-image-2.5-sunburst；不输出凭据、未付费生成。
- 现有 src/lib/integrations/image-generation.ts 走 Gemini/Seedream，保持不变；新增独立 src/lib/image-studio 适配器。
- 复用现有 uploadFileAsAsset、ZoomableImagePreview、PlatformSetting 与 getAdminUser。设置使用版本冲突检查；普通用户响应不含上下文原文。
- 尚未确定积分：已向用户询问沿用现有规则/独立计价/不扣积分。未发现 GPT 图片既有积分规则，不擅自采用免费视频规则或开放无限免费生成。
- 后续必须完成：服务端拼入固定上下文快照；任务持久化与幂等；素材归属校验；真实图片保存；部分成功和失败恢复；单张/打包下载；刷新恢复；普通用户不能读/改管理员上下文；收费决策落实后才开放菜单和生成。
- Git Plan：当前 codex/credit-applications-20260915，保护原 tasks 目录脏改；仅暂存本轮文件。未完成实现不发布，不抬产品版本。发布前隔离尚未发布的下载修复，核对唯一线上提交与回退点。
- 开源参考：已读 OpenAI Node SDK images.ts 的 generations JSON 与 edits multipart 实现；不安装新 SDK，使用现有 fetch/FormData，避免增加依赖。https://github.com/openai/openai-node/blob/main/src/resources/images.ts 。模型文档 https://developers.openai.com/api/docs/models/gpt-image-2.5-flare 。适配器模拟验证不等于中转付费接口已跑通。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [ ] R1. 目标验收
  - 检查对象：新页面、settings API、provider 及后续任务/下载链路。
  - 通过标准：普通用户可生成但不能获取或改上下文；0/1/2 图及张数校验；重试不重复计费；结果可下载；改动不影响原视频/Gemini/Seedream链路。
  - 必须区分：类型检查、模拟接口、真实付费生成、生产页面验证。付费测试需单独授权。

## 4. 审查内容是否对齐目标

- [ ] A1. R1 是否对齐目标
  - 判断：审查项是否真的能证明目标完成，而不是只检查表面动作。

## 5. 阶段检查（不是整项验收）

- `npx tsx scripts/image-studio-provider-smoke.ts`：通过；纯文字 JSON、双图 multipart、模型/张数边界、空输出与上游错误脱敏；没有真实付费请求。
- `git diff --cached --check`：本轮暂存文件通过；全库差异另有既有 todo 改动，未混入暂存。
- 全库 `npx tsc --noEmit --incremental false` 在本机磁盘读取等待数分钟后主动终止；随后定向 `node node_modules/typescript/bin/tsc -p /tmp/sd2-image-studio-tsconfig.json --noEmit` 完成，exit 0，本轮模块及其导入依赖类型检查通过。不是全库构建通过。
- 固定审核任务 019f44c6-64d3-7753-acd0-f31fc16763fb 阶段只读复核通过；仅覆盖页面/设置/适配器基础，不包含未实现任务与下载，也非生产验收。
- 审核最初质疑 `image[]`，后用官方 SDK uploads.ts 数组编码实现复核并撤回该阻塞；保留中转真实付费兼容性未验证的缺口。https://github.com/openai/openai-node/blob/main/src/internal/uploads.ts
- 普通用户权限、自动保存的浏览器真实操作尚未实测；未部署、未做真实付费生成、未改数据库或积分。生成入口仍禁用，不展示可用假象。
