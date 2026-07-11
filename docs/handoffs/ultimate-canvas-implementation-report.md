# 无线画布完善实施回执

日期：2026-07-11

分支：`teammate/ultimate-canvas-complete`

远端基线：`2ce4a17010a8e5867a3f405b024f555b417da565`

交付状态：本地目标分支已完成提交。最终执行 `git push origin teammate/ultimate-canvas-complete` 时，GitHub 拒绝当前身份 `K4y2025`，返回 403；完整 patch 输出到 `E:\Ultimate-canvas\ultimate-canvas-complete-final.patch`。

## 1. 本次目标理解

本次工作的主目标是增强 sd2 现有无线画布，而不是新建页面、第二套工作流或独立后端。重点是把当前画布里的生图节点和视频节点原位接到 sd2 的真实同源接口，并延续已经完成的项目、视频卡和方向规则。

- 普通登录账号可用，不把用户伪装成 admin，也不增加权限绕过。
- 保存恢复、上传、文本生成、图片生成、视频生成和状态轮询都使用 `/api/...` 同源路径。
- 生图节点提供可持久化的模式、提示词、引用图、尺寸、比例、数量和生成结果。
- 视频节点提供可持久化的模式、提示词、引用图、运镜预设、比例、分辨率、时长、音频、尾帧和水印设置。
- 图片走 `/api/assets/generate`；视频走 `/api/tasks/create`，并通过 sd2 状态接口轮询到终态。
- 节点内可见的生成控件必须真实可操作；没有后端能力的伪按钮从生成节点中移除。
- 所有模型和计费仍由 sd2 后端决定，前端不携带第三方 Key、provider 地址或固定点数规则。
- 不读取或修改 `.env`、后台 API 设置、provider 密钥配置、点数核心逻辑和数据库 schema。

部署到 `https://sd2.youdoodesign.com` 后，前端相对路径会自然连接该站点的统一后端。

## 2. 实际修改了哪些文件

### 画布前端

- `public/tools/ultimate-canvas/app.js`
- `public/tools/ultimate-canvas/canvas-engine.js`
- `public/tools/ultimate-canvas/generation-node-workflow.js`
- `public/tools/ultimate-canvas/index.html`
- `public/tools/ultimate-canvas/styles.css`
- `public/tools/ultimate-canvas/video-card-workflow.js`

### sd2 后端与共享规则

- `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`
- `src/app/api/video-cards/[id]/route.ts`
- `src/app/api/video-cards/[id]/tasks/route.ts`
- `src/app/api/video/retry/[id]/route.ts`
- `src/lib/projects/display.ts`
- `src/lib/video-cards/display.ts`

### 验证与本地预览

- `scripts/ultimate-canvas-complete-smoke.ts`
- `scripts/ultimate-canvas-context-rules-smoke.ts`
- `scripts/ultimate-canvas-generation-node-workflow-smoke.ts`
- `scripts/ultimate-canvas-normal-user-access-smoke.ts`
- `scripts/ultimate-canvas-preview-api-smoke.ts`
- `scripts/ultimate-canvas-preview-server.mjs`
- `scripts/ultimate-canvas-video-card-workflow-smoke.ts`

### 设计、计划与回执

- `docs/superpowers/specs/2026-07-11-ultimate-canvas-generation-nodes-design.md`
- `docs/superpowers/specs/2026-07-11-ultimate-canvas-video-card-in-place-design.md`
- `docs/superpowers/plans/2026-07-11-ultimate-canvas-generation-nodes.md`
- `docs/superpowers/plans/2026-07-11-ultimate-canvas-video-card-in-place.md`
- `docs/handoffs/ultimate-canvas-implementation-report.md`

## 3. 每个文件改了什么

