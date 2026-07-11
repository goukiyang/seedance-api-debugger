# 无线画布 Codex 接手与后端接口调试交接

## 目标

让同事使用 Codex 补完整无线画布功能，重点修项目 / 视频卡选择器、保存恢复、上传、GPT 文本、图片生成、视频生成和轮询体验。调用 GPT、图片、视频时只能走 sd2 自己的后端业务接口，不给第三方 API Key，不开放 API 设置页面，不开放完整管理员后台。

## 当前代码基线

- 仓库：`https://github.com/goukiyang/seedance-api-debugger.git`
- 当前网站代码分支：`codex/seedream-5-pro-image-provider`
- 当前网站备份分支：`backup/2026-07-10-current-sd2-site`
- 当前网站备份 tag：`rollback/2026-07-10-current-sd2-site-backup`
- 交接开发分支：`teammate/ultimate-canvas-complete`
- 交接开发分支当前提交：`160dc419b48dbbe4a04a0c128ff45b8adbd0cc1b`
- 本文档路径：`docs/handoffs/ultimate-canvas-codex-api-handoff.md`

给同事的交接包只需要三样：

1. 仓库地址。
2. `teammate/ultimate-canvas-complete` 分支。
3. 普通登录调试账号，给足测试点数；密码单独发，不写进文档、聊天记录或代码。

同事开工命令：

```bash
git clone https://github.com/goukiyang/seedance-api-debugger.git
cd seedance-api-debugger
git fetch origin
git switch --track origin/teammate/ultimate-canvas-complete
```

下载权限说明：

- 这个 GitHub 仓库当前可公开读取；只要下载 / clone / fetch / checkout，不需要 GitHub 密码。
- 已用无登录、无本机凭据的 `git ls-remote` 验证：仓库和 `teammate/ultimate-canvas-complete` 分支都能读取。
- 如果同事要把代码直接推回这个仓库，才需要 GitHub 写入权限；没有写入权限时，让他把改动推到自己有权限的 fork / 分支，或发 patch / diff 给我们合并。
- 不要把任何 GitHub token、密码、cookie 写进文档、代码、commit message 或聊天记录。

## 我们给同事的权限

给普通登录调试账号，不给本人主账号，不给第三方 API Key，不给后台 API 设置页。

核心原则：

- 同事要拿到的是“通过 sd2 后端调用现有大模型的能力”，不是“后台管理权限”。
- 文本、图片、视频模型都只能通过我们自己的后端业务接口调用。
- 后端用服务器里已经配置好的模型和 Key 去请求供应商；前端和同事代码不能接触任何第三方 Key。
- 模型选择只能来自后端返回的允许列表或能力状态，不能让前端随便传 `base_url`、`api_key`、任意 provider 配置。

当前代码现状必须特别注意：

- 截至提交 `160dc419b48dbbe4a04a0c128ff45b8adbd0cc1b`，无线画布普通账号前置权限已经落地。
- `/tools/ultimate-canvas` 页面入口、静态全屏页，以及 `/api/tools/ultimate-canvas/bootstrap`、`document`、`generate`、`upload` 不再用整页 / 整接口 admin-only 拦普通用户。
- 普通账号仍必须登录；生成、上传、保存等动作继续复用项目、视频卡和点数权限。
- `/api/tools/ultimate-canvas/localization-health` 仍然只给管理员，因为它暴露本地化补偿和后台任务健康信息。
- 后台 API 设置、用户管理、成本总账仍然是管理员权限；同事不需要也不应该进入这些页面。

推荐权限：

- 能登录 `https://sd2.youdoodesign.com`
- 能访问 `/tools/ultimate-canvas`
- 能访问 `/generate` 作为普通生成页对照
- 能访问 `/projects`、项目详情、视频卡详情
- 能访问 `/assets`、`/tasks`、`/points`
- 能创建项目、删除空项目、归档自己能管理的项目
- 能创建视频卡、编辑 / 归档 / 废弃自己项目下的视频卡
- 能上传图片、保存画布、调用后端允许的文本模型、图片模型、视频模型、轮询任务
- 给有限测试点数，避免误消耗；点数不够时由我们给这个普通账号追加

不开放：

