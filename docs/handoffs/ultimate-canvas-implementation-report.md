# 无线画布完善实施回执

日期：2026-07-11

分支：`teammate/ultimate-canvas-complete`

基线提交：`2ce4a17010a8e5867a3f405b024f555b417da565`

## 1. 本次目标理解

本次目标是在 sd2 现有无线画布页面原位补齐项目、视频卡和生成闭环，不新增独立页面、独立流程或第二套后台。

- 普通登录账号可使用，不绕成 admin。
- 项目和视频卡的可见范围、生命周期、生成资格与普通生成页使用同一套后端规则。
- 保存恢复、上传、文本生成、图片生成、视频生成和状态轮询均调用 sd2 同源 `/api/...` 接口。
- 视频任务必须归属当前项目、视频卡和所选方向，重试也保留原方向。
- 不直连第三方 provider，不读取或修改第三方 API Key。
- 不读取或修改 `.env`、后台 API 设置、点数核心规则、provider 密钥配置和数据库 schema。

前端使用相对路径，因此部署到 `https://sd2.youdoodesign.com` 后统一由该站点同源后端处理。

## 2. 实际修改了哪些文件

- `public/tools/ultimate-canvas/app.js`
- `public/tools/ultimate-canvas/styles.css`
- `public/tools/ultimate-canvas/index.html`
- `public/tools/ultimate-canvas/video-card-workflow.js`
- `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`
- `src/app/api/video-cards/[id]/route.ts`
- `src/app/api/video-cards/[id]/tasks/route.ts`
- `src/app/api/video/retry/[id]/route.ts`
- `src/lib/projects/display.ts`
- `src/lib/video-cards/display.ts`
- `scripts/ultimate-canvas-complete-smoke.ts`
- `scripts/ultimate-canvas-normal-user-access-smoke.ts`
- `scripts/ultimate-canvas-context-rules-smoke.ts`
- `scripts/ultimate-canvas-video-card-workflow-smoke.ts`
- `scripts/ultimate-canvas-preview-api-smoke.ts`
- `scripts/ultimate-canvas-preview-server.mjs`
- `docs/superpowers/specs/2026-07-11-ultimate-canvas-video-card-in-place-design.md`
- `docs/superpowers/plans/2026-07-11-ultimate-canvas-video-card-in-place.md`
- `docs/handoffs/ultimate-canvas-implementation-report.md`

## 3. 每个文件改了什么

### `public/tools/ultimate-canvas/app.js`

- 项目和视频卡使用原位上下文菜单，保留当前无线画布，不跳转到新工作流。
- 项目菜单支持普通账号可见项目、新建、切换、空项目删除和有内容项目归档。
- 视频卡菜单从 `/api/projects/:id/video-cards` 刷新，可搜索并原位展开信息、方向、记录、操作四个页签。
- 视频卡信息可编辑；支持封板、归档、废弃、比例审批和重开审批。
- 方向支持新建、选择、设为主方向、关闭、合并和升格为视频卡。
- 生成记录支持查看任务归属方向、播放、下载、版本标记、付费重试确认、迁移、拆分和卡片合并。
- 提示词完整窗口增加方向选择；节点和画布文档保存 `video_card_id`、`video_branch_id`。
- 视频提交带当前项目、视频卡和方向；任务轮询终态写回节点和视频卡记录。
- 重试使用现有 sd2 重试接口，并在 UI 明确提示会创建真实任务、可能消耗点数。
- 项目或视频卡切换前保存旧上下文，保存请求锁定发起时的项目、视频卡、方向和文档 ID，避免异步串写。
- 上传保留 `canvas_node_id`；文本、图片和视频生成统一检查当前上下文及后端能力。
- 视频轮询使用串行 `setTimeout`，避免重复轮询请求重叠。

### `public/tools/ultimate-canvas/styles.css`

- 增加项目/视频卡菜单、详情页签、信息表单、方向列表、任务列表、版本动作和危险操作样式。
- 原位视频卡面板最大宽度为 560px，并受视口宽度约束。
- 窄屏改为单列布局，表单、任务动作和页签不产生页面级横向滚动。

