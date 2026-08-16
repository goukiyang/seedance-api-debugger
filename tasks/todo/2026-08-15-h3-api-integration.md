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
  - 本轮状态：已按 H3 guide 完成代码接入参数和安全边界；普通用户 H3 入口现在必须等后台测试连接写入 `api=ok + worker=ok + comfyui=ok` 后才开放。2026-08-15 复查确认生产库没有 `h3_video_api_v1` 配置记录，生产服务器 `H3_*TOKEN` 未配置，服务器和本机 `127.0.0.1:8893` 都没有 H3 gateway 监听；本机 `8793` 是 media-link 服务，不是 H3。2026-08-15 H3 侧提供临时公网地址 `https://wherever-globe-lie-broadcast.trycloudflare.com` 后，本地只读验证 `GET /health` 返回 `api=ok`、`worker=ok`、`comfyui=ok`、`queue.pending=0`、`billing.charged=false`、`billing.cost=0`；sd2 来源 CORS 预检允许 `https://sd2.youdooart.com` 和 `Idempotency-Key`。仍缺安全渠道交付 `H3_API_TOKEN` / `H3_ADMIN_TOKEN`、生产固定域名和 sd2 服务器侧配置验证。

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
  - 2026-08-15 联调补充：健康快照新增保留 `version`、`public_base_url`、`default_preset`、`billing`、`queue`，连接测试 OperationLog 只记录安全摘要，不记录 token。

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
  - 2026-08-15 联调补充：`createH3VideoJob` 支持 `Idempotency-Key` 请求头；输出类型承接 `content_type`、`size_bytes`、`duration_sec`、`width`、`height`、`fps`、`sha256`；图片上传类型承接 `width`、`height`、`mime_type`。

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
  - 2026-08-15 联调补充：H3 提交时使用 `sourceRequestId || idempotencyKey || taskId` 作为外部 `Idempotency-Key`，并同步记录到 ProviderApiRequest，避免外网重试生成重复 H3 job。

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
  - 本轮证据：H3 全量 smoke、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`git diff --check` 均通过；H3 免费修正后的 smoke 已断言 0 成本和跳过冻结路径。未发起真实 H3 生成，因为当前本机和生产服务器均无 H3 gateway 可用。2026-08-15 临时公网联调补充后，`npx tsx scripts/h3-provider-adapter-smoke.ts`、`npx tsx scripts/h3-admin-settings-smoke.ts`、`npx tsx scripts/h3-create-route-smoke.ts`、`npx tsx scripts/h3-reference-image-handoff-smoke.ts`、`npx tsc --noEmit --pretty false`、`git diff --check` 通过。

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
  - 2026-08-15 阻塞状态：用户已授权使用 H3 本地算力并要求多跑几个视频，但当前没有可公开使用的 token。已验证 `http://127.0.0.1:8893/health` 在本机和生产服务器均连接失败，生产库没有 H3 配置记录，生产 systemd 环境没有 H3 token。H3 临时公网 `GET /health` 和 sd2 CORS 预检已通过；`GET /api/h3/presets`、`POST /api/h3/generate`、轮询和 mp4 下载仍需通过安全渠道配置 `H3_API_TOKEN` 后才能从 sd2 执行。

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
  - 2026-08-15 外网联调适配部署状态：本轮代码提交 `1b40e7639520` 已通过 `git archive` 上传到服务器 release `/srv/video-api-debugger/releases/1b40e7639520`，候选构建 `.next-prod-candidate` 通过并命中 `Idempotency-Key` / `billing_charged`，切换后生产 `.next-prod/BUILD_ID=gtez3xmdBRlBws_jVp8tA`，上一版为 `hst2W9Gd0VOvmI38cWZ5V`，`sd2-gray.service` active。服务器本机 `/api/config` 返回 200；公网 `https://sd2.youdooart.com/api/config` 返回 200 且含 `X-SD2-Origin: server-42-193`，H3 safe DTO 因未配置 token 仍为 `enabled=false` / `configured=false`；公网 `https://sd2.youdooart.com/api/health` 返回 200；公网 H3 静态 chunk `/_next/static/chunks/8953-968081530b4b369a.js` 返回 200 且包含 `H3 本地工作站` / `H3 健康检查未通过`。H3 临时公网 `GET /health` 和 sd2 CORS 预检仍通过；真实 `presets/generate/poll/download` 仍需安全配置 H3 token 后执行。

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

## 6. H3 前端状态机轻量展示规划

### 6.1 大白话目标复述

用户在普通生成页或模板生成页选择「H3 本地工作站」时，旁边要立刻看到这台 H3 API 机器当前能不能用、忙不忙、是不是免费、缺什么配置。这个提示只做成小状态块，不新建监控后台，不展示 token、内部公网地址、服务器目录或复杂日志。做到用户不用猜“点了会不会失败”，管理员也能快速知道该去哪里修。