| 文件 | 修改内容 |
| --- | --- |
| `public/tools/ultimate-canvas/app.js` | 原位接通生图和视频节点；保存模式、设置、提示词、引用、任务和结果；引用素材可从现有素材面板选择并连线；接通文本优化、生图提交、视频提交、串行轮询、结果操作、重试、版本标记和刷新恢复；动态显示 bootstrap 返回的模型名；修复引用节点覆盖目标节点。此前同分支还完成了项目、视频卡、方向、任务和生命周期面板。 |
| `public/tools/ultimate-canvas/canvas-engine.js` | 将图片/视频节点原有静态工具条改成真实模式、引用、设置、运镜和提交控件；补齐图片与视频参数面板；移除生成节点里没有实现语义的伪功能入口；提交按钮增加稳定选择器。 |
| `public/tools/ultimate-canvas/generation-node-workflow.js` | 新增可在浏览器和 Node 烟测复用的纯契约模块，集中处理图片/视频模式、校验、请求 payload、去重引用和响应归一化；固定使用 sd2 同源端点，不含 provider 或 Key。 |
| `public/tools/ultimate-canvas/index.html` | 按依赖顺序加载视频卡与生成节点契约模块；将样式、画布引擎和 app 的 cache-buster 更新到生成节点版本，避免部署后命中旧脚本。 |
| `public/tools/ultimate-canvas/styles.css` | 增加生成模式、引用列表、参数设置、运镜预设、结果操作与状态样式；720px 以下切成单列，节点参数面板宽度受视口约束。此前同分支还增加项目/视频卡原位面板样式。 |
| `public/tools/ultimate-canvas/video-card-workflow.js` | 集中定义视频卡、方向、任务版本、重试、迁移、拆分、合并和审批请求契约，供现有画布复用。 |
| `src/app/api/tools/ultimate-canvas/bootstrap/route.ts` | 普通账号只返回可生成项目；返回项目、视频卡、方向和模型能力；从画布文档恢复上下文；不向普通账号暴露后台 provider 配置。 |
| `src/app/api/video-cards/[id]/route.ts` | 增加受现有权限与内容约束的归档/废弃动作；有内容的视频卡只能归档；不增加 admin 绕过。 |
| `src/app/api/video-cards/[id]/tasks/route.ts` | 任务记录返回 `video_branch_id`，让画布正确显示和恢复任务方向。 |
| `src/app/api/video/retry/[id]/route.ts` | 重试沿用原任务的 `video_branch_id`，继续进入现有任务创建和点数逻辑；未修改计费规则。 |
| `src/lib/projects/display.ts` | 新增项目显示名称、类型、摘要、内容判断和删除/归档动作计算纯函数。 |
| `src/lib/video-cards/display.ts` | 新增视频卡状态文案、规格摘要和归档/废弃动作计算纯函数。 |
| `scripts/ultimate-canvas-complete-smoke.ts` | 锁定普通账号项目过滤、保存隔离、上传节点追踪、同源生成接口、串行轮询和生命周期约束。 |
| `scripts/ultimate-canvas-context-rules-smoke.ts` | 锁定 admin 上下文规则只在允许范围生效，并同步当前静态资源版本断言。 |
| `scripts/ultimate-canvas-generation-node-workflow-smoke.ts` | 覆盖图片/视频所有请求模式、参数校验、响应归一化、可见控件、持久化、结果操作、引用节点布局和 cache-buster。 |
| `scripts/ultimate-canvas-normal-user-access-smoke.ts` | 锁定普通账号无需 admin，viewer 项目不会进入可生成项目列表。 |
| `scripts/ultimate-canvas-preview-api-smoke.ts` | 在随机本机端口验证图片完整 payload、图片入库、视频完整 payload、运行到成功、尾帧返回以及带节点设置和连线的文档保存恢复。 |
| `scripts/ultimate-canvas-preview-server.mjs` | 扩展只绑定 `127.0.0.1` 的内存 mock，模拟图片能力、素材库、生图、视频设置、状态轮询、尾帧和文档恢复；不读取 `.env`、不联网、不调用模型、不扣点。 |
| `scripts/ultimate-canvas-video-card-workflow-smoke.ts` | 覆盖视频卡、方向和任务操作契约，并同步当前样式/app 静态资源版本。 |
| `docs/superpowers/specs/2026-07-11-ultimate-canvas-generation-nodes-design.md` | 记录现有生图/视频节点原位增强的范围、接口映射、状态模型、持久化和测试策略。 |
| `docs/superpowers/specs/2026-07-11-ultimate-canvas-video-card-in-place-design.md` | 记录项目/视频卡/方向原位增强的设计边界和权限策略。 |
| `docs/superpowers/plans/2026-07-11-ultimate-canvas-generation-nodes.md` | 记录契约、控件、生图、视频、预览 API、恢复和浏览器验收的实施步骤。 |
| `docs/superpowers/plans/2026-07-11-ultimate-canvas-video-card-in-place.md` | 记录视频卡与方向功能的分步实施计划。 |
| `docs/handoffs/ultimate-canvas-implementation-report.md` | 更新为本次完整实施、验证、限制、风险和交付状态回执。 |

## 4. 跑了哪些验证命令

