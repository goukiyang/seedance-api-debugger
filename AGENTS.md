# AGENTS.md

## 项目身份

- 项目名称：video-api-debugger
- 项目类型：用于调试视频生成接口、任务状态、资产上传、用户点数与后台管理流程的 Next.js 应用
- 技术栈：Next.js 14 + React 18 + TypeScript + Prisma + SQLite
- 默认协作链路：Hermes 派单与边界定义 -> Claude Code 只读分析与审查 -> Codex 按边界执行文件修改

## 主要目录结构

- `src/app/`：Next.js App Router 页面、布局、API Routes 与 `middleware`
- `src/app/api/`：服务端接口，包括鉴权、点数、后台用户、视频任务、资产、工作区等路由
- `src/components/`：前端交互组件与生成器工作区相关 UI
- `src/lib/`：数据库、鉴权、Provider、价格、任务状态、资产与工作区等共享逻辑
- `src/lib/auth/`：登录态、密码与 API 鉴权辅助逻辑
- `src/lib/provider/`：外部视频/资产 Provider 适配相关逻辑
- `src/lib/assets/`：资产归一化、集合、工作区、快照与仓储逻辑
- `src/types/`：项目共享 TypeScript 类型
- `prisma/`：Prisma schema、迁移与 SQLite 数据模型
- `scripts/`：管理员种子脚本和外部 API 测试脚本
- `docs/`：工程协作、任务模板、执行记录等文档
- 根目录配置：`package.json`、`tsconfig.json`、`next.config.js`、`README.md`、`SPEC.md`

## 常用命令

- `lint`：`npm run lint`
- `typecheck`：当前未发现独立脚本
- `test`：当前未发现通用测试脚本；仅发现 `npm run test:api`，该脚本面向 Seedance 外部接口调试，不应默认作为本地回归测试执行
- `build`：`npm run build`
- `sd2` 服务器状态：`ssh gouki@42.193.221.253 'systemctl is-active sd2-gray.service && curl -sS http://127.0.0.1:3302/api/config'`
- `sd2` 公网验证：`curl -sS -D - https://sd2.youdooart.com/api/config -o /tmp/sd2-public-config.json`
- `sd2` 服务器部署：按本文件“sd2 服务器生产托管规则”执行本地提交、归档上传、候选构建、服务重启、公网验证和回滚保护；不再用 Mac `youdoo-sites` 当生产部署链路
- 数据库相关脚本：`npm run db:generate`、`npm run db:push`、`npm run db:studio`，默认不得执行会修改数据库状态的命令

## sd2 服务器生产托管规则

