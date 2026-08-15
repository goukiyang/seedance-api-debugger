# H3 API 接入现有视频生成链路

> **For Codex:** 执行本计划时先读取 `${CODEX_HOME:-$HOME/.codex}/skills/executing-plans/SKILL.md`，并按任务逐项落地。

## 1. 大白话目标复述

这次要把 `/Volumes/Data/Downloads/Current/EXTERNAL_AGENT_API_GUIDE.md` 里的 H3 视频生成 API 接进 sd2 当前系统。普通用户不需要进入新的 H3 页面，而是在现有生成页把生成引擎切到「H3 本地工作站」；管理员在后台集成页配置 H3 API 地址、token、预设和队列状态。完成后，H3 任务必须进入现有 `VideoTask`、项目产出、状态轮询、结果缓存、缩略图、成本/记录和部署闭环，不允许成为一套孤立系统。

## 2. 关键产品和技术决策

- [x] D1. 用户入口不新增顶部导航页面
  - 普通生成入口仍是 `/generate`。
  - 模板生成后续走 `/template-generate` 同一套生成引擎选择。
  - 无线画布后续作为节点能力接入，不作为第一入口。

- [x] D2. 后台入口放在 `/admin/integrations`
  - 新增「H3 本地生成服务」配置卡。
  - 管理员 token 只存在服务端配置和后端调用里，不进入浏览器。

- [x] D3. 第一版不引入外部 Comfy 前端或 SDK
  - 不接 ViewComfy、Kitchen ComfyUI、ComfyUI 前端。
  - 不直接调用 worker 或 ComfyUI。
  - 直接按 H3 gateway 的 `/api/h3/*` 写薄 adapter，减少依赖和页面混乱。

- [x] D4. H3 素材处理规则
  - 首帧、尾帧、参考图先进入我们现有资产库。
  - 后端读取图片字节，转 `base64` 调 H3 `/api/h3/inputs/images`。
  - H3 返回的图片文件名再写入 `first_frame` / `last_frame`。
  - 多余参考图第一版只转成提示词上下文，不假装 H3 已支持多图。
  - 参考视频第一版不直传 H3；只作为上下文或后续等待 H3 新字段。
  - 音频文件第一版不直传 H3；只支持 `audio_prompt` / `music_prompt` 文本。

- [x] D5. 真实生成前先做无成本 mock 验证
  - 未得到明确授权前，不发起真实 H3 生成。
  - 先用 mock fetch / mock adapter 证明：前端选择、后端入参、任务落库、provider payload、状态映射、结果缓存路径全部连通。

- [x] D6. 所有影响 H3 最终请求的内容必须可见
  - 多余参考图如果只作为上下文，不能偷偷生成隐藏描述。
  - 要么由用户手写上下文，要么由 LLM 生成后显示在最终上下文/最终提示词里，管理员或用户确认后再提交。
  - H3 第一版不支持的素材、字段和高级参数必须在 UI 上明说，不做无提示降级。

## 3. 具体可执行任务

- [ ] T0. 锁定 H3 接入前置条件
  - 检查对象：`/Volumes/Data/Downloads/Current/EXTERNAL_AGENT_API_GUIDE.md`、`https://sd2.youdooart.com` 生产目标、服务器到 H3 公网 API 的可达性。
  - 要确认：H3 公网 API 地址、`H3_API_TOKEN`、`H3_ADMIN_TOKEN`、默认 preset、队列上限、真实生成是否允许消耗本地算力。
  - 完成标准：形成一份不包含 token 明文的接入参数摘要，明确 H3 是否可从 sd2 服务器访问。
  - 健康准入：只有 `api=ok`、`worker.worker=ok`、`worker.comfyui=ok`、公网反代/tunnel 稳定、队列上限启用时，才允许打开普通用户入口。
  - 停止条件：H3 只有 `127.0.0.1:8893` 且服务器无法访问、worker/ComfyUI 不健康、公网反代不稳定或队列保护未开启时，不开放用户入口。
  - 本轮状态：已按 H3 guide 完成代码接入参数和安全边界；普通用户 H3 入口现在必须等后台测试连接写入 `api=ok + worker=ok + comfyui=ok` 后才开放。2026-08-15 复查确认生产库没有 `h3_video_api_v1` 配置记录，生产服务器 `H3_*TOKEN` 未配置，服务器和本机 `127.0.0.1:8893` 都没有 H3 gateway 监听；本机 `8793` 是 media-link 服务，不是 H3。真实 H3 公网地址、token、worker/ComfyUI 健康和服务器可达性仍待 T12/T13 验证。