```powershell
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
node --check public/tools/ultimate-canvas/generation-node-workflow.js
node --check scripts/ultimate-canvas-preview-server.mjs

npx tsx scripts/ultimate-canvas-generation-node-workflow-smoke.ts
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/ultimate-canvas-complete-smoke.ts
npx tsx scripts/ultimate-canvas-normal-user-access-smoke.ts
npx tsx scripts/ultimate-canvas-context-rules-smoke.ts
npx tsx scripts/ultimate-canvas-video-card-workflow-smoke.ts

npx tsc --noEmit --pretty false
npm run lint
npm run build
git diff --check
```

本地交互验证使用：

```powershell
node scripts/ultimate-canvas-preview-server.mjs 4399
```

在应用内浏览器打开 `http://127.0.0.1:4399/tools/ultimate-canvas/index.html`，实际完成：新建图片节点、选择并连线引用素材、设置参数、提交生图、查看结果、由结果创建视频节点、优化提示词、写入运镜预设、设置视频参数、提交视频、轮询到成功、预览/下载入口、付费重试确认、刷新恢复和 390x844 窄屏检查。

## 5. 验证结果是否通过

- 4 个 `node --check`：通过。
- 6 个无线画布烟测：通过。
- TypeScript：通过。
- `npm run lint`：退出码 0，无 error；仓库其他页面仍有既存 React Hook 和 `<img>` warning。
- `npm run build`：通过，Next.js 生产构建成功并包含画布相关 API 路由。
- 本地预览 API 图片、视频、轮询和保存恢复闭环：通过。
- 桌面浏览器图片到视频完整 UI 流程：通过；重试后新任务也轮询到成功。
- 刷新后模式、参数、音频、任务、结果和连接恢复：通过。
- 浏览器 console error/warn：0。
- 390x844 检查：`document.scrollWidth === document.clientWidth === 390`，参数面板为单列并位于视口内。
- 浏览器截图接口曾超时，但 DOM、可访问树、实际点击结果和尺寸指标均已读取；这不影响代码和 API 验证结果。

## 6. 是否真实调用了文字/图片/视频生成

没有调用线上真实模型。

生产代码已经接到 sd2 现有真实同源接口，但本次没有在 `https://sd2.youdoodesign.com` 使用真实普通账号提交文字、图片或视频生成。本地浏览器确实走完了三个 UI 请求和视频轮询流程，但服务端是内存 mock，因此不能表述为真实模型生成成功。

## 7. 是否消耗了点数

没有。没有向线上 sd2 创建真实生成或重试任务，因此没有冻结、扣除或返还点数。本地 UI 的重试确认文案会明确提示真实部署后可能扣点。

## 8. 是否碰过后台设置、密钥、点数核心逻辑

没有。

- 未读取或修改 `.env`。
- 未修改后台 API 设置页面或后台模型配置。
- 未修改 provider 密钥、第三方 API Key 或 provider base URL。
- 未修改 `src/lib/credits/*` 或任何点数冻结、扣除、退款核心规则。
- 未修改数据库 schema，也没有执行数据库迁移。
- 未把普通账号改成 admin，也未增加权限绕过。
- 前端只消费 bootstrap 返回的能力并请求 sd2 相对路径。

## 9. 还没做完的内容

- 尚未把最终提交部署到 `https://sd2.youdoodesign.com` 的预览或生产环境。
- 尚未用真实普通测试账号在线提交一次文字、图片、视频和重试任务。
- 尚未在线核对真实 provider 返回字段、失败态、超时态、点数流水、图片入库、视频播放/下载和尾帧资产。
- 最新本地提交因当前 GitHub 身份无仓库写权限而无法推送，改以完整 patch 交付。
- 多人协作、分享、通知、反馈等全局入口仍标记为待接入；它们不属于本次生图/视频节点范围。

## 10. 风险和建议下一步

1. 先部署该分支到 sd2 临时预览，用普通账号验证 401/403、可生成项目范围和视频卡权限，不使用 admin 代测。
2. 先验证不扣点路径：画布保存恢复、真实文件上传、现有素材选择、项目/视频卡/方向切换。
3. 确认测试账号点数后，由用户手动各触发一次文字、图片、视频和重试，记录请求、任务归属与点数流水。
4. 视频必须等待到终态，再核对失败提示、播放、下载、尾帧、版本标记以及刷新恢复。
5. 特别核对线上 bootstrap 的图片尺寸、视频分辨率/时长/音频能力与当前 UI 选项一致；若后端能力收窄，应由 bootstrap 驱动隐藏或禁用选项。
6. 在真实移动设备补一张 390px 左右视口截图；本机尺寸与交互检查已通过，但截图传输工具曾超时。
7. 当前 GitHub 身份对目标仓库的最终推送返回 403；请由有权限的维护者应用 `E:\Ultimate-canvas\ultimate-canvas-complete-final.patch`，再推送目标分支。