### `public/tools/ultimate-canvas/index.html`

- 加载 `video-card-workflow.js`，并保证它早于 `app.js`。
- 更新 app、样式和 workflow 静态资源 cache-buster，避免部署后继续命中旧资源。
- 项目标题保持只读上下文显示。

### `public/tools/ultimate-canvas/video-card-workflow.js`

- 新增可在浏览器和 Node 烟测中复用的视频卡工作流契约。
- 集中定义卡片生命周期、方向、任务版本、重试、迁移、拆分、合并和审批请求。
- 集中计算当前可用方向、默认方向和生成上下文，避免 UI 各处自行拼接接口。

### `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`

- 普通用户只返回可生成项目，不把 viewer 项目混入生成列表。
- 返回项目 owner、显示名、任务/图集计数、管理权限、分组和生命周期动作。
- 返回视频卡 owner、目标、规格、状态、任务数、方向数、可生成状态和生命周期动作。
- 从最近画布文档恢复视频卡上下文；不可生成卡可以查看但不会成为默认生成卡。
- 能力提示保持通用，不向普通账号暴露后台配置名称。

### `src/app/api/video-cards/[id]/route.ts`

- 增加受权限和状态约束的 `archive`、`discard` 生命周期动作。
- 有任务、最终版或方向的视频卡不能废弃，只能归档。
- 继续复用项目权限校验和操作日志，没有新增硬删除或 admin 绕过。

### `src/app/api/video-cards/[id]/tasks/route.ts`

- 任务记录返回 `video_branch_id`，让画布能显示和恢复每个任务的方向归属。

### `src/app/api/video/retry/[id]/route.ts`

- 重试读取原任务的 `video_branch_id`，并把它传入现有任务创建逻辑。
- 未修改点数冻结、扣减、返还或 provider 调用规则。

### `src/lib/projects/display.ts`

- 新增项目显示名、类型、摘要、是否有内容、删除/归档动作及原因纯函数。

### `src/lib/video-cards/display.ts`

- 新增视频卡状态文案、规格摘要、归档/废弃动作及原因纯函数。

### `scripts/ultimate-canvas-complete-smoke.ts`

- 锁定普通账号项目过滤、上下文菜单、保存隔离、上传节点追踪、同源生成接口、串行轮询和生命周期约束。

### `scripts/ultimate-canvas-normal-user-access-smoke.ts`

- 锁定普通账号无需 admin，且 viewer 项目不进入可生成项目列表。

### `scripts/ultimate-canvas-context-rules-smoke.ts`

- 锁定方向上下文保存恢复和提示词方向选择。
- 同步最终静态资源 cache-buster。

### `scripts/ultimate-canvas-video-card-workflow-smoke.ts`

- 覆盖所有视频卡/方向/任务操作的请求路径、方法和 payload。
- 检查生成携带 `video_branch_id`、重试保留方向、原位 UI 控件和响应式样式存在。

### `scripts/ultimate-canvas-preview-api-smoke.ts`

- 在随机本机端口启动预览服务并执行完整 API 闭环。
- 覆盖卡片读取/编辑、方向、新建任务/轮询、版本、重试、迁移、拆分、合并、审批和画布保存恢复。

### `scripts/ultimate-canvas-preview-server.mjs`

- 扩展只绑定 `127.0.0.1` 的内存 mock 服务。
- 模拟视频卡详情、方向、任务、版本、重试、迁移、拆分、合并、审批和文档接口。
- 不读取 `.env`、不连接数据库、不访问线上 sd2、不调用模型、不扣点。

### `docs/superpowers/specs/2026-07-11-ultimate-canvas-video-card-in-place-design.md`

- 记录现有画布原位增强的设计边界、真实接口映射、权限和测试策略。

### `docs/superpowers/plans/2026-07-11-ultimate-canvas-video-card-in-place.md`

- 记录按契约、保存恢复、UI、方向、提交轮询、任务操作和最终联调拆分的实施计划。

### `docs/handoffs/ultimate-canvas-implementation-report.md`

- 更新为本次完整实施、验证、风险和交付状态回执。