- 当前正式生产入口是 `https://sd2.youdooart.com`，长期使用腾讯云 Ubuntu 服务器版。旧 `sd2.youdoodesign.com` / Mac 本地 Cloudflare Tunnel 入口不再作为生产入口；除非用户明确要求回滚或排查旧入口，不得重启 Mac 本地 `sd2` 当作恢复手段。
- 用户未明确指定其他站点时，本项目所有页面查看、问题排查、代码修改、配置核对、登录回调、部署验证、截图验收和 API 验证，默认目标一律是 `https://sd2.youdooart.com/`。App 浏览器、Chrome、日志或历史记录里出现 `sd2.youdoodesign.com`，只能当作旧 tab/旧入口背景，不得自动切回 design 域名继续修改或验收。
- 不得在 `sd2.youdoodesign.com`、design 域名、Mac 本地 Cloudflare Tunnel 或旧 `trycloudflare` 链路上做默认修改、默认部署、默认验证或默认排查。唯一例外是用户明确要求“旧入口 / design 域名 / 回滚 / 迁移核对”时，才可只读确认旧入口状态，并且不得把它的结果当成 `sd2.youdooart.com` 生产结论。
- `sd2.youdooart.com` 必须直接打开服务器网站，不得用跳转临时代替。飞书 OAuth、回调地址、登录后跳转地址和前端公开域名配置都必须以 `sd2.youdooart.com` 为准；登录后跳回旧域名时，按配置错误处理。
- 服务器默认是 `42.193.221.253:22`，普通操作用户 `gouki`；线上 nginx 反代到 `127.0.0.1:3302`，systemd 服务名 `sd2-gray.service`，服务器应用目录 `/srv/video-api-debugger/app`，公网响应应能看到 `X-SD2-Origin: server-42-193` 这类服务器来源标记。
- 本地部署源默认是 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，当前生产工作分支是 `codex/video-delivery-fast-path`。服务器目录里的 `.git` 不作为可信部署来源；不要默认在服务器上 `git pull`。
- 服务器部署必须按 `server-deploy-closure` 思路执行：本地形成可追溯 commit / rollback tag -> 用 `git archive` 打包当前提交 -> 上传到服务器 `/tmp` -> 解压到 `/srv/video-api-debugger/releases/<commit>` -> `rsync -a --delete` 到 `/srv/video-api-debugger/app` -> 执行 `scripts/server-ensure-runtime-dirs.sh /srv/video-api-debugger/app` 或等价命令，把 `public/uploads`、`public/videos`、`storage` 迁移并软链接到 `/var/lib/video-api-debugger` 下的持久运行目录，同时确认运行目录权限和 `gouki` 对应用根目录的候选构建写权限。
- 上传或同步服务器源码时必须排除 `.env`、`node_modules`、`.next`、`.next-prod`、`storage`、`public/uploads`、`public/videos`、数据库文件、上传资产、视频、截图和其他运行期产物，避免覆盖密钥、现有视频、截图、用户上传和生产构建。
- 每次同步服务器源码后必须确认 `public/uploads`、`public/videos`、`storage` 是指向 `/var/lib/video-api-debugger` 的软链接，并确认 `public/uploads/assets`、`public/uploads/thumbs`、`public/videos/thumbnails`、`storage/backups` 存在且 `gouki` 可写；否则发布同步可能清空历史视频/封面，或让缩略图接口、上传、视频封面补偿和备份脚本在运行时失败。
- `sd2-gray.service` 使用 `NEXT_DIST_DIR=.next-prod`。普通 `npm run build` 只会更新 `.next`，不代表线上生效；服务器生产构建必须用 `NEXT_DIST_DIR=.next-prod-candidate npm run build`，验证 `BUILD_ID` 和预期变更后，再把 `.next-prod-candidate` 切换成 `.next-prod`。
- 不得直接删除或原地构建 live `.next-prod`。切换前保留 `.next-prod-prev` 或等价回退目录；候选构建失败、候选内容不含预期变更、重启失败或公网仍是旧版本时，必须恢复上一版并停止报告。
- 每次涉及 `sd2` 服务器部署、登录域名、nginx、systemd、构建目录、公开 API、用户可见页面或静态资源改动后，至少验证：
  - `ssh gouki@42.193.221.253 'systemctl is-active sd2-gray.service'`
  - `ssh gouki@42.193.221.253 'cd /srv/video-api-debugger/app && cat .next-prod/BUILD_ID'`
  - `ssh gouki@42.193.221.253 'curl -sS -D - http://127.0.0.1:3302/api/config -o /tmp/sd2-local-config.json'`
  - `curl -sS -D - https://sd2.youdooart.com/api/config -o /tmp/sd2-public-config.json`
  - `curl -sS -D - https://sd2.youdooart.com/login -o /tmp/sd2-login.html`
  - 前端改动还要验证公网 `_next/static/...` 资源、页面 DOM、截图或真实登录页面已加载新构建
- `sd2.youdoodesign.com` 的状态只能用于确认旧入口已停用或迁移，不得把它的健康状态当成当前服务器生产站结论。以后排查“线上没生效 / 无法登录 / 生成失败 / 视频下载失败”时，默认先查服务器链路、`sd2-gray.service`、`127.0.0.1:3302` 和 `sd2.youdooart.com`。

## UI 规则

- 所有生成记录列表、任务记录列表、产出记录列表、项目内生成列表和视频卡生成列表，最左侧第一列必须是视频截图/缩略图。
- 生成记录列表不得让提示词、日期、状态、项目名或成本信息直接顶到最左侧；视觉扫描入口必须先看到对应视频画面。
- 视频截图优先使用任务缩略图、首帧、本地视频截图或已有产出预览图；没有可用截图时，也必须保留尺寸稳定的缩略图占位，并明确表现为“暂无截图/预览不可用”，避免列表布局跳动。
- 该规则适用于 `/admin` 最近生成记录、`/admin/outputs`、`/tasks`、项目详情、视频卡详情以及后续新增的任何生成记录列表；如果确需例外，必须先得到用户明确确认。
- 界面中凡是展示用户、成员、创建者、生成者、管理员、操作人等人物姓名，姓名左侧必须显示头像；真实头像缺失时使用稳定首字母/颜色头像占位，避免只展示纯文字姓名。

## Codex 默认职责

