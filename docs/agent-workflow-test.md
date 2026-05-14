# Agent Workflow Test

## 1) 当前项目名称

`video-api-debugger`

来源：`package.json` 的 `name` 字段。

## 2) 当前项目技术栈判断

- 应用框架：Next.js `14.2.5`
- UI/runtime：React `^18`、React DOM `^18`
- 语言与类型：TypeScript `^5`、`@types/node`、`@types/react`、`@types/react-dom`
- 数据库与 ORM：Prisma `^5.16.1`、`@prisma/client`
- 脚本运行：`tsx`
- 对象存储/API 相关：AWS S3 SDK、Volcengine TOS SDK、`sharp`、`uuid`、`dotenv`
- 代码质量：ESLint `^8`、`eslint-config-next`

综合判断：这是一个基于 Next.js App Router 形态的 TypeScript 全栈项目，包含 Prisma 数据层、视频/上传存储目录、API 调试与测试脚本。

## 3) 当前主要目录结构

当前根目录可见的主要目录：

- `docs/`：项目文档
- `prisma/`：Prisma schema 与迁移目录
- `public/`：静态资源目录，包含上传与视频子目录
- `scripts/`：工程脚本目录
- `src/`：应用源码目录，包含 `app/`、`components/`、`lib/`、`types/`
- `storage/`：本地视频存储目录

当前还存在构建/平台相关目录：

- `.next/`：Next.js 构建产物目录
- `.vercel/`：Vercel 项目配置目录
- `node_modules/`：依赖安装目录

## 4) package.json 中可用命令

- `npm run dev`：删除 `.next` 后启动 `next dev`
- `npm run build`：执行 `next build`
- `npm run start`：执行 `next start`
- `npm run lint`：执行 `next lint`
- `npm run db:generate`：执行 `prisma generate`
- `npm run db:push`：执行 `prisma db push`
- `npm run db:studio`：执行 `prisma studio`
- `npm run seed:admin`：执行 `tsx scripts/seed-admin.ts`
- `npm run test:api`：执行 `tsx scripts/test-seedance-api.ts`

## 5) 是否存在 AGENTS.md

未发现 `AGENTS.md`。

检查范围：当前仓库文件列表。

备注：本节记录的是首次协作规则测试时的仓库状态；后续已补充 `AGENTS.md`。

## 6) 是否存在 CLAUDE.md

未发现 `CLAUDE.md`。

检查范围：当前仓库文件列表。

备注：本节记录的是首次协作规则测试时的仓库状态；后续已补充 `CLAUDE.md`。

## 7) 建议后续补充哪些工程规则

- 补充 `AGENTS.md`：明确 Codex/其他代理在本仓库中的读写范围、禁止修改项、验证命令、提交规范。
- 补充 `CLAUDE.md`：如继续使用 Claude Code，建议写明与 `AGENTS.md` 一致的项目上下文、任务边界和审查规则。
- 明确环境变量规则：说明 `.env.example` 的维护要求，禁止提交真实密钥。
- 明确数据库变更规则：规定 Prisma schema、migration、`db:generate`、`db:push` 的使用场景。
- 明确测试与验收规则：至少列出 `npm run lint`、`npm run build`、`npm run test:api` 在不同变更类型下的执行要求。
- 明确文件存储规则：说明 `public/uploads/`、`public/videos/`、`storage/videos/` 的用途、可清理策略和是否允许入库。
- 明确 API 调试规则：记录 Seedance/存储服务相关脚本的调用前置条件、限流与成本风险。

## 8) 本次 Hermes → CC → Codex → CC 审查闭环是否跑通

从 Codex 执行侧看，本次闭环已跑通到 Codex 节点：Codex 根据 Hermes/CC 传入的约束，只创建 `docs/agent-workflow-test.md`，并准备通过 `git diff -- docs/agent-workflow-test.md` 验证变更范围。

最终是否完整跑通，需要 CC 在 Codex 返回后继续完成审查确认。建议 CC 核对：

- 是否只有 `docs/agent-workflow-test.md` 发生变更
- 文档是否覆盖 8 个必需章节
- 事实是否仅来自 `package.json` 和当前目录内容
- 是否未额外修改其他文件
