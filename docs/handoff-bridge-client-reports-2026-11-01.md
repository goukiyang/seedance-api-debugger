# 交接：SD2 生产桥「插件错误上报」接口（交 Codex 并入发布）

**状态**：v0.123.0 已部署，待用户手动验收；2026-11-01T01:57:43Z 公网收口。运行源码 `74d55961a91369996257043c5262a9f3bd5be602`，BUILD `eR2ihrtuj-7sSeQDLx8pW`。原 d221c97ad/fe8db9108 为输入，实际发布分支 `codex/save500-sunburst-20261031`。

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

## Codex 最终交接（2026-11-01）

仅合入 report 两业务文件，按原工单隐私要求补服务端白名单脱敏；原route接口字节保持，无表/migration、无插件改动。实际producer协议与kind指纹前缀兼容。更早c309149e6/e667014c9已评估，无必要依赖，远程配置/panel/token权限未并入本批。

完整Linux Next（含types/lint）、定向lint/完整tsc通过；部署7服务/4timer正常，7静态资源200+SHA相同，公网匿名GET与空POST均401。隔离真实route的admin200/普通403工程通过；真实登录角色GET和插件实际收报仍待用户手验，没有生产报告试写、浏览器验收或伪造session。接口404/401暂停6小时为插件既有合同，未改插件或外发通知。

回退入口与完整原证见正式根私有 `docs/materials/2026-10-31-save500-sunburst/implementation/release/attempt02/{deployment-result.json,guard-restore.md}`。固定相容guard为88f57e096c02a649b60b9788d469e5a0dadde68c / v0.122.0+safe-retry-guard.1；仅回程序，不回当前配置/DB/账本/媒体/回执。源码已聚焦推送，功能结论仍待手验。