- [x] T1. 新增 H3 后台配置模型
  - 创建：`src/lib/integrations/h3.ts`
  - 创建：`src/app/api/admin/integrations/h3/route.ts`
  - 修改：`src/app/admin/integrations/AdminIntegrationsClient.tsx`
  - 内容：
    - 配置字段：`enabled`、`base_url`、`api_token`、`admin_token`、`default_preset_id`。
    - 安全 DTO：只返回 `api_token_configured`、`admin_token_configured`，不返回 token 明文。
    - 支持保存、清空 token、健康检查、读取 presets。
    - 操作写 `operationLog`，记录谁改了 H3 配置。
  - 验证：新增 `scripts/h3-admin-settings-smoke.ts`，覆盖保存、读取、清空 token、安全 DTO 不泄漏 token。
  - 2026-08-15 加固：新增健康快照 `health`，配置齐全只代表 `configured=true`，只有测试连接通过后才返回 `ready=true` / `admin_queue_ready=true`。

- [x] T2. 新增 H3 provider adapter
  - 创建：`src/lib/provider/h3.ts`
  - 内容：
    - `getH3Health`
    - `listH3Presets`
    - `uploadH3ReferenceImage`
    - `createH3VideoJob`
    - `getH3JobStatus`
    - `listH3JobOutputs`
    - `downloadH3JobOutput`
    - 统一处理 400/401/403/404/502/503、`Retry-After`、超时和 AbortSignal。
    - 内置 H3 参数白名单：preset 只允许 `larry_v4_6step`、`larry_v4_8step`、`lightx2v_4step_turbo`。
    - aspect_ratio 只允许 `16:9`、`9:16`、`1:1`、`4:3`、`3:4`。
    - `duration_sec` 默认 5，最大 15；超出时返回中文错误，不静默截断。
    - `seed` 只允许 `-1` 或安全整数；`width` / `height` 第一版隐藏，不开放普通用户填写。
  - 验证：新增 `scripts/h3-provider-adapter-smoke.ts`，用 mock fetch 断言 URL、Header、payload、参数白名单、错误转换和 token 不被写入日志。
  - 2026-08-15 加固：`done` 但没有视频输出时转为 `failed`，错误码写入 `h3_done_without_output`，避免成功结算不可播放任务。

- [x] T3. 新增 H3 provider 状态映射
  - 修改：`src/lib/provider/video-task-status.ts`
  - 修改：`src/lib/video/task-finalizer.ts`
  - 内容：
    - 新增常量 `VIDEO_TASK_PROVIDER_H3 = 'h3'`。
    - `pending` / `dispatching` / `queued` 映射为本地 `submitted`。
    - `running` 映射为本地 `running`。
    - `done` 映射为本地 `succeeded`。
    - `failed` 映射为本地 `failed`。
    - `cancelled` / `deleted` 映射为本地 `cancelled`。
    - 输出视频不能直接暴露 H3 token；结果下载走后端下载器或内部缓存。
    - 轮询遵守 H3 指南：3-5 秒间隔，遇到 `done`、`failed`、`cancelled`、`deleted` 立即停止。
    - 遇到 `Retry-After` 按服务端建议退避，不密集打 H3。
    - 超过最大等待时间或长时间无状态变化时，标记为可恢复异常并保留重试入口，不假装仍在生成。
  - 验证：扩展 `scripts/provider-status-router-smoke.ts`，覆盖 H3 状态、轮询终态、`Retry-After`、超时和未知 provider 报错。
  - 2026-08-15 加固：轮询器读取 `retryAfterMs`，H3 返回 `Retry-After` 时按服务端建议等待。

