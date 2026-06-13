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
- 数据库相关脚本：`npm run db:generate`、`npm run db:push`、`npm run db:studio`，默认不得执行会修改数据库状态的命令

## Codex 默认职责

- 在 Hermes 明确任务边界后，按允许修改范围执行代码或文档修改。
- 修改前读取必要上下文，优先遵循项目既有目录、命名、技术栈与实现风格。
- 对高风险区域保持最小改动原则，必要时先要求 Claude Code 或用户补充只读分析。
- 每次只处理当前任务，不顺手重构、不扩大范围、不隐式改变业务规则。
- 修改后执行任务要求的验证命令；如命令缺失、环境缺失或用户明确禁止执行，应在汇报中如实说明。
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