### 6.2 设计原则

- 入口位置：放在「生成引擎 / H3 本地工作站」chip 旁边，或底部操作栏里紧贴模型选择区域；不要放到页面右侧大面板，避免挤占提示词和素材区。
- 展示重量：默认只显示一行小状态，不超过 3 个灯点 + 1 个短文案；详细解释只放 hover tooltip 或点击后的轻量 popover。
- 可见范围：普通用户只看业务可理解状态；管理员可多看配置缺口、队列数字和最近检查时间。
- 安全边界：前端永远不显示 token、admin token、内部 worker URL、服务器路径、ComfyUI 本机地址或原始错误堆栈。
- 状态来源：优先使用 `/api/config` 返回的 `h3_video.health`、`ready`、`configured`、`api_token_configured`、`admin_queue_ready`；不要前端直接打 H3 公网 API。
- 刷新节奏：进入页面读取一次；选择 H3 时触发一次轻量刷新；不要高频轮询。队列数字如果后端已有安全 DTO，再按 30-60 秒节流刷新。

### 6.3 状态灯设计

- 总状态灯：
  - 绿灯 `可用`：`ready=true`，`api=ok`、`worker=ok`、`comfyui=ok`。
  - 黄灯 `待检查`：已配置但没有健康快照，或健康快照过旧。
  - 黄灯 `繁忙`：机器健康，但 `queue.pending + queue.running > 0` 或 pending 接近上限。
  - 红灯 `不可用`：未启用、未配置 token、健康检查失败、worker/ComfyUI 异常。
  - 灰灯 `未配置`：管理员可见；普通用户不展示 H3 入口或仅展示不可选原因。
- 子状态灯：
  - `API`：H3 gateway 是否 ok。
  - `队列`：空闲、繁忙、满载。
  - `计费`：免费、本地免费异常、未知。
- 文案示例：
  - 绿灯：`H3 可用 · 免费 · 队列空闲`
  - 黄灯：`H3 可用 · 队列中 2 个任务`
  - 红灯：`H3 暂不可用`
  - 灰灯：`H3 未配置`

### 6.4 Tooltip / Popover 内容

- 普通用户 hover：
  - `H3 本地工作站当前可用，本地模型不扣点。`
  - `H3 队列正在处理任务，提交后可能需要等待。`
  - `H3 暂不可用，请改用 Seedance。`
- 管理员 hover：
  - 显示 `api / worker / comfyui / queue / billing` 的短状态。
  - 显示 `最近检查时间`。
  - 显示缺口，例如 `缺少 H3_API_TOKEN`、`未测试连接`、`worker 异常`。
  - 提供小链接 `去 API 设置`，指向 `/admin/integrations`。
- 不展示内容：token、内部 worker URL、原始异常、Cloudflare 临时 URL、服务器路径。

### 6.5 具体可执行任务

- [x] T15. 扩展 H3 safe DTO 前端可用字段
  - 修改：`src/app/api/config/route.ts`、`src/lib/integrations/h3.ts`。
  - 内容：确认 safe DTO 能返回 `health.version`、`health.checked_at`、`health.billing`、`health.queue`，并继续不返回 token。
  - 验证：扩展 `scripts/h3-admin-settings-smoke.ts`，断言 public config 含状态摘要、不含 token 明文。
  - 2026-08-15 状态：已把 `health.version`、`health.billing`、`health.queue` 加入 `/api/config` 的安全 DTO；继续不透出 `worker_url`、`public_base_url`、token；H3 地址只返回 `base_url_configured`，普通公开配置不再暴露具体机器地址。

- [x] T16. 增加轻量状态数据归一化 helper
  - 修改：`src/components/generate/GeneratePageClient.tsx`、`src/components/templates/TemplateGenerateClient.tsx`，或抽到 `src/components/H3MachineStatus.tsx`。
  - 内容：把 `h3_video` 转成统一状态：`available`、`busy`、`not_checked`、`unavailable`、`not_configured`。
  - 完成标准：普通生成页和模板生成页复用同一套状态判断，避免两处逻辑分叉。
  - 2026-08-15 状态：新增 `src/components/H3MachineStatus.ts`，统一归一化 H3 配置并输出 `未配置 / 待检查 / 暂不可用 / 可用 / 队列繁忙 / 队列满 / 免费计费` 状态；健康快照超过 15 分钟时自动转为待检查，避免旧快照继续绿灯。