- [x] T4. 接通 H3 图片素材转交
  - 创建：`src/lib/provider/h3-assets.ts`
  - 修改：`src/app/api/tasks/create/route.ts`
  - 复用：`src/lib/assets/site-upload.ts`、`src/lib/assets/public-storage.ts`、`src/lib/provider/reference-image-safety.ts`
  - 内容：
    - 将已授权的首帧、尾帧、参考图读成字节。
    - 只允许图片类型进入 H3 `/api/h3/inputs/images`。
    - H3 返回的 `filename` 写入 provider payload。
    - 记录原始资产 ID、H3 文件名、用途、sha256 到 `provider_payload_json` 或 `params_json`。
    - 多余参考图如果转成文字上下文，必须写进最终上下文/最终提示词可见区域，不能作为隐藏 prompt 注入。
  - 验证：新增 `scripts/h3-reference-image-handoff-smoke.ts`，覆盖首帧、尾帧、非图片拒绝、多余参考图不直传、多余参考图上下文可见。

- [x] T5. 在创建任务 API 中加入 H3 分支
  - 修改：`src/app/api/tasks/create/route.ts`
  - 内容：
    - 解析 `provider` 或 `engine`，默认仍为 Seedance。
    - H3 只允许已配置且启用后提交。
    - H3 不支持的比例，例如当前 H3 文档未列出的 `21:9`，返回中文错误；不把不支持字段透传给 H3。
    - H3 第一版不接受 `resolution`、`watermark`、`generate_audio` 这类 Seedance 专属字段影响 provider payload；声音只通过可见的 `audio_prompt` / `music_prompt` 文本传入。
    - `provider='h3'`，`model=<preset_id>`，`provider_task_id=<job_id>`。
    - `ProviderApiRequest.endpoint='h3.generate'`。
    - 不硬编码旧 Seedance 默认到 H3 任务里。
    - 创建成功后仍启动现有 `startTaskLocalization`。
  - 验证：新增 `scripts/h3-create-route-smoke.ts`，用 mock adapter 断言任务落库、payload、provider、model、job_id、错误分支。
  - 2026-08-15 加固：任务创建从 `isH3ApiReady` 改为 `isH3Operational`，未测试连接或健康检查未通过时拒绝普通生成。

- [x] T6. 处理 H3 结果下载和本地缓存
  - 修改：`src/lib/video/task-finalizer.ts`
  - 可能创建：`src/lib/video/provider-output-download.ts`
  - 内容：
    - H3 完成后，后端用 H3 token 下载 `/api/h3/jobs/{job_id}/outputs/{index}`。
    - 不把带 token 的 H3 地址暴露给前端。
    - 下载后继续走现有本地缓存、稳定下载 URL、缩略图生成。
    - 如果 H3 输出列表为空，任务保持可重试失败状态，并显示中文错误。
  - 验证：新增 `scripts/h3-finalizer-output-smoke.ts`，覆盖 done 有输出、done 无输出、failed、下载 404、下载 503。
  - 2026-08-15 加固：H3 内部输出地址不会作为前端预览/播放链接；播放接口遇到内部地址返回 `425`；H3 成功结算延后到后端缓存成功，输出下载失败时任务转 `failed` 并写 `output_download_failed`。

- [x] T7. 在普通生成页增加「生成引擎」
  - 修改：`src/components/generate/GeneratePageClient.tsx`
  - 可能修改：`src/components/GenerationComposer.tsx`
  - 内容：
    - 增加用户可见选项：`Seedance 2.0` / `H3 本地工作站`。
    - H3 preset 用中文标签：`推荐`、`画质优先`、`快速预览`；代码 ID 只在小字或调试信息中出现。
    - H3 未启用时不向普通用户展示；管理员可见未配置提示和去后台配置入口。
    - 首帧、尾帧区域保留，提示“会传给 H3”。
    - 多余参考图、参考视频、音频提示“作为上下文，不直接传文件”。
  - 验证：新增 `scripts/h3-generate-ui-smoke.ts`，覆盖配置启用/未启用、选择 H3 后 payload、普通用户不见未配置入口。

- [x] T8. 接入模板生成和无线画布能力声明
  - 修改：`src/components/templates/TemplateGenerateClient.tsx`
  - 修改：`src/app/api/tools/ultimate-canvas/bootstrap/route.ts`
  - 修改：`src/app/api/config` 对应文件，如存在 H3 能力暴露逻辑则补充。
  - 内容：
    - 模板生成只传最终提示词和用户选择的生成引擎，不新建 H3 模板页。
    - 无线画布第一版只暴露能力状态，不急着重做节点生成。
  - 验证：新增或扩展 `scripts/ultimate-canvas-generation-task-coordinator-smoke.ts`，确认 capabilities 里能看到 H3 是否可用。

