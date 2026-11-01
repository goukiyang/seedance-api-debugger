# 交接：SD2 生产桥「插件错误上报」接口（交 Codex 并入发布）

**状态**：已写好并本地提交，未部署；用户（gouki）2026-11-01 选择「交给 Codex 发布」。

## 位置
- 仓库：/Volumes/Data/Projects/video-api-debugger
- worktree：/Volumes/Data/Projects/video-api-debugger-worktrees/bridge-config-20261031
- 分支：claude/bridge-config-20261031
- 提交：d221c97ad feat(bridge): 插件出错自动上报接口 /api/bridge/client-reports
  （同分支更早的 c309149e6 远程配置、e667014c9 浮窗令牌/panel 页面也未部署）
- 注意：该 worktree 的 .git 指向旧会话路径，用 git 需
  `GIT_DIR=<主仓>/.git/worktrees/bridge-config-20261031 GIT_WORK_TREE=$PWD`；主仓 codex/* 分支上有 bridge 代码，合并时先对一下。

## 新增文件（仅这两个）
- src/lib/bridge/client-reports.ts
- src/app/api/bridge/client-reports/route.ts

## 行为
- POST /api/bridge/client-reports：登录用户（session cookie）上报；同用户同 fingerprint 每天一条；10 分钟 30 条限频；单条 ≤48KB；服务端再脱敏。
- GET /api/bridge/client-reports?since=ISO&limit=50&kind=前缀：仅 admin。
- 存储复用 OperationLog（action = bridge_client_report，target_type = BridgeClient，target_id = fingerprint，detail = JSON）。**不新增表、无 migration。**

## 上线检查
1. tsc：本分支新文件无类型错误（其余报错是缺 recharts/@dnd-kit 依赖，与本改动无关）。
2. 部署后：未登录 POST 应 401；admin GET 应 200 {ok:true,reports:[]}。
3. 插件端（v0.2.14，分支 cc/gpt-image-capture）接口 404/401 时会暂停上报 6 小时，上线后最多 6 小时内恢复。
4. 上线后请通知 gouki / 我，我用 admin 账号按天汇总上报。
