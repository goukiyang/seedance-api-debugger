# SD2 生产桥「插件错误上报」接口并入发布

## 1. 目标复述

Chrome 插件「SD2 生产桥」出错时要自动上报到 SD2，开发（Claude）能用管理员账号按天读到错误，不再让用户手动导出日志。接口已经写好并本地提交，**本单只负责把它并入现有发布流程并上线**，不改接口行为。用户 gouki 2026-11-01 明确选择「交给 Codex 发布」。

## 2. 具体任务

- [ ] 读交接说明：`docs/handoff-bridge-client-reports-2026-11-01.md`（在 worktree `/Volumes/Data/Projects/video-api-debugger-worktrees/bridge-config-20261031`，分支 `claude/bridge-config-20261031`，提交 `d221c97ad`、`fe8db9108`）。
- [ ] 核对同分支上两个更早且从未部署的提交，一并纳入评估：`c309149e6`（远程配置下发 + 隐私页）、`e667014c9`（浮窗令牌 / `/api/bridge/me` / `/bridge/panel` 页）。bridge 代码此前只在 `codex/*` 分支上，先与现有 `codex/*` 的 bridge 代码对齐，避免重复或冲突。
- [ ] 只新增两个文件：`src/lib/bridge/client-reports.ts`、`src/app/api/bridge/client-reports/route.ts`。复用 `OperationLog`（`action=bridge_client_report`），**不新增表、不做 migration**。
- [ ] 主目录有未提交改动，用独立 worktree 并入，不覆盖他人改动。
- [ ] 按现有流程做类型检查、候选构建、版本/构建一致性、健康与公网可达检查；保留回退点。
- [ ] 部署后验证：未登录 `POST /api/bridge/client-reports` 返回 401；管理员 `GET /api/bridge/client-reports` 返回 `{ok:true,reports:[]}`；普通用户 GET 返回 403。
- [ ] 回执写「已部署，待用户手动验收」，附版本与入口；不把构建成功说成功能验收。

## 3. 验收（用户手验）

- [ ] 用户在装了插件 v0.2.14 的 Chrome 里触发一次已知错误后，管理员 GET 能读到对应记录。
- [ ] 同一错误一天内只有一条；10 分钟内同一用户超过 30 条会被拒（429）。
- [ ] 上报内容里没有聊天文字、没有 token/cookie、没有 data: 图片内容。

## 4. 不做的事

- 不改接口行为、不改数据库结构、不动现有业务路由。
- 不自动浏览器测试或收费测试。

## Git Plan

- 在独立 worktree 并入并推送；主目录里别人的未提交改动保持不动。
- 构建失败或服务异常则保留原运行版本，回执写明原因。
- 上线后通知 gouki，Claude（GPT 抓图线程）随后用管理员账号按天汇总上报。