- [x] T9. 后台增加 H3 队列折叠区
  - 修改：`src/app/admin/integrations/AdminIntegrationsClient.tsx`
  - 修改：`src/app/api/admin/integrations/h3/route.ts` 或新增 `src/app/api/admin/integrations/h3/queue/route.ts`
  - 内容：
    - 只对管理员显示。
    - 支持读取队列、暂停、恢复、取消 pending、停止 running。
    - 支持 move pending job 的 `top`、`up`、`down`、`bottom`；如果第一版暂不实现 move，必须在 UI 中明确显示“暂不支持调整队列顺序”。
    - destructive 操作需要二次确认。
    - 队列暂停、恢复、取消、停止、移动都写 `OperationLog`，包含操作者、job_id、动作、原因和结果。
    - 不第一版新增 `/admin/h3-queue` 独立页。
  - 验证：新增 `scripts/h3-admin-queue-smoke.ts`，覆盖普通用户拒绝、管理员可读、暂停/恢复/取消/停止/move 或暂不支持提示、队列操作审计。
  - 2026-08-15 加固：队列后端也必须等 H3 健康检查通过才允许读取或执行队列操作，不能只靠前端按钮禁用。

- [x] T10. 成本、点数和审计规则收口
  - 修改：`src/lib/pricing.ts` 或现有 pricing 配置文件。
  - 修改：`src/lib/costs/ledger.ts` 如需新增 provider 标识。
  - 内容：
    - H3 本地算力没有官方账单时，不伪造官方成本。
    - H3 本地模型是免费链路，内部点数规则必须返回 0，不冻结、不扣除用户点数，也不预占项目预算。
    - ProviderApiRequest、CostLedger、OperationLog 都记录 `provider='h3'`、preset、job_id、外部请求 ID。
    - 失败、取消、队列满、H3 创建失败、输出下载失败时，明确 0 成本结算规则，不进入点数或项目预算释放路径。
    - H3 任务成功、失败或取消都要有 CostLedger 终态记录；失败事件需要能区分 `provider_request_failed`、`job_failed`、`job_cancelled`、`output_download_failed`。
  - 验证：新增 `scripts/h3-cost-ledger-smoke.ts`，确认没有把 H3 成本错记成 Seedance，并覆盖失败、取消、队列满、下载失败的扣费/退款规则。
  - 2026-08-15 加固：`CostLedger.event_type` 区分 `provider_request_failed`、`job_failed`、`job_cancelled`、`output_download_failed`，审计汇总把这些事件视为 H3 终态成本记录。
  - 2026-08-15 免费修正：`calculateH3EstimatedCost` 返回 `estimatedCost=0`、`baseCostPerSecond=0`、`formula=free_local_h3 = 0`；创建任务只有 `estimatedCost > 0` 才冻结用户点数或项目预算；0 成本失败和成功都写 `actual_cost=0` / `refund_amount=0` 并记录 CostLedger，不创建 `task_freeze`、`task_success_deduct` 或项目预算扣减流水。

- [x] T11. 无成本集成验证
  - 命令：
    - `npx tsx scripts/h3-admin-settings-smoke.ts`
    - `npx tsx scripts/h3-provider-adapter-smoke.ts`
    - `npx tsx scripts/h3-reference-image-handoff-smoke.ts`
    - `npx tsx scripts/h3-create-route-smoke.ts`
    - `npx tsx scripts/h3-finalizer-output-smoke.ts`
    - `npx tsx scripts/h3-generate-ui-smoke.ts`
    - `npx tsx scripts/provider-status-router-smoke.ts`
    - `npm run lint`
    - `npm run build`
  - 完成标准：不真实调用 H3 生成，也能证明选择值穿透 UI、API、provider payload、任务记录、状态映射和缓存路径。
  - 本轮证据：H3 全量 smoke、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`git diff --check` 均通过；H3 免费修正后的 smoke 已断言 0 成本和跳过冻结路径。未发起真实 H3 生成，因为当前本机和生产服务器均无 H3 gateway 可用。