- `/admin/integrations`
- `/admin/users`
- `/admin/costs`
- 供应商余额、官方账单、成本总账
- `.env`
- 数据库原件
- cookie、token、第三方 API Key
- 点数批量发放 / 扣减能力

当前缺口：

- 代码层普通账号入口已经打开；还没做的是“真实同事普通账号”的登录态验收。
- 同事账号需要你在后台给足测试点数；点数不够时，图片 / 视频生成会按正常业务规则失败或被拦。
- 如果同事本地页面要直接连线上后端，还需要单独实现受限 debug proxy；当前推荐先通过线上 sd2 页面或预览部署验证。
- 不建议为了省事给完整 admin；正确做法仍然是普通账号 + 测试点数 + 现有后端接口。

实操边界：

- 密码通过单独渠道发给同事，不能提交到 Git。
- 同事不需要、也不能索要 OpenAI / Musk / Gemini / Seedance / Jimeng 等第三方密钥。
- 如果 `capabilities.*.enabled` 返回 `false`，同事只需要把返回的 `message` 发回给我们，不要去改 API 设置页。
- 账号给有限测试点数，避免真实视频 / 图片生成误消耗过大。

开工自检：

1. 登录 `https://sd2.youdoodesign.com`。
2. 打开 `https://sd2.youdoodesign.com/tools/ultimate-canvas`。
3. 普通账号应能加载出顶部项目 / 视频卡上下文，不出现 401 / 403。
4. 如果出现 403，先看是不是账号没权限访问当前项目 / 视频卡，或者登录态过期；不要改成 admin 绕过。
5. 创建或选择一个测试项目和视频卡，确认账户可用点数足够。

## 后端调用原则

同事不直接调 OpenAI、图片 provider 或视频 provider。

正确链路：

```text
无线画布页面或同事的调试代码
  -> sd2 后端业务接口
  -> sd2 后端读取已配置的 GPT / 图片 / 视频能力
  -> sd2 后端返回结果
```

禁止链路：

```text
同事代码
  -> 第三方 GPT / 图片 / 视频 API Key
```

开发连接方式：

```text
同事本地代码 / Codex
  -> 本地无线画布前端或我们部署后的无线画布页面
  -> https://sd2.youdoodesign.com/api/...
  -> sd2 现有后端模型、项目、视频卡、点数、资产体系
```

不要让同事本地重新搭一套完整后端：

- 不给 `.env`。
- 不给数据库原件。
- 不给第三方模型 Key。
- 不要求本地重建线上点数、项目、资产和 Provider 配置。
- 本地如果只跑前端，API 必须指向受控的 sd2 后端；如果要本地代理，只允许代理无线画布所需业务接口，不开放完整后台 CORS。

调试优先级：

1. 最安全：同事改代码后推分支，我们部署预览或临时环境，再用普通账号连现有后端验收。
2. 需要本地快调时：本地页面通过受限 debug base URL / proxy 连接 `https://sd2.youdoodesign.com`，只走允许的 `/api/tools/ultimate-canvas/*`、`/api/assets/generate`、`/api/tasks/create`、项目和视频卡接口。
3. 不允许：本地页面直接拿第三方 Key，或让生产后端打开全站通配 CORS。

## 可用页面

- `https://sd2.youdoodesign.com/tools/ultimate-canvas`
- `https://sd2.youdoodesign.com/generate`
- `https://sd2.youdoodesign.com/projects`
- `https://sd2.youdoodesign.com/assets`
- `https://sd2.youdoodesign.com/tasks`
- `https://sd2.youdoodesign.com/points`

如果页面需要管理员设置是否可用，只看无线画布 bootstrap 返回的 `capabilities.*.enabled/message/model`，不要进入 API 设置页。

无线画布需要从 `bootstrap` 读取后端允许的模型能力：

- `capabilities.text`：文本大模型能力，显示模型名、是否可用、调用 endpoint。
- `capabilities.image`：图片生成能力，显示 provider、模型、尺寸和参考图限制。
- `capabilities.video`：视频生成能力，显示默认视频模型、状态轮询 endpoint 和归属要求。
- 如果后续要给用户选择多个模型，只能由后端返回 `allowed_models` 或等价白名单；前端只传白名单里的 `model_id`，不能传 Key 或自定义 base URL。