## 4. 跑了哪些验证命令

```powershell
npm ci
git diff --check
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
node --check public/tools/ultimate-canvas/video-card-workflow.js
node --check scripts/ultimate-canvas-preview-server.mjs
npx tsc --noEmit --pretty false
npx tsx scripts/ultimate-canvas-video-card-workflow-smoke.ts
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/ultimate-canvas-complete-smoke.ts
npx tsx scripts/ultimate-canvas-normal-user-access-smoke.ts
npx tsx scripts/ultimate-canvas-context-rules-smoke.ts
npm run lint
npm run build
```

本机交互验证：

```powershell
node scripts/ultimate-canvas-preview-server.mjs 4399
```

随后在应用内浏览器打开 `http://127.0.0.1:4399/tools/ultimate-canvas/index.html`，实际点击视频卡列表、信息、方向、记录和操作页签；并用 390x844 视口检查菜单边界和页面横向滚动。

## 5. 验证结果是否通过

- 四个 `node --check`：通过。
- TypeScript：通过。
- 五个无线画布烟测：通过。
- 预览 API 完整闭环：通过。
- `git diff --check`：通过，仅输出工作区既有 LF/CRLF 转换提示。
- `npm run lint`：通过，无 error；输出仓库其他页面既有 React Hook 和 `<img>` warning。
- `npm run build`：通过，Next.js 生产构建成功；保留同一批既有 lint warning。
- 桌面端原位视频卡四个页签：通过，无明显遮挡。
- 390x844 响应式检查：通过，`document.scrollWidth === document.clientWidth === 390`，视频卡菜单宽度在视口内。
- 移动端覆盖视口截图调用两次超时，但 DOM、可访问树和边界指标均成功读取；桌面截图成功。

## 6. 是否真实调用了文字/图片/视频生成

没有。

生产代码已经接到 sd2 现有真实同源接口，但本次没有在 `https://sd2.youdoodesign.com` 使用真实普通账号提交文字、图片或视频生成。所有自动闭环使用本机内存 mock，不能写成真实生成成功。

## 7. 是否消耗了点数

没有。没有向线上 sd2 创建真实生成或重试任务，因此没有冻结、扣减或返还点数。

## 8. 是否碰过后台设置、密钥、点数核心逻辑

没有。

- 未读取或修改 `.env`。
- 未修改后台 API 设置页面。
- 未修改 `src/lib/credits/*` 或点数核心规则。
- 未修改 provider 密钥、第三方 API Key 或 provider base URL。
- 未修改数据库 schema。
- 未把普通账号改成 admin，也未增加权限绕过。
- 仅让重试继续携带原任务方向，仍进入现有任务创建和点数逻辑。

## 9. 还没做完的内容

- 尚未把最终提交部署到 `https://sd2.youdoodesign.com` 预览环境。
- 尚未使用真实普通测试账号完成线上 401/403、项目可见范围和危险动作权限验收。
- 尚未真实提交保存、上传、文本、图片、视频和重试任务，也未在线轮询到终态。
- 尚未核对真实任务的点数冻结、扣减、失败返还、资产入库和视频播放/下载。
- 最终推送和补丁交付状态将在提交完成后执行并记录。

## 10. 风险和建议下一步

1. 先部署该分支到 sd2 临时预览，用普通测试账号验证项目和视频卡权限，不使用 admin 账号代测。
2. 先做无付费或低风险操作：画布保存恢复、上传、视频卡编辑、方向切换和既有任务读取。
3. 真实生成前确认测试账号点数；由用户手动触发一次文字、图片、视频和重试，并分别核对任务归属的视频卡/方向。
4. 视频必须轮询到终态，再核对播放、下载、版本标记、失败提示和点数流水。
5. 重点回归项目/视频卡切换时旧画布不会串存，重试不会丢失原方向。
6. 移动端建议在真实设备再补一张截图；本机覆盖视口的 DOM 和尺寸检查已通过，但截图传输在浏览器工具侧超时。
7. 依赖安装报告的既有漏洞不属于本次范围，建议单独开依赖升级任务，避免与无线画布交付混合。