- [x] T17. 在 `ComposerActionBar` 增加可选 H3 状态块
  - 修改：`src/components/ComposerActionBar.tsx`、`src/app/globals.css`。
  - 内容：新增可选 prop，例如 `providerStatus`；只有当前选择 H3 或管理员看到 H3 禁用项时显示。
  - 展示：最多 3 个小圆点 + 一行短文案；hover 使用原生 `title` 或现有 tooltip 样式，第一版不做复杂 popover。
  - 布局：桌面放在生成引擎 chip 和模型 chip 后；窄屏放到参数折叠 summary 内或 chips 下一行，不挤压提交按钮。
  - 2026-08-15 状态：`ComposerActionBar` 已支持 `providerStatus`，展示最多三枚灯点、一句短状态、原生 hover 提示；折叠参数摘要也显示短状态。

- [x] T18. 普通生成页接入状态块
  - 修改：`src/components/generate/GeneratePageClient.tsx`。
  - 内容：选择 H3 时显示 `H3 可用 / 繁忙 / 暂不可用 / 未配置`；未配置时管理员看到原因和 `/admin/integrations` 引导，普通用户不被迫理解配置。
  - 验证：扩展 `scripts/h3-generate-ui-smoke.ts`，检查普通生成页有 H3 状态 prop 和管理员禁用原因。
  - 2026-08-15 状态：普通生成页已用 `buildH3MachineStatus` 生成状态，并传入 `GenerationComposer`；选择 H3 时会轻量刷新 `/api/config`。

- [x] T19. 模板生成页接入状态块
  - 修改：`src/components/templates/TemplateGenerateClient.tsx`。
  - 内容：与普通生成页一致，模板生成选择 H3 时显示同样状态，避免模板页漏状态。
  - 验证：扩展 `scripts/h3-generate-ui-smoke.ts`，检查模板页复用 H3 状态展示。
  - 2026-08-15 状态：模板生成页已复用同一套 H3 状态 helper，并在折叠参数摘要和展开内容中显示状态。

- [x] T20. 状态样式和移动端约束
  - 修改：`src/app/globals.css`。
  - 内容：灯点大小固定 6-8px；状态块不超过一行，长文案截断；hover/focus 有可访问提示；390px 宽度下不顶开提交按钮。
  - 验证：新增或扩展 UI smoke，检查类名、短文案、无横向溢出风险；上线后补真实截图。
  - 2026-08-15 状态：已新增 `composer-provider-status*` 样式，灯点尺寸固定、文案截断、折叠摘要短状态限制宽度；上线后仍需真实登录态截图确认。

### 6.6 验收 / 审查内容

- [ ] R9. H3 前端状态展示审查
  - 审查方式：需要创建独立只读审查 agent；如果工具不可用，由主线程按同一清单只读复查，不能改文件，该结果不是独立审查，可信度低于子 agent。
  - 检查对象：`/generate`、`/template-generate`、`ComposerActionBar`、`/api/config` safe DTO、H3 状态样式。
  - 通过标准：选择 H3 后能看到轻量状态；状态含 API、队列、免费计费的基础摘要；hover 文案能解释原因；普通用户不看到内部技术细节；管理员能知道去哪里处理配置；移动端不挤压提交按钮；Seedance 默认流程不受影响。
  - 证据来源：`h3-generate-ui-smoke`、`h3-admin-settings-smoke`、`npm run lint`、`npm run build`、公网或登录态截图。

### 6.7 审查内容是否对齐目标

- [ ] A9. R9 是否证明“轻量但够用”
  - 判断：不能变成监控后台；不能只显示一个没解释的红点；必须在用户选择 H3 的同一处告诉用户能不能用、是否排队、是否免费和失败该怎么办。

## 7. H3 真实压测后下一步收口计划

### 7.1 大白话目标复述

这轮真实压测已经证明：sd2 侧能把 H3 配置、状态机、队列提交和免费计费串起来，但 H3 机器侧还没有稳定产出 mp4。下一步不是继续堆新入口，而是先把会污染生成结果的参考图串台修掉，再把 H3 失败原因做成可复现、可交接、可验收的问题闭环。做到普通用户选择 H3 时不会被隐藏上下文误导，管理员能看到机器是否可用，H3 修好后能立刻重新跑通 15 秒 720P 多题材视频。

### 7.2 最短闭环原则

- 先修影响最终提示词/参考图的确定性 bug，再继续大批量生成测试。
- 不新增独立 H3 监控大后台；第一版只保留现有轻量状态机、后台集成页和任务详情证据。
- 不把 H3 worker failed 包装成 sd2 成功；没有 mp4 下载和播放就不能标记生成链路已通。
- 不展示或记录 token 明文；所有交接包只保留脱敏配置、job id、preset、状态、错误码和时间线。

### 7.3 具体可执行任务