## 可用接口

所有接口都要求登录态或后续约定的短期调试 Token。默认先用登录态。

### 1. 无线画布启动上下文

```http
GET /api/tools/ultimate-canvas/bootstrap?project_id=<projectId>&video_card_id=<videoCardId>
```

用途：

- 读取当前用户
- 读取可用项目
- 读取当前项目视频卡
- 读取点数
- 读取 GPT / 图片 / 视频能力是否可用
- 读取最近画布文档

不能返回：

- API Key
- provider 密钥
- 完整后台配置

### 2. 画布文档保存和读取

```http
GET /api/tools/ultimate-canvas/document?project_id=<projectId>
POST /api/tools/ultimate-canvas/document
```

POST 必带：

```json
{
  "project_id": "project_xxx",
  "video_card_id": "card_xxx",
  "nodes": [],
  "connections": [],
  "viewport": {}
}
```

### 3. GPT 文本 / 脚本生成

```http
POST /api/tools/ultimate-canvas/generate
```

最小 payload：

```json
{
  "kind": "text",
  "mode": "rewrite",
  "prompt": "把这段内容改成短视频脚本",
  "project_id": "project_xxx",
  "video_card_id": "card_xxx",
  "canvas_document_id": "canvas_xxx",
  "canvas_node_id": "node_xxx"
}
```

### 4. 图片上传

```http
POST /api/tools/ultimate-canvas/upload
```

使用 `multipart/form-data`：

- `file`
- `project_id`
- `video_card_id`
- `canvas_document_id`
- `canvas_node_id`

### 5. 图片生成

```http
POST /api/assets/generate
```

用途：

- 文生图
- 图生图
- 高清修复
- 首帧草图
- 尾帧草图

注意：

- 只走 sd2 后端配置好的图片生成能力
- 不传第三方 key
- 成功后要写回 `asset_id`、`reference_image_id`、`workspace_asset_id`、`thumbnail_url`

### 6. 视频生成

```http
POST /api/tasks/create
```

无线画布必须带：

```json
{
  "prompt": "视频描述",
  "project_id": "project_xxx",
  "video_card_id": "card_xxx",
  "client_name": "ultimate_canvas",
  "source_metadata": {
    "source": "ultimate_canvas",
    "canvas_document_id": "canvas_xxx",
    "canvas_node_id": "node_xxx"
  }
}
```

图生视频可带：

```json
{
  "reference_image_ids": ["ref_xxx"]
}
```

首尾帧视频必须使用 provider 可访问的 URL 或已经入库的公开资产，不能传本地文件路径或 blob URL。

### 7. 视频状态轮询

```http
GET /api/video/status/:taskId?refresh=true
```

轮询到终态：

- `succeeded`
- `failed`
- `cancelled`

不要只看创建接口返回。创建成功后必须持续轮询。

### 8. 项目

```http
GET /api/projects
POST /api/projects
PATCH /api/projects/:id
DELETE /api/projects/:id
```

规则：

- 空项目可以删除
- 有任务或图集的项目只能归档
- 默认项目 / 系统项目不能删除
- 没权限的项目不能显示危险动作

### 9. 视频卡

```http
GET /api/projects/:projectId/video-cards
POST /api/projects/:projectId/video-cards
GET /api/video-cards/:id
PATCH /api/video-cards/:id
```

规则：

- 新建视频卡后自动选中
- `sealed` / `archived` / `merged` 不允许继续生成
- 有任务、成本、最终版或分支的视频卡不能硬删，只能归档或废弃

## 允许修改的文件

优先修改：

```text
public/tools/ultimate-canvas/app.js
public/tools/ultimate-canvas/styles.css
public/tools/ultimate-canvas/index.html
public/tools/ultimate-canvas/canvas-engine.js
src/app/api/tools/ultimate-canvas/bootstrap/route.ts
src/app/api/tools/ultimate-canvas/document/route.ts
src/app/api/tools/ultimate-canvas/generate/route.ts
src/app/api/tools/ultimate-canvas/upload/route.ts
```

必要时新增：

```text
src/lib/projects/display.ts
src/lib/video-cards/display.ts
```

只作为参考，默认不要改：

