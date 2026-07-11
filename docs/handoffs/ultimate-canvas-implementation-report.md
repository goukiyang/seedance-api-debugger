# 无线画布完整实施回执

日期：2026-07-11

分支：`teammate/ultimate-canvas-complete`

Task 8 基线：`f72fc26716ef43d4905e5ea03bb511139c32f20e`

## 1. 本次目标理解

本系列工作在现有无线画布内完成项目、视频卡、图片与视频生成节点的原位交互闭环，不新建第二套生成流程。Task 8 增加最低优先级的视频点数预估：每个视频节点独立防抖 350ms，参数变化会中止上一请求，只调用同源现有 `/api/tasks/estimate?resolution=...&duration=...`。预估仅供参考，成功显示“预计 N 点”，失败显示“提交后由后台计算”，不影响提交按钮；图片继续显示“后台计费”。前端不保存计价公式，预估状态也不进入画布文档。

## 2. 实际修改了哪些文件

从交付起点到 Task 8 的修改/新增文件如下：

- 前端：`public/tools/ultimate-canvas/app.js`、`canvas-engine.js`、`generation-node-interactions.js`、`generation-node-workflow.js`、`generation-task-coordinator.js`、`video-card-workflow.js`、`index.html`、`styles.css`。
- 本地预览与自动验证：`scripts/ultimate-canvas-preview-server.mjs`、`ultimate-canvas-preview-api-smoke.ts`、`ultimate-canvas-generation-node-interactions-smoke.ts`、`ultimate-canvas-generation-node-workflow-smoke.ts`、`ultimate-canvas-generation-task-coordinator-smoke.ts`、`ultimate-canvas-video-card-workflow-smoke.ts`、`ultimate-canvas-complete-smoke.ts`、`ultimate-canvas-context-rules-smoke.ts`、`ultimate-canvas-normal-user-access-smoke.ts`。
- 既有接口与显示规则：`src/app/api/tools/ultimate-canvas/bootstrap/route.ts`、`src/app/api/video-cards/[id]/route.ts`、`src/app/api/video-cards/[id]/tasks/route.ts`、`src/app/api/video/retry/[id]/route.ts`、`src/lib/projects/display.ts`、`src/lib/video-cards/display.ts`。
- 设计、计划与回执：`docs/superpowers/specs/2026-07-11-ultimate-canvas-generation-nodes-design.md`、`2026-07-11-ultimate-canvas-video-card-in-place-design.md`、`2026-07-11-ultimate-canvas-liblib-interactions-design.md`，对应三个计划文件，以及本回执。
- Task 8 另同步了三个旧烟测中的最终 cache key 断言：`ultimate-canvas-generation-node-workflow-smoke.ts`、`ultimate-canvas-context-rules-smoke.ts`、`ultimate-canvas-video-card-workflow-smoke.ts`。

## 3. 每个文件改了什么

- `app.js`：完成项目/视频卡上下文、引用选择、节点折叠与弹层、图片原位结果、下游视频创建、视频任务轮询恢复，以及 Task 8 的瞬时视频预估。预估以分辨率和时长签名防止旧响应覆盖新设置；单节点删除执行定向清理，整画布清空、文档恢复、项目/视频卡上下文切换及 `pagehide` 均在替换上下文前执行全量清理。
- `canvas-engine.js`、`styles.css`：提供紧凑/展开节点、单一弹层入口、引用兼容/禁用状态、稳定结果区域和窄屏布局；图片与视频均保留可编辑提交控件。
- 三个 generation 模块：分别集中交互纯函数、生成请求/响应契约和任务轮询协调，覆盖引用去重、持久化清洗、连接回滚、轮询替换及过期响应保护。`generation-node-interactions.js` 还提供生产与烟测共用的 `clearVideoEstimateEntries`：每个非空 timer 清理一次、每个 controller 中止一次，即使中止抛错也继续并最终清空 Map。
- `video-card-workflow.js`：集中视频卡、方向、任务版本、重试、迁移、拆分、合并和审批请求契约。
- `index.html`：按依赖顺序加载模块；`styles.css`、`canvas-engine.js`、`generation-node-interactions.js`、`generation-node-workflow.js`、`generation-task-coordinator.js`、`app.js` 最终 cache key 统一为 `20260711-liblib-interactions`。
- `ultimate-canvas-preview-server.mjs`：仅监听本机并以内存 mock 覆盖画布 API；Task 8 的 `/api/tasks/estimate` mock 使用 `Math.ceil(duration * 3)`，该公式只存在于预览服务器，不进入生产文件。
- 烟测脚本：覆盖普通用户权限、上下文隔离、节点模式和参数、引用选择、原位结果、连接回滚、轮询协调、保存恢复、预览 API，以及 Task 8 的预估端点、350ms 防抖、请求中止、签名保护和文案。
- 既有后端文件：补齐画布 bootstrap、视频卡管理/任务归属/重试沿用方向及纯显示规则；未新增或修改后端生成路由。