- [x] T21. 修复 workspace 串台导致旧参考图自动注入
  - 检查对象：`src/lib/workspace*`、任务创建入口、生成页 tab/workspace 选择逻辑、`getOrCreateWorkspace(tabId, ownerId)` 实际实现。
  - 要修什么：workspace 必须按当前用户和当前 tab/workspace 隔离；没有用户明确选择的参考图时，H3/Seedance 任务不得自动带入 active workspace 里的旧素材。
  - 完成标准：新建空白生成会话后提交 H3，`reference_image_urls=null`，prompt 不出现旧 `参考素材说明`；用户手动选图时才出现对应资产。
  - 补充核对：只读检查 `VideoTask.reference_image_ids`、`provider_payload_json.h3_payload`、`final_prompt_snapshot`、任务快照和 OperationLog，确认空白会话没有旧参考图、旧素材说明或隐藏上下文。
  - 验证命令：新增或扩展 workspace/H3 创建 smoke，至少覆盖“空白会话不带图”“手动选图才带图”“不同 tab 不串图”“任务快照和 provider payload 不带旧图”。
  - 2026-08-16 状态：已改为按 `owner_id + status + tab workspace name` 查找 workspace，不再复用同用户最近 active workspace；新增 `scripts/workspace-tab-isolation-smoke.ts`，验证同 tab 复用、不同 tab 隔离、旧默认 active workspace 不被复用。

- [x] T22. 给 H3 失败链路补脱敏诊断包
  - 检查对象：`ProviderApiRequest`、`VideoTask.provider_payload_json`、H3 finalizer、后台任务详情或管理员可复制诊断摘要。
  - 要修什么：记录每个 H3 任务的 `preset_id`、`duration_sec`、`aspect_ratio`、`job_id`、sd2 task id、外部 request id、终态、H3 原始错误摘要、队列快照、是否 0 成本、是否有输出文件；不得记录 token。
  - 诊断包字段：必须包含轮询时间线、每次 HTTP status、`Retry-After`、health 快照、queue 提交前后快照、`/outputs` 摘要、worker/comfyui 状态或版本摘要。
  - 脱敏边界：不得包含 token、Authorization、cookie、原始请求头、内部 worker URL、内部 base_url 明文或服务器本机路径。
  - 完成标准：H3 failed / cancelled / running 卡住时，管理员能一键复制给 H3 侧排查，不需要从数据库里手挖。
  - 验证命令：新增 smoke 覆盖失败诊断摘要不含敏感字段、含 job id/preset/status/error/billing/health/queue/outputs/Retry-After。
  - 2026-08-16 状态：新增 `src/lib/provider/h3-diagnostics.ts`，H3 创建失败和状态轮询都会写入 `h3_diagnostic` 脱敏摘要；新增 `scripts/h3-diagnostics-smoke.ts` 验证 token、Authorization、cookie、base_url、worker URL 不外泄。
  - 2026-08-16 审查修正：补齐 finalizer 轮询异常路径 `status_poll_failed` 的 `h3_diagnostic`；诊断中的普通字符串值也会脱敏 Bearer token、URL、IP:端口和长 hex token。

- [ ] T23. 重新跑 H3 机器侧最小隔离测试
  - 检查对象：H3 `/health`、`/api/h3/presets`、`/api/h3/generate`、`/api/h3/jobs/{job_id}`、`/outputs`。
  - 测试顺序：先 5 秒 `lightx2v_4step_turbo` 纯文本；再 5 秒 `larry_v4_6step`；能出 mp4 后再上 15 秒 720P 多题材。
  - 完成标准：至少一个直接 H3 任务 `done` 且 outputs 含 `kind=video`、mp4 可下载播放、`billing.charged=false`。
  - 停止条件：如果 5 秒 turbo 仍卡 `running 0.5` 或 preset 仍 failed，停止批量测试，生成脱敏交接包给 H3 侧，不继续占队列。
  - 2026-08-16 阻塞状态：已新增 `scripts/h3-live-minimal-smoke.ts`，本地运行确认当前本地 DB/环境没有 H3 token；生产环境部署时 SSH 到 `gouki@42.193.221.253` 被 publickey 拒绝，无法上传本轮版本、无法在服务器生产配置环境执行 live smoke。该阻塞不是 H3 API 生成失败，需先恢复服务器 SSH 凭据或提供可用部署通道。