- [x] T14. 审查阻塞修复
  - 来源：独立只读审查发现第一轮实现存在 5 个阻塞风险。
  - 已修复：
    - H3 `done` 无输出不再算成功。
    - H3 内部输出地址不再进入前端播放链路。
    - H3 `Retry-After` 进入轮询等待。
    - H3 普通用户入口改为健康检查通过后开放。
    - H3 失败成本事件细分并进入后台审计终态事件清单。
  - 验证：`scripts/h3-admin-settings-smoke.ts`、`scripts/h3-provider-adapter-smoke.ts`、`scripts/h3-finalizer-output-smoke.ts`、`scripts/h3-cost-ledger-smoke.ts` 已补直接断言。

- [ ] T12. 真实 H3 连接验证
  - 前提：用户明确授权使用 H3 本地算力。
  - 命令：
    - `curl -sS -D - <H3_PUBLIC_BASE_URL>/health -o /tmp/h3-health.json`
    - 通过后台「测试连接」读取 health/presets。
    - 提交 1 个短视频 H3 测试任务。
    - 再提交 1 个带首帧/尾帧图片的短视频 H3 测试任务。
    - 验证 `/tasks/<id>`、项目产出、后台产出、缩略图、下载链接。
  - 完成标准：真实页面能看到 H3 生成结果；纯文本任务和带首尾帧任务都能刷新后仍存在，下载稳定可用。
  - 2026-08-15 阻塞状态：用户已授权使用 H3 本地算力并要求多跑几个视频，但当前没有可访问的 H3 gateway。已验证 `http://127.0.0.1:8893/health` 在本机和生产服务器均连接失败，生产库没有 H3 配置记录，生产 systemd 环境没有 H3 token。需要先启动/提供 H3 API gateway 地址和 token，或把 gateway 反代到生产服务器可访问地址后，才能提交真实 H3 任务。

- [ ] T13. 服务器部署闭环
  - 按 `AGENTS.md` 的 sd2 服务器生产托管规则执行。
  - 目标生产入口：`https://sd2.youdooart.com`。
  - 验证：
    - `ssh gouki@42.193.221.253 'systemctl is-active sd2-gray.service'`
    - `ssh gouki@42.193.221.253 'cd /srv/video-api-debugger/app && cat .next-prod/BUILD_ID'`
    - `curl -sS -D - https://sd2.youdooart.com/api/config -o /tmp/sd2-public-config.json`
    - 真实登录页或目标页面 DOM 能看到 H3 入口。
  - 停止条件：生产构建不含 H3 字符串、公网仍旧版本、登录跳回旧域名、H3 地址服务器不可达。
  - 2026-08-15 部署状态：服务器候选构建 `.next-prod-candidate` 通过并切换为 `.next-prod`，`sd2-gray.service` 已重启且 active；最新生产构建 `.next-prod/BUILD_ID=hst2W9Gd0VOvmI38cWZ5V`，上一版为 `MzJDtlooa5o9BVHG6aJe1`。本机 `127.0.0.1:3302/api/config` 和公网 `https://sd2.youdooart.com/api/config` 均返回 H3 safe DTO；公网响应头含 `X-SD2-Origin: server-42-193`；公网 `_next/static/chunks/8953-968081530b4b369a.js` 返回 200 且包含 `H3 本地工作站` / `H3 健康检查未通过`；服务器编译产物确认包含 `free_local_h3 = 0`、`baseCostPerSecond:0` 和 `pricingRuleVersion:2`。由于 `/generate` 匿名访问 307 到登录页，本轮还未拿到真实登录态 DOM/截图，因此 T13 保持未勾选。

## 4. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [ ] R1. 后台配置审查
  - 检查对象：`src/lib/integrations/h3.ts`、`src/app/api/admin/integrations/h3/route.ts`、后台集成页。
  - 通过标准：token 不泄漏、管理员权限生效、health/presets 可测、操作有日志。
  - 证据来源：smoke 输出、代码检查、接口返回。

- [ ] R2. 生成链路审查
  - 检查对象：`/generate`、`src/app/api/tasks/create/route.ts`、`VideoTask` 记录、ProviderApiRequest。
  - 通过标准：选择 H3 后 provider/model/job_id/payload 都正确；Seedance 默认链路不回归。
  - 证据来源：mock create route smoke、任务记录、provider payload。