```text
src/components/generate/GeneratePageClient.tsx
src/components/GenerationComposer.tsx
src/app/api/projects/*
src/app/api/tasks/create/route.ts
src/app/api/assets/generate/route.ts
src/app/api/video/status/[id]/route.ts
```

禁止改，除非先单独说明原因并得到确认：

```text
.env
prisma/schema.prisma
package.json
package-lock.json
src/app/admin/integrations/*
src/app/admin/users/*
src/app/admin/costs/*
src/lib/credits/*
src/lib/provider/*
```

## 本地开发注意点

无线画布当前使用相对路径调用 `/api/...`。如果同事在本地跑页面，本地页面会默认调用本地后端；本地没有生产 `.env` 时，不要尝试索要第三方密钥，也不要让他本地重建完整后端。

推荐调试方式：

1. 本地改代码、跑静态语法和构建。
2. API 行为用普通调试账号登录线上 sd2 后直接验证。
3. 需要让本地页面直连线上后端时，先补一个受限 debug base URL / proxy 方案，并且只允许调无线画布接口、生成接口、项目和视频卡接口，不允许开放完整后台 CORS。
4. 如果本地页面无法共享线上登录态，优先用临时预览部署验证，不要把 cookie、token 或 session 写进代码。

## 验收标准

- 普通登录账号可以进入无线画布，不需要 admin。
- 普通账号看不到 `/admin/integrations`、`/admin/users`、`/admin/costs`。
- 项目下拉与普通生成页规则一致。
- 项目前面都有头像。
- 同名项目能看出 owner、类型、任务数、图集数。
- 项目菜单能新建项目、删除空项目、归档有内容项目。
- 视频卡菜单能新建、查看、归档 / 废弃。
- 切换项目 / 视频卡后，画布保存和生成 payload 使用新上下文。
- 文本生成通过 sd2 后端允许的文本模型完成，并写回节点。
- 图片生成通过 sd2 后端允许的图片模型完成，并写回资产和参考图。
- 视频生成通过 sd2 后端默认视频 API 创建任务并轮询到终态。
- 普通账号的生成行为正常消耗自己的测试点数，失败时沿用现有返还逻辑。
- 失败提示保留用户输入和已选素材。
- 不泄露 API Key、cookie、签名 URL、数据库路径。

## 验证命令

```bash
git diff --check
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
npx tsc --noEmit --pretty false
npm run lint
npm run build
```

## 交付要求

同事完成后：

1. 推送 `teammate/ultimate-canvas-complete`。
2. 提供修改摘要。
3. 列出验证命令和结果。
4. 列出是否触发真实 GPT / 图片 / 视频生成。
5. 列出是否消耗点数。
6. 说明没有改动密钥、后台 API 设置、点数核心规则和 provider 适配。
7. 说明普通账号能否完成无线画布文本、图片、视频三类模型调用。

我们合并前：

1. Review diff。
2. 跑全部验证命令。
3. 用普通调试账号验收无线画布页面。
4. 必要时先部署预览或临时分支。
5. 通过后再合入主线并部署生产。

## 给同事 Codex 的建议提示词

```text
你要在 sd2 仓库里补完整无线画布功能。请先阅读 docs/handoffs/ultimate-canvas-codex-api-handoff.md 和 tasks/todo.md 里“无线画布项目 / 视频卡选择器治理规划”。

目标：
1. 无线画布项目和视频卡选择器对齐普通生成页。
2. 项目前面都显示头像，同名项目能区分 owner 和类型。
3. 支持新建项目、删除空项目、归档有内容项目。
4. 支持新建视频卡、查看视频卡、归档/废弃视频卡。
5. 普通登录用户可以使用无线画布，不需要 admin。
6. GPT、图片、视频生成都走 sd2 后端接口，不直接使用第三方 API Key。
7. 本地开发不要重装完整后端；模型、点数、项目、视频卡和资产都连接 sd2 现有后端验证。

禁止：
不要改 .env、API Key、完整后台管理页、点数核心规则、provider 密钥配置、数据库 schema。不要为了调通无线画布给普通用户绕成 admin；应该复用普通生成页的登录、项目、视频卡和点数权限。

完成后推送 teammate/ultimate-canvas-complete 分支，并写清验证结果。
```