- [ ] T24. 重新跑 sd2 侧 15 秒 720P 多题材 H3 压测
  - 检查对象：`/api/codex/video/create`、任务轮询、finalizer、本地缓存、项目产出、任务列表、下载播放。
  - 测试题材：赛车、舞蹈、武打、二次元；preset 至少覆盖 `larry_v4_8step` 和 `larry_v4_6step`，可加 `lightx2v_4step_turbo` 快速预览。
  - 完成标准：每条任务创建成功、轮询到终态、成功任务有 mp4、可播放可下载、任务落在指定项目/视频卡、0 成本、无 CreditLedger 扣点。
  - 免费计费分支：分别验证 H3 创建失败、队列满、job failed、cancelled、输出下载失败和 succeeded，均不产生 `task_freeze`、`task_success_deduct` 或项目预算扣减；`CostLedger` 必须有对应终态事件。
  - 幂等和并发：验证重复点击、同一外部 request id、同一 `Idempotency-Key` 不重复生成 H3 job；队列满时不创建脏任务、不占用用户点数。
  - 停止条件：任一 preset 连续 2 次同类 failed 或卡住，先做故障归因，不继续盲提更多任务。

- [ ] T25. 补真实页面状态机与免费计费验收
  - 检查对象：`https://sd2.youdooart.com/generate`、模板生成页、后台集成页、任务详情/项目产出页。
  - 要确认：选择 H3 时能看到轻量状态灯；hover 能说明 API/队列/免费；队列繁忙或不可用时不误导用户；生成后任务列表能看出 H3 免费且不扣点。
  - 任务状态验收：真实页面和数据库同时核对 submitted、running、succeeded、failed、cancelled、队列满、不可用、下载失败；刷新后任务详情、项目产出、后台产出和任务列表显示一致。
  - 输出验收：成功任务必须有本地缓存文件、缩略图 URL、播放接口、稳定下载接口；刷新后仍可播放、可下载、可看到缩略图。
  - 完成标准：真实登录态刷新页面可见；桌面和窄屏不挤压按钮；状态不暴露 token、公网机器地址、内部 worker URL、内部 base_url 或原始错误堆栈。
  - 验证方式：真实浏览器 DOM/截图 + `/api/config` 公网返回 + 数据库 `CreditLedger/CostLedger` 只读核对 + 播放/下载/缩略图接口检查。

### 7.4 验收 / 审查内容

- [ ] R10. H3 压测后收口独立只读审查
  - 审查方式：需要创建独立只读审查 agent；如果工具不可用，由主线程按同一清单只读复查，不能改文件，该结果不是独立审查，可信度低于子 agent。
  - 检查对象：T21-T25 对应代码、smoke、生产 API、真实登录态页面、H3 job 证据、CreditLedger/CostLedger。
  - 通过标准：没有隐藏参考图注入；H3 失败有可复制脱敏诊断；直接 H3 与 sd2 H3 均至少跑通一个 mp4；15 秒 720P 多题材测试结果可复盘；免费链路全终态不扣点；状态机准确显示可用/繁忙/不可用；任务详情、项目产出、后台产出、播放、下载、缩略图一致。
  - 运行回滚证据：生产必须记录公网 BUILD_ID、真实登录态截图、`.next-prod-prev` 或 rollback tag 可回退证据；公网新构建未加载、生成脏任务、扣点异常或 H3 队列无法清空时停止并回滚。
  - 证据来源：smoke 命令输出、H3 job id 与 outputs、服务器 BUILD_ID、公网 `/api/config`、真实页面截图、数据库只读查询、播放/下载/缩略图接口、回滚点。

### 7.5 审查内容是否对齐目标

- [ ] A10. R10 是否真正证明“用户可以放心用 H3”
  - 判断：不能只证明按钮出现或任务创建成功；必须证明输入没有被旧素材污染、机器能产出 mp4、状态提示可信、失败能交接、免费不扣点。

## 8. H3 SSH 恢复与生产部署闭环计划

### 8.1 大白话目标复述

现在代码侧 T21/T22 已经修好并推到 Git，但线上还没有加载新版本，因为本机到生产服务器 `gouki@42.193.221.253` 的 SSH publickey 被拒。下一步最优路径是先恢复部署通道，再把当前 commit 部署到 `sd2.youdooart.com`，随后在生产配置环境里跑 H3 5 秒最小测试。只有这样，才能证明参考图串台修复、H3 诊断、状态机、免费计费和 mp4 输出是同一条真实产品链路，不是本地或孤立 H3 测试。

### 8.2 执行顺序