- [ ] R3. 素材转交审查
  - 检查对象：H3 图片上传 helper、任务创建入参、provider_payload_json。
  - 通过标准：首帧/尾帧真实转成 H3 filename；视频/音频不被假传；多余参考图处理有明确提示；任何由图片推导出的文字上下文都在最终上下文/最终提示词里可见。
  - 证据来源：h3-reference-image-handoff smoke、payload 快照。

- [ ] R4. 结果缓存审查
  - 检查对象：H3 状态映射、输出下载、本地缓存、缩略图、稳定下载 URL。
  - 通过标准：H3 token 不暴露给前端；完成任务可播放、可下载、可刷新复现；轮询按 3-5 秒、终态停止、`Retry-After` 退避和超时恢复规则执行。
  - 证据来源：h3-finalizer-output smoke、真实或 mock 任务详情。

- [ ] R5. 成本与审计审查
  - 检查对象：pricing、CostLedger、ProviderApiRequest、OperationLog。
  - 通过标准：H3 不被记成 Seedance 官方成本；未知成本明确标记；创建失败、队列满、任务失败、取消、下载失败都有扣费/退款/释放规则；关键动作有审计。
  - 证据来源：h3-cost-ledger smoke、数据库记录只读检查。

- [ ] R6. 线上可见审查
  - 检查对象：`https://sd2.youdooart.com/generate`、`/admin/integrations`、生产构建 ID。
  - 通过标准：目标页面刷新后可见 H3 入口或后台配置；公网静态资源和 DOM 来自新构建。
  - 证据来源：服务器 BUILD_ID、公网 API、真实登录态 DOM/截图。

- [ ] R7. H3 参数与服务准入审查
  - 检查对象：H3 参数白名单、后台 health/presets、服务器到 H3 公网域名、worker/comfyui 健康、队列保护。
  - 通过标准：preset、比例、时长、seed、width/height 开放范围都受控；只有 `api=ok + worker=ok + comfyui=ok + 队列保护启用 + sd2 服务器可达` 才对普通用户开放 H3。
  - 证据来源：h3-provider-adapter smoke、后台测试连接、服务器 curl、队列状态只读查询。

- [ ] R8. H3 队列操作审查
  - 检查对象：后台队列折叠区、H3 admin routes、OperationLog。
  - 通过标准：暂停、恢复、取消、停止、移动或暂不支持移动的提示都清晰；所有队列写操作只允许管理员后端触发并记录审计。
  - 证据来源：h3-admin-queue smoke、权限测试、OperationLog 只读检查。

## 5. 审查内容是否对齐目标

- [ ] A1. R1 是否证明“后台可配置且安全”
  - 判断：不能只看 UI 表单出现，必须证明 token 不泄漏、权限和测试连接有效。

- [ ] A2. R2 是否证明“H3 是现有生成引擎，不是孤立系统”
  - 判断：必须检查 `VideoTask`、任务列表、项目产出和 provider payload，不只看生成页按钮。

- [ ] A3. R3 是否覆盖用户关心的参考图/视频/音频处理
  - 判断：必须明确哪些文件传给 H3，哪些只作为上下文，避免隐藏行为。

- [ ] A4. R4 是否覆盖最终用户结果
  - 判断：必须证明视频可播放、可下载、刷新后仍存在，不能只证明 H3 job done。

- [ ] A5. R5 是否覆盖成本和审计风险
  - 判断：必须防止 H3 成本混到 Seedance，并能复盘谁生成、用什么 preset、什么素材。

- [ ] A6. R6 是否覆盖生产闭环
  - 判断：必须以 `sd2.youdooart.com` 和服务器 `.next-prod` 为准，不能用本地构建或旧域名冒充上线。

- [ ] A7. R7 是否覆盖 H3 专属服务风险
  - 判断：必须证明 H3 参数、H3 公网入口、worker、ComfyUI 和队列保护都满足准入条件。

- [ ] A8. R8 是否覆盖 H3 队列管理风险
  - 判断：必须证明队列操作权限、审计和是否支持 move 都说清楚，不留下半成品后台按钮。
