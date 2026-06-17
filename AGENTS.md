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
- `sd2` 线上构建：`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`
- `sd2` 线上重启：`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2`
- `sd2` 线上状态：`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites status sd2`
- 数据库相关脚本：`npm run db:generate`、`npm run db:push`、`npm run db:studio`，默认不得执行会修改数据库状态的命令

## sd2 线上托管规则

- 当前 `sd2.youdoodesign.com` 生产来源是 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，公网入口经 Cloudflare Tunnel 转到本机 `127.0.0.1:3000`，LaunchAgent 是 `com.youdoo.site.sd2`。
- 线上部署不得直接运行 `NEXT_DIST_DIR=.next-prod npm run build`、`rm -rf .next-prod`、手动覆盖 `.next-prod`，也不得让构建过程直接写 live `.next-prod`。这会在构建期间删除生产构建产物，导致 tunnel 打到 `127.0.0.1:3000` 时出现 `connect refused` / `502`。
- 线上构建必须使用 `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`。该命令应调用 `/Users/gouki-youdoo/.youdoo/runtime/sd2-3000-build.sh`，先构建 `.next-prod-candidate`，验证 `BUILD_ID`、`prerender-manifest.json`、`server/pages-manifest.json` 后，再替换 live `.next-prod`。
- `sd2` 启动必须走 `/Users/gouki-youdoo/.youdoo/runtime/sd2-3000-start.sh`；不得把 LaunchAgent 改回裸 `next start`，除非同时保留生产构建关键文件检查和缺失时的安全构建逻辑。
- 常规恢复优先使用 `youdoo-sites restart sd2` 或 `youdoo-sites heal sd2`；不要把 `launchctl bootout/bootstrap` 当作普通重启方式。确需重载 LaunchAgent 时，重载后必须立即验证 `launchctl print gui/$(id -u)/com.youdoo.site.sd2`、端口监听、本地 health 和公网 health。
- 每次涉及 `sd2` 部署、构建脚本、LaunchAgent、`sites.json` 或公网可见页面改动后，必须验证：
  - `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites status sd2`
  - `curl http://127.0.0.1:3000/api/config`
  - `curl https://sd2.youdoodesign.com/api/config`
  - `curl https://sd2.youdoodesign.com/login`
  - `launchctl print ...` 中 `runs` 没有在健康守护周期内继续增长
- 验证必须至少跨过一个健康守护周期：等待约 70 秒后再次检查 `youdoo-sites status sd2` 和 `runs`。只看到瞬时 200 不算完成。
- 如果公网出现 `502`、Cloudflare 日志出现 `127.0.0.1:3000 connect refused`，先检查 `runs`、`.next-prod/BUILD_ID`、本地 `/api/config` 和 `/tmp/youdoo-sites-health.*.log`；不要先归因 DNS、Cloudflare 或“端口被挤掉”。

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
- 如果当前目标是 `sd2.youdoodesign.com` 或本机 `youdoo-sites` 管理的公开页面，除非用户明确要求“只做本地/只做代码”，否则必须执行 `youdoo-sites build sd2`、`youdoo-sites restart sd2`，再从公网 URL、静态资源、DOM/截图或 API 响应验证新构建已加载。
- 用户反馈线上 `sd2.youdoodesign.com`、当前浏览器页面或已发布页面仍未生效时，必须把线上部署作为任务范围：检查 `.next-prod/BUILD_ID`、执行 `youdoo-sites build sd2` 和 `youdoo-sites restart sd2`，再从公网 URL 验证新静态资源、关键 CSS/JS 文案或页面行为。
- `youdoo-sites status sd2` 只能证明服务健康，不能证明代码已更新；完成线上 UI 修复时必须额外用公网 `_next/static/...` 资源、页面 DOM/截图或 API 响应证明新构建已加载。
- 发现已有未提交改动时，不回滚、不覆盖非本轮产生的变更；若影响本轮任务，应先说明冲突和处理方式。
- 输出汇报时明确列出实际修改文件、验证命令、验证结果、风险与遗留问题。

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