- [x] T26. 恢复服务器 SSH 登录
  - 检查对象：本机 `~/.ssh/codex_gouki_42_193_221_253.pub`、服务器 `gouki` 用户的 `~/.ssh/authorized_keys`、腾讯云控制台/VNC/已有管理员通道。
  - 具体做法：把当前本机公钥重新加入服务器 `gouki` 用户 authorized_keys；或者提供新的可用部署 key；或者由有权限的人临时恢复 `gouki@42.193.221.253` SSH 登录。
  - 服务器侧校验：确认 `/home/gouki/.ssh` 属主为 `gouki`、权限为 `700`，`authorized_keys` 属主为 `gouki`、权限为 `600`，`sshd` 允许公钥登录；建议用 `sshd -T | grep -i '^pubkeyauthentication'` 或等价只读命令留证；如 SSH 不通，只能通过腾讯云控制台/VNC/既有管理员通道修复，不在聊天里传密码。
  - 验证命令：`ssh -i ~/.ssh/codex_gouki_42_193_221_253 -o BatchMode=yes gouki@42.193.221.253 'echo ok'`。
  - 完成标准：返回 `ok`；不得要求或暴露服务器密码、token、cookie。
  - 停止条件：仍然 `Permission denied (publickey)` 时不继续部署、不绕过到服务器 `.git pull`、不改生产文件。
  - 2026-08-16 落地结果：`gouki` 登录最初仍被 `Permission denied (publickey)` 拒绝；已通过可用 root 通道只修复 `gouki` 的 `authorized_keys`、目录属主和权限，验证 `/home/gouki/.ssh=700`、`authorized_keys=600`、`pubkeyauthentication yes`，随后 `gouki@42.193.221.253` 返回 `ok`。未在聊天或日志输出服务器密码、token、cookie。

- [x] T27. 部署当前 Git 版本到服务器候选构建
  - 部署目标确认方式：执行部署前必须重新读取 `git rev-parse HEAD` 和 `git ls-remote --heads origin codex/video-delivery-fast-path`，两者一致后才把该 HEAD 作为部署目标写入执行回执；不要从本节复制历史提交号作为固定目标。
  - 代码变更基线：T21/T22 代码到 `ae3b86e5808ed009dd45089495bcd000deccb1d3`；后续闭环计划修正也必须随最新远端 HEAD 一起部署，避免漏掉计划、脚本和审查记录。
  - 当前 rollback tag：`rollback/2026-08-16-before-h3-workspace-diagnostics`，指向 `88797a164291f6bcd594c3f9282c956ce6b35d79`。
  - 具体做法：本地 `git archive` 当前 commit，上传到服务器 `/tmp`，解压到 `/srv/video-api-debugger/releases/<commit>`，用 `rsync -a --delete` 同步到 `/srv/video-api-debugger/app`。
  - 排除项：必须排除 `.env`、`node_modules`、`.next`、`.next-prod*`、`storage`、`public/uploads`、`prisma/dev.db*`，避免覆盖生产密钥、上传素材、视频文件和数据库。
  - 同步预检：正式 `rsync --delete` 前先跑 `rsync --dry-run` 或等价预览，记录不会删除/覆盖 `.env`、`storage`、`public/uploads`、`prisma/dev.db*`、`.next-prod*`；预览不清楚时停止。
  - 验证命令：服务器 `NEXT_DIST_DIR=.next-prod-candidate npm run build`。
  - 完成标准：候选构建成功，且构建产物包含本轮 H3 workspace/diagnostic 变更。
  - 停止条件：执行部署前如果远端 HEAD 已变化，必须重新确认目标 commit 和 rollback tag；候选构建失败、构建产物不含本轮变更、或排除项无法确认时，不切换 `.next-prod`。
  - 2026-08-16 落地结果：首次部署本地 HEAD 与远端均为 `0867ceda844a600b5da380e414dd5231b41df824`；记录联调结果后，又按“部署前动态确认 HEAD”规则部署到 `f62f9b2cc86f0e5c0e3ae47620a208c402548fad`。该次归档 `/tmp/sd2-f62f9b2cc86f-20260816122123.tar`，SHA256 `5299935927f4933d588de813077b81e3c9e4a48dbd7d514f3fab2fbd9cce7a51`，release `/srv/video-api-debugger/releases/f62f9b2cc86f-20260816122123`。首次 `rsync --dry-run` 发现 `.next-prod-prev.*` 历史回滚目录会被删除，已停止并改用 `.next-prod*` 通配排除；复跑后风险删除/变更计数为 0，未触碰 `.env`、`storage`、`public/uploads`、`prisma/dev.db*`、`.next-prod*`。该次候选构建 `.next-prod-candidate-f62f9b2cc86f` 通过，构建产物命中 `H3 本地工作站`、`h3_diagnostic`。后续因记录或安全修正产生的新提交，仍按同一流程用现场 HEAD 重新归档、dry-run、同步、候选构建和切换；最终以执行回执中的 HEAD、归档 SHA256、release 和 BUILD_ID 为准，不复制本段历史提交号当目标。

