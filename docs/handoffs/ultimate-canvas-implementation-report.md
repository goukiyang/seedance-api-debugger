# 无线画布完善实施回执

日期：2026-07-11

分支：`teammate/ultimate-canvas-complete`

基线提交：`2ce4a17010a8e5867a3f405b024f555b417da565`

推送状态：本地已提交；推送远端时 GitHub 对当前身份 `K4y2025` 返回 403，无仓库写权限。已另行生成完整 format-patch 供合并。

## 1. 本次目标理解

本次目标是在 sd2 现有项目、视频卡、资产、任务和点数体系内补完整无线画布，而不是新建一套独立后台。普通登录账号应能使用页面；项目与视频卡选择及管理规则对齐普通生成页；画布保存恢复、上传、文本生成、图片生成、视频生成和状态轮询都通过 sd2 同源业务接口完成。

前端只使用 `/api/...` 相对路径，由部署在 `https://sd2.youdoodesign.com` 的同源后端处理。没有增加第三方 API Key、可配置 `base_url`、provider 直连接口或 admin 绕过。

## 2. 实际修改了哪些文件

- `public/tools/ultimate-canvas/app.js`
- `public/tools/ultimate-canvas/styles.css`
- `public/tools/ultimate-canvas/index.html`
- `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`
- `src/app/api/video-cards/[id]/route.ts`
- `src/lib/projects/display.ts`
- `src/lib/video-cards/display.ts`
- `scripts/ultimate-canvas-complete-smoke.ts`
- `scripts/ultimate-canvas-preview-server.mjs`
- `scripts/ultimate-canvas-normal-user-access-smoke.ts`
- `scripts/ultimate-canvas-context-rules-smoke.ts`
- `docs/handoffs/ultimate-canvas-implementation-report.md`

## 3. 每个文件改了什么

### `public/tools/ultimate-canvas/app.js`

- 将项目和视频卡原生 `<select>` 替换为自定义上下文菜单。
- 项目菜单显示头像、显示名、owner、项目类型、任务数、图集数和当前选中状态。
- 支持菜单内新建项目、删除空项目、归档有内容项目，并提供二次确认。
- 视频卡菜单显示 owner、目标、状态、比例、时长、分辨率和生成次数。
- 支持新建、查看、归档或废弃视频卡；重复视频卡由现有 409 规则二次确认。
- 项目切换前强制保存旧上下文，新项目无文档时清空画布，避免旧项目节点误存到新项目。
- 保存请求绑定发起时的项目、视频卡和文档 ID；忽略切换后的过期响应。
- 保存状态可点击手动重试；读取最近画布时恢复对应视频卡上下文。
- 素材/历史请求绑定项目快照，项目切换后不写回过期列表。
- 上传请求补 `canvas_node_id`，上传成功后使用同一节点 ID 建立画布节点。
- 文本、图片、视频生成统一检查项目和视频卡可生成状态。
- 能力不可用时展示 bootstrap 的通用 message，不引导普通用户进入后台设置。
- 节点增加提交中、轮询中、成功、失败状态；失败保留提示词和已选素材。
- 视频轮询改为串行 `setTimeout`，避免 `setInterval` 造成重叠请求；终态为 `succeeded/failed/cancelled`。

### `public/tools/ultimate-canvas/styles.css`

- 新增项目/视频卡触发器、头像、分组列表、动作按钮、创建表单和空状态样式。
- 新增二次确认弹窗和节点生成状态样式。
- 860px 以下使用双行头部和全宽菜单；390px 视觉检查未出现菜单横向溢出。

### `public/tools/ultimate-canvas/index.html`

- 项目标题改为只读当前上下文显示，避免编辑后无法保存的误导。
- 更新静态资源 cache-buster。

### `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`

- 普通用户项目查询排除 viewer 角色，只返回可生成项目。
- 项目返回 owner、头像、任务/图集计数、管理权限、分组、显示名、meta 和允许的移除动作。
- 管理员项目按自己拥有、参与、其他项目分组，owner 始终明确返回。
- 视频卡返回 owner、目标、规格、状态、任务数、分支数、可生成状态和允许的生命周期动作。
- 返回归档/封板等不可生成视频卡供查看，但不会把它们作为恢复时的默认可生成卡。
- 从最近画布 `document_json.context.video_card_id` 恢复视频卡上下文。
- 任务/分支数量使用直接计数，不读取或返回成本汇总。
- 能力不可用 message 改为通用提示，不暴露后台密钥配置名。

### `src/app/api/video-cards/[id]/route.ts`

- 增加受控 `action: archive | discard` 生命周期动作。
- 兜底、封板、已合并、已归档、已废弃视频卡不能直接执行该动作。
- 有任务、最终版或分支的视频卡不能废弃，只能归档。
- 没有增加视频卡硬删除接口；继续复用项目管理权限校验和操作日志。

### `src/lib/projects/display.ts`

- 新增项目显示名、类型文案、meta、是否有内容、删除/归档动作和原因纯函数。

### `src/lib/video-cards/display.ts`

- 新增视频卡状态文案、规格摘要、归档/废弃动作和原因纯函数。