- 在 Hermes 明确任务边界后，按允许修改范围执行代码或文档修改。
- 修改前读取必要上下文，优先遵循项目既有目录、命名、技术栈与实现风格。
- 做本项目的新功能或模块时，先查项目内现有实现和成熟开源模块/组件/SDK/模板；能复用就优先复用或少量适配。复用前必须核对许可证、维护状态、依赖体积、安全风险、和当前 Next.js/React/Prisma 技术栈及本项目 UI 风格是否匹配，避免为了省事引入不必要的大包或不可控代码。
- 对高风险区域保持最小改动原则，必要时先要求 Claude Code 或用户补充只读分析。
- 每次只处理当前任务，不顺手重构、不扩大范围、不隐式改变业务规则。
- 修改后执行任务要求的验证命令；如命令缺失、环境缺失或用户明确禁止执行，应在汇报中如实说明。
- 完成任何用户可见页面、UI、样式或交互改动后，默认完成标准是刷新当前目标页面即可看到新效果；不能只停在本地代码、构建、Git 提交或远端可见。
- 如果当前目标是 `sd2.youdooart.com` 或服务器版 `sd2`，除非用户明确要求“只做本地/只做代码”，否则必须按“sd2 服务器生产托管规则”完成服务器候选构建、`sd2-gray.service` 重启、公网 URL、静态资源、DOM/截图或 API 响应验证。
- 用户反馈线上 `sd2.youdooart.com`、当前浏览器页面或已发布页面仍未生效时，必须把服务器部署作为任务范围：检查服务器 `/srv/video-api-debugger/app/.next-prod/BUILD_ID`、`sd2-gray.service`、`127.0.0.1:3302`、nginx 和公网 `https://sd2.youdooart.com`，不要回到 Mac `youdoo-sites` 链路。
- `systemctl is-active sd2-gray.service` 只能证明服务进程健康，不能证明代码已更新；完成线上 UI 修复时必须额外用公网 `_next/static/...` 资源、页面 DOM/截图或 API 响应证明新构建已加载。
- 发现已有未提交改动时，不回滚、不覆盖非本轮产生的变更；若影响本轮任务，应先说明冲突和处理方式。
- 输出汇报时明确列出实际修改文件、验证命令、验证结果、风险与遗留问题。

## 固定审核线程规则

- 本项目固定审核线程为 `审核001 - sd2 固定只读审查`，thread id：`019f44c6-64d3-7753-acd0-f31fc16763fb`。
- 后续所有审查、审核、验收、只读复查、目标对齐检查任务，统一交给该审核线程处理；当前执行线程只负责实现、修复和协调，不把自测结果冒充独立审核。
- 审核线程默认审查实际生产工作树 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，除非工单明确指定其他路径。
- 审核线程严格只读：不得修改源码、配置、数据库、构建产物、生产数据，不得提交 Git、推送、打 tag、部署或补实现。
- 审核过程中发现的问题，统一记录到固定文档 `tasks/audit-001-review.md`；该文档是审核记录唯一允许写入的项目文件，记录只追加审核发现，不做实现修复。
- 每条审核记录必须写清：日期、审查对象、结论（通过/不通过）、阻塞问题、非阻塞风险、证据、建议下一步。
- 审核完成后，审核线程必须回到发起线程同步结果，固定收尾语为：`审核完成，等待推进`。同步内容必须包含通过/不通过、证据、缺口和下一步。

## Codex 禁止事项

- 未经明确授权，不得修改 `src/**`、`prisma/**`、`package.json`、`package-lock.json`、`tsconfig.json`、`.env`、`public/**`、`storage/**`、`.next/**`、`.vercel/**`。
- 不得安装依赖、升级依赖、删除依赖或改动锁文件，除非任务明确要求。
- 不得执行数据库写入、迁移、`db:push`、种子脚本或会改变本地/远端数据的命令，除非任务明确要求。
- 不得修改点数、登录、权限、支付、鉴权、中间件、Provider 适配、上传、外链拉取等高风险业务逻辑，除非任务明确要求且边界清晰。
- 完成实现和验证后，默认自动形成聚焦提交、上传到已配置 remote，并按全局规则登记版本；如果当前分支、主分支策略或风险边界不适合直接推送，默认新建任务分支、worktree、草稿 PR 或隔离发布通道，而不是让改动停留在本地未成版本状态。
- Git 上传不需要用户二次确认：任务完成验证且存在已配置 remote 时，默认自动 commit、push、创建必要 rollback tag、远端复核和版本登记；只有没有 remote、认证/网络/验证失败、疑似敏感文件、会覆盖他人改动或需要破坏性 Git 操作时才暂停报告。
- 用户说“上传 Git / 做 git / 形成版本 / 方便回退”时，完成标准是远端可回档：对应 commit 必须推送到 remote，稳定回退点必须创建并推送语义清晰的 rollback tag 或等价保护分支，并用 `git status --short --branch`、`git ls-remote --heads`、必要时 `git ls-remote --tags` 验证远端可见。
- 禁止自动 force push、删除远程分支、覆盖用户提交、破坏性发布或不可回滚部署；这些操作必须得到用户明确确认。
- 不得读取、打印、复制或泄露 `.env`、密钥、token、cookie、数据库凭据等敏感信息。
- 不得把 Claude Code 的只读分析结论扩展成未经确认的事实；不确定时应标注为推断。

## 每次完成后的汇报格式

1. 改了哪些文件：
   - 列出实际修改的文件路径。
2. 每个文件具体写了什么：
   - 简述每个文件新增或修改的核心内容。
3. 跑了哪些验证命令：
   - 列出命令原文。
4. 验证是否通过：
   - 说明通过、失败或未执行原因。
5. 是否存在越界或风险：
   - 明确说明是否改出任务边界，是否触及高风险区域。
6. 遗留问题与下一步建议：
   - 如无则写“无”。
7. 统一 diff：
   - 提供本轮允许范围内文件的 `git diff`。