- [x] T28. 切换生产构建并验证公网新版本
  - 具体做法：保留上一版 `.next-prod-prev`，把 `.next-prod-candidate` 切到 `.next-prod`，重启 `sd2-gray.service`。
  - 验证命令：`systemctl is-active sd2-gray.service`、读取 `/srv/video-api-debugger/app/.next-prod/BUILD_ID`、公网 `https://sd2.youdooart.com/api/config`、公网 `/login`、公网 `_next/static` 目标 chunk 或真实登录态 DOM。
  - 完成标准：服务 active，公网响应含服务器来源标记，BUILD_ID 更新，公网页面/API 不是旧构建，页面能看到 H3 状态机或 H3 诊断相关新文案。
  - 回滚条件：服务重启失败、公网仍旧版本、`/api/config` 失败、登录页不可达，立即恢复 `.next-prod-prev` 并停止。
  - 2026-08-16 落地结果：已保留上一版 `.next-prod-prev` 和更早 `.next-prod-prev.*` 回滚目录，每次候选切换后 `sd2-gray.service` 均重启 active。服务器本机 `/api/config` 200，公网 `https://sd2.youdooart.com/api/config` 200 且含 `X-SD2-Origin: server-42-193`，公网 `/login` 200；公网静态 chunk `/_next/static/chunks/9338-b30f7994d4c7ac6f.js` 200，并命中 `H3 本地工作站`、`H3 健康检查未通过`。最终生产 BUILD_ID 以收尾回执的服务器和公网实测为准。

- [ ] T29. 在生产配置环境跑 H3 5 秒最小 live smoke
  - 检查对象：`scripts/h3-live-minimal-smoke.ts`、生产 `PlatformSetting` 里的 H3 配置、H3 `/health`、`/api/h3/presets`、`/api/h3/generate`、`/jobs/{id}`、`/outputs`。
  - 测试顺序：先 `lightx2v_4step_turbo`，5 秒，16:9，纯文本；成功后再 `larry_v4_6step`，5 秒。
  - 完成标准：至少一个任务 `done`，outputs 至少有一个 `kind=video`，mp4 可下载，`billing.charged=false`、`cost=0`；sd2 侧 `VideoTask` 终态正确，`CostLedger.actual_cost=0`，不产生 `CreditLedger` 扣点、冻结或项目预算扣减。
  - 免费分支补测：至少用 mock/smoke 覆盖 `queue_full`、`job_failed`、`job_cancelled`、`output_download_failed`，确认这些失败终态同样不产生扣点、冻结或预算扣减，且 `CostLedger` 记录 0 成本终态。
  - 队列清理：测试结束后只读确认 H3 `/api/h3/queue` 没有本轮遗留 `pending/running` 任务；如脚本停止了 job，必须确认任务终态是 `cancelled/deleted/failed` 之一且有脱敏诊断。
  - 临时 tunnel 风险：H3 当前公网地址是 Cloudflare Quick Tunnel，只能作为联调入口；如 `/health` 不稳定、返回 530/502、CORS 失败或 public base URL 变化，停止 live smoke，不把临时地址当生产完成。
  - 停止条件：H3 API 0.3.1 之后不得再把 `progress=0.5` 当作卡死依据；必须读取 preset/job 的 `recommended_timeout_sec` 作为等待窗口。只有超过推荐等待仍无终态、或返回 `failed/cancelled`、或 `risk_flags` 明确高风险时，才停止当前任务并导出脱敏诊断；如发现任何扣点、冻结、预算扣减或队列无法清空，停止压测并回滚普通用户入口。
  - 2026-08-16 落地结果：已刷新生产 H3 健康快照，公网 `/api/config` 返回 `ready=true`、`admin_queue_ready=true`、`api/worker/comfyui=ok`、`billing.charged=false`、`cost=0`、队列 `pending=0/running=0`。`lightx2v_4step_turbo` 5 秒 smoke 成功，job `h3idem-be43a170c2ea57b947d3f9c5` 到 `done`，下载 mp4 `493204` 字节，`duration_sec=5`、`fps=24`、`sha256_present=true`，H3 返回免费计费。`larry_v4_6step` 5 秒 smoke job `h3idem-a8ec2714441e97bdbceabaa2` 在进度 `0.5` 卡约 99 秒，脚本已按停止条件 stop，复查终态为 `cancelled` / `stopped by operator`。队列复查 `active_count=0`、`pending_count=0`、`free_slots=1`。本轮直连 H3 smoke 不创建 sd2 `VideoTask`，生产 DB 最近一小时无 H3 `VideoTask`、无 `CreditLedger` 扣点/冻结、无 H3 `CostLedger`。sd2 登录态任务创建 E2E 尚未闭环。