## 4. 跑了哪些验证命令

先按 TDD 运行并记录 RED：

```powershell
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
```

随后严格按 Task 8 顺序运行：`git diff --check`；6 个 `node --check`；8 个 `npx tsx` 烟测；`npx tsc --noEmit --pretty false`；`npm run lint`；`npm run build`。未启动、重启或终止现有 4399 预览服务器。

## 5. 验证结果是否通过

- RED 符合预期：交互烟测因最终 cache key/预估实现缺失退出 1；预览 API 对 `/api/tasks/estimate` 返回 501，退出 1。
- 评审修复 RED 符合预期：第一次因缺少 `clearAllVideoEstimates` 失败；第二次因项目/视频卡 bootstrap 切换未清理失败。实现共享 helper 与生命周期接线后，两组断言均转为 GREEN。
- GREEN 与完整套件全部退出 0：6 个语法检查、8 个烟测、TypeScript、lint、build 均通过；预览 API 烟测在随机本机端口启动并自行清理子进程。
- `npm run lint` 有 38 条既有 warning：6 条 `react-hooks/exhaustive-deps`、32 条 `@next/next/no-img-element`；修改的无线画布文件无新增 lint warning。构建成功生成 76 个静态页面，并包含 `/api/tasks/estimate` 与无线画布路由。
- 本代理未执行应用内浏览器 QA，也不声称九项浏览器验收通过。最终浏览器验收由父代理在现有预览服务器上补充。

## 6. 是否真实调用了文字/图片/视频生成

没有。本次仅运行源代码检查、Node 烟测、TypeScript、lint、构建和随机本机端口的内存 mock API。没有访问线上 sd2，没有调用任何第三方或真实文字、图片、视频模型。生产前端只引用既有同源接口；本地预览返回的文字、图片、视频和点数预估均为 mock。

## 7. 是否消耗了点数

没有，消耗点数为 0。没有创建线上生成或重试任务，没有冻结、扣除、返还或调整点数。Task 8 预估请求为信息展示，失败不禁用提交；本地 mock 不连接真实账户或计费系统。

## 8. 是否碰过后台设置、密钥、点数核心逻辑

没有读取或修改 `.env`、后台 API 设置、provider 密钥/地址、认证或管理员绕过、数据库 schema、点数冻结/扣减/退款核心逻辑，也没有修改后端生成路由。Task 8 只消费现有 `/api/tasks/estimate`，生产代码未持久化任何计价公式；预览公式仅位于本机 mock 文件。

## 9. 还没做完的内容

- 父代理仍需完成九项浏览器验收：紧凑/展开节点、画布引用选择、禁用模式及原因、单弹层与 Escape、同节点图片结果、已连接视频创建、刷新后轮询恢复、390px 视口、控制台零新增 error/warning。
- 浏览器验收时应额外观察：在视频预估请求待定期间切换项目/视频卡或恢复文档，不得让旧上下文的点数结果写入新上下文节点。
- 尚未部署到线上环境，也未用真实普通账号核对线上 estimate/provider 字段、失败/超时状态、资产播放下载和真实点数流水。
- 本任务不负责推送；当前提交后的远端权限和推送结果需由父代理确认并追加。

## 10. 风险和建议下一步

1. 先由父代理使用现有本地预览服务器完成九项浏览器验收，并将实际结果追加到本报告，不要触发线上生成。
2. 部署到受控预览环境后，先验证不扣点路径、普通用户权限和估算失败降级，再由有授权的用户决定是否进行最小真实生成测试。
3. 线上重点核对 `/api/tasks/estimate` 的 `estimatedCost` 字段、分辨率/时长组合、请求取消行为及旧响应不会覆盖新设置。
4. 保持点数预估为信息层；后端仍是最终计费来源，前端不得复制或持久化计价规则。
5. 现有 38 条仓库级 lint warning 与本范围无关，可在独立维护任务中处理，避免混入本次交付。

## Browser QA follow-up: generated result layout

Parent browser QA confirmed that the image result and editor remain on the same node. It also found a layout defect at 71% zoom: the selected card ended at `y=746.21`, while the visible create-video action began at `y=792.54`, underneath the following image properties panel. The action locator was visible to Playwright, but the overlapping panel intercepted the click.

The defect is fixed in CSS. Selected image/video nodes with a nonempty generation result now use content-driven height with a `350px` minimum; generated result cards use border-box sizing; previews are bounded; and action rows remain in normal flow above the same-node editor. Unselected generated nodes retain the compact `350x240` card and hide result actions until selected. Ports remain at the actual card's vertical center, and the existing `ResizeObserver` continues to refresh connection paths after card size changes. Video task/version action rows remain in the same result card and were not removed or nested.

The source smoke now rejects the old fixed-height selected-result behavior and verifies the compact-state, bounded-media, connector-centering, and resize-observer contracts. Final browser rectangle and click re-verification is pending parent confirmation.
