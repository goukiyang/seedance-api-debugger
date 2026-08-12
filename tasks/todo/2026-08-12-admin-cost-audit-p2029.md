# 后台成本审计 P2029 崩溃修复

## 1. 大白话目标复述

后台页面现在出现 `Application error`，日志里的 digest 是 `2635852341`。真实原因是成本审计统计在官方扣费账本数量变多后，一次性把大量账本 ID 塞进 Prisma 查询，触发 SQLite 参数上限，导致 `/admin` 服务端页面崩溃。这次要把这条查询改成稳定的分批查询，确保后台页面不会因为数据量增长直接报错。

## 2. 具体可执行任务

- [x] T1. 补最小回归测试
  - 文件：`scripts/cost-ledger-audit-chunk-smoke.ts`。
  - 完成标准：当前未修复代码下测试失败，能明确指出成本审计不能继续使用一次性大 `in` 查询。
- [x] T2. 修复成本审计查询
  - 文件：`src/lib/costs/audit.ts`。
  - 完成标准：官方扣费账本 ID 按小批次查询分摊数据，避免 Prisma/SQLite 参数上限；不改变统计口径。
- [x] T3. 跑本地验证
  - 命令：新增 smoke、相关 dashboard smoke、`npx tsc --noEmit --pretty false`、`npm run lint`。
  - 完成标准：新增测试通过，类型检查通过，lint 无新增错误。
- [x] T4. 部署并验证线上
  - 命令：`youdoo-sites build sd2`、`youdoo-sites restart sd2`、状态/API/页面检查。
  - 完成标准：公网 `/admin` 不再出现 digest `2635852341` 的服务端崩溃，sd2 服务跨健康周期稳定。

## 3. 验收/审查内容

这些审查项原计划创建独立子 agent 做只读审查；本轮已创建独立审查 agent，但连续等待未返回，已关闭。以下为主线程按同一清单做的只读复核；该结果不是独立审查，可信度低于子 agent。

- [x] R1. 代码验收
  - 检查对象：`src/lib/costs/audit.ts`、`scripts/cost-ledger-audit-chunk-smoke.ts`。
  - 通过标准：成本审计官方扣费分摊查询已分批；没有直接对完整 `officialChargeLedgerIds` 做单次 `ledger_id in` 查询；统计口径未改。
  - 证据来源：源码、smoke 测试输出、TypeScript 检查。
- [x] R2. 线上验收
  - 检查对象：`https://sd2.youdoodesign.com/admin`、`/tmp/youdoo-site-sd2.err.log`、`youdoo-sites status sd2`。
  - 通过标准：后台页面不再返回 Application error；新日志不再出现 digest `2635852341`；服务健康周期内 `runs` 不继续增长。
  - 证据来源：公网请求、服务日志、LaunchAgent 状态。

## 4. 审查内容是否对齐目标

- [x] A1. R1/R2 是否对齐目标
  - 判断：R1 能证明代码不会再触发同类大参数查询；R2 能证明用户实际打开后台页面不再看到该 Application error。