- [ ] T30. 继续 sd2 侧 15 秒 720P 多题材压测
  - 前提：T29 至少一个 5 秒 H3 任务已真实产出 mp4。
  - 测试题材：赛车、舞蹈、武打、二次元；至少覆盖 `larry_v4_8step` 和 `larry_v4_6step`。
  - 完成标准：任务从 sd2 创建、轮询、终态、缓存、缩略图、播放、下载、项目产出、后台产出全链路闭环；所有任务 0 成本且无 `CreditLedger` 扣点。
  - 停止条件：任一 preset 连续 2 次 failed 或卡住，先归因并出诊断，不继续盲提任务。
  - 2026-08-16 当前状态：暂不执行批量压测。原因是 `larry_v4_6step` 5 秒最小 smoke 已触发 stale-progress stop，历史队列里也有多条 `larry_v4_8step` 15 秒 failed/cancelled 记录；继续提交赛车、舞蹈、武打、二次元 15 秒 720P 会违反“卡住先归因，不继续盲提任务”的停止条件。下一步应先把 H3 侧 6step/8step 卡 `0.5` 和 15 秒失败原因定位清楚，再恢复 T30。

- [x] T31. 适配 H3 API 0.3.1 的推荐超时、进度详情和风险标记
  - 背景：H3 侧确认旧 `progress=0.5` 是 running 占位，不是真实逐步进度；Larry 15 秒 720P 历史失败存在 `gpu_out_of_memory` 和 `long_720p_oom_risk`。
  - 具体做法：
    - `/api/config` 的 H3 `preset_options` 带上 `estimated_runtime_sec`、`recommended_timeout_sec`、`runtime_policy`，并把建议等待拼进预设说明。
    - H3 provider 状态转换保留 `progress_detail`、`recommended_timeout_sec`、`risk_flags`、`error_code` 到 `raw_status_response`；`gpu_out_of_memory` 转成用户可读显存风险提示。
    - 任务详情高级信息显示 H3 进度说明、预计耗时、建议等待、风险标记和 H3 错误码。
    - `scripts/h3-live-minimal-smoke.ts` 不再用固定 99 秒 stale-progress stop；先读 `/api/h3/presets` 的推荐超时，轮询时再用 job 返回的 `recommended_timeout_sec` 覆盖。
  - 验证：`npx tsx scripts/h3-admin-settings-smoke.ts`、`npx tsx scripts/h3-provider-adapter-smoke.ts`、`npx tsc --noEmit --pretty false`。
  - 后续限制：15 秒 720P Larry 仍不作为常规压测路径，除非 H3 侧进一步确认显存优化完成；当前推荐普通路径仍是 LightX2V 或降低分辨率/秒数。

### 8.3 验收 / 审查内容

- [ ] R11. SSH 恢复与生产部署只读审查
  - 审查方式：需要创建独立只读审查 agent；如果工具不可用，由主线程按同一清单只读复查，不能改文件，该结果不是独立审查，可信度低于子 agent。
  - 检查对象：SSH 登录证据、authorized_keys 权限、部署 release 目录、生产 BUILD_ID、`sd2-gray.service`、公网 `/api/config`、公网页面、rollback tag、`.next-prod-prev`。
  - 证据来源：SSH 命令输出、服务器权限检查输出、`rsync --dry-run` 摘要、候选构建日志、生产 BUILD_ID、公网响应头、真实登录态 DOM/截图、rollback tag 与 `.next-prod-prev` 检查。
  - 通过标准：能证明当前 commit 已上线，旧版本可回退，公网加载新构建；没有覆盖 `.env/storage/uploads/db` 等生产运行数据；部署日志、命令输出和审查记录不含 token 明文。

- [ ] R12. H3 live smoke 与免费计费只读审查
  - 审查方式：需要创建独立只读审查 agent；如果工具不可用，由主线程按同一清单只读复查。
  - 检查对象：H3 job id、outputs、下载文件、H3 queue、`VideoTask`、`ProviderApiRequest`、`CostLedger`、`CreditLedger`、任务详情/项目产出页面。
  - 证据来源：H3 job id、outputs 列表、mp4 文件大小/hash、队列前后快照、smoke 输出、数据库只读 SQL、任务详情/项目产出真实页面截图、脱敏诊断包。
  - 通过标准：至少一个 H3 mp4 真实可下载播放；失败或卡住任务有脱敏诊断；成功/失败/取消均不扣点；H3 队列无遗留任务；页面状态机和数据库状态一致；脱敏诊断不含 Authorization、cookie、token、内部 worker URL、内部 base_url 或服务器路径。

### 8.4 审查内容是否对齐目标

- [ ] A11. R11/R12 是否证明“线上用户可以用”
  - 判断：不能只证明 SSH 通、build 过或 H3 job 创建成功；必须证明 `sd2.youdooart.com` 生产页面、任务、计费、输出、回滚都闭环。