### `scripts/ultimate-canvas-complete-smoke.ts`

- 锁定普通用户项目过滤、项目/视频卡显示规则、自定义菜单、保存隔离、上传节点追踪、sd2 来源字段、串行轮询、无第三方直连和视频卡生命周期约束。

### `scripts/ultimate-canvas-preview-server.mjs`

- 新增只绑定 `127.0.0.1` 的纯 mock 视觉预览服务。
- 不读取 `.env`，不连接数据库，不转发线上请求，不调用模型。
- 使用内存数据模拟项目/视频卡新建与归档、画布保存恢复、上传、文字/图片生成和视频状态轮询，方便本机点击验收。

### 既有烟测更新

- `scripts/ultimate-canvas-normal-user-access-smoke.ts`：锁定 viewer 项目不进入普通用户生成列表。
- `scripts/ultimate-canvas-context-rules-smoke.ts`：同步新的静态资源 cache-buster。

## 4. 跑了哪些验证命令

```bash
npm ci
git diff --check
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
npx tsc --noEmit --pretty false
npx tsx scripts/ultimate-canvas-complete-smoke.ts
npx tsx scripts/ultimate-canvas-normal-user-access-smoke.ts
npx tsx scripts/ultimate-canvas-context-rules-smoke.ts
npm run lint
npm run build
```

视觉验证：

```bash
node scripts/ultimate-canvas-preview-server.mjs 4399
```

随后使用本机 Chrome headless 分别以 `1440x900` 和 `390x844` 截图检查项目菜单、视频卡菜单和移动端布局。

另外通过 `127.0.0.1:4399` 的 mock API 依次验证：新建项目、新建视频卡、保存/读取画布、文字生成、图片生成、创建视频任务及两次状态轮询。

## 5. 验证结果是否通过

- `npm ci`：通过，安装 524 个包；未修改 `package.json` 或 `package-lock.json`。
- `git diff --check`：通过，仅有 Git 的 LF/CRLF 提示。
- 两个 `node --check`：通过。
- TypeScript：通过。
- 三个无线画布烟测：通过。
- `npm run lint`：通过；输出为仓库其他文件既有 React Hook / `<img>` 警告，本次无线画布没有 lint error。
- `npm run build`：通过；Next.js 生产构建成功，仍有仓库既有 lint/autoprefixer warning。
- 桌面与 390px mock 视觉验证：通过；新菜单无明显遮挡或横向溢出。
- 本机 mock 功能闭环：通过；画布可恢复，文字/图片返回 `succeeded`，视频状态从 `running` 进入 `succeeded`。

## 6. 是否真实调用了文字/图片/视频生成

没有。

本次没有普通测试账号和线上预览部署，因此未真实调用文字、图片或视频生成。视觉验证使用本地纯 mock 服务，烟测只读取源码和运行纯函数。

## 7. 是否消耗了点数

没有。没有创建真实生成任务，也没有调用任何会冻结或扣减点数的接口。

## 8. 是否碰过后台设置、密钥、点数核心逻辑

没有。

- 未读取或修改 `.env`。
- 未修改后台 API 设置页面。
- 未修改 `src/lib/credits/*` 或点数扣减/返还核心规则。
- 未修改 `src/lib/provider/*` 或 provider 密钥配置。
- 未修改数据库 schema。
- 未写入 cookie、token、第三方 API Key 或自定义 provider base URL。
- 未把普通账号改成 admin，也未增加 admin 绕过。

## 9. 还没做完的内容

- 尚未用真实普通测试账号登录 `https://sd2.youdoodesign.com/tools/ultimate-canvas` 做线上 401/403、项目权限和视觉验收。
- 尚未真实执行保存、上传、文本生成、图片生成、视频生成和轮询到终态的线上闭环。
- 尚未验证真实生成后的点数冻结、扣减和失败返还流水；本次刻意没有触发付费生成。
- 无线画布节点编辑主体仍以桌面端为主要交互；本次只保证新上下文菜单在小屏不溢出。
- bootstrap 当前最多返回 100 个项目和 60 张视频卡；大规模账户后续建议增加搜索或分页。

## 10. 风险和建议下一步

1. 将该分支部署到临时预览环境，用普通测试账号验证项目/视频卡可见范围和危险动作权限。
2. 先做不付费闭环：保存/恢复、上传、文本生成（确认是否计点）和既有任务轮询。
3. 图片/视频真实生成前确认测试账号点数，并由用户在页面手动触发；视频必须轮询到终态并核对任务、资产和点数流水。
4. 重点验证切换项目时旧画布只保存在原项目，新项目无文档时保持空画布。
5. 验证有任务或分支的视频卡只能归档、不能废弃，封板/合并卡保持只读。
6. 仓库依赖安装报告 17 个既有漏洞（1 low、4 moderate、11 high、1 critical）；本次未修改依赖，建议另开依赖升级任务评估，避免和无线画布交付混在一起。
7. 当前身份没有目标仓库写权限；请由有权限的维护者应用交付 patch 后推送 `teammate/ultimate-canvas-complete`。
