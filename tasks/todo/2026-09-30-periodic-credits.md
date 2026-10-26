# 周期额度模块落地

## 1. 大白话目标复述

用户在用户管理中创建多个独立的周期额度模块，选择岗位或成员，设定金额及小时/天/周/月周期。只刷新周期额度，不清除手工加点，不扰乱已冻结任务。2026-09-30 用户授权落地；功能交用户手动验收，实现后自动部署。不做付费生成，不替用户启用规则或发放点数。

## 2. 具体可执行任务

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| CQ02 | 点数基础修复 | 冻结、账户展示、零额度及来源解析一致 | 已完成实现及发布，待手动验收 |
| CQ03 | 模块与成员规则 | 独立配置、冲突检查、版本与生效时间明确 | 已完成实现及发布，待手动验收 |
| CQ04 | 自动刷新与结算 | 防重复、可补发、跨周期任务正确结算 | 已完成实现及发布，待手动验收 |
| CQ05 | 管理页与用户展示 | 配置、执行记录、余额来源和流水可找回 | 已完成实现及发布，待手动验收 |
| CQ06 | 发布交接 | 构建、备份回退、Git与部署检查完成 | 已完成 |

当前有效源码 `/Users/gouki-youdoo/.codex/worktrees/banana-image-channel/video-api-debugger`，分支 `codex/periodic-credits-20260930`，从线上 7391a07 后的文档提交 cfded4e 开始。点赞收藏候选保留在 `codex/content-reactions-20260930`，不随本次发布。线上已核对版本 0.25.0，本次新功能候选 0.26.0；未发布的其他候选随后需重新定号。

### 已选方案与边界

- 复用 PlatformSetting、CreditBucket、CreditLedger、OperationLog，不新增表、不迁移或覆盖生产数据、不加依赖。规则目录带版本，命令带防重复编号，修改冲突返回明确提示。
- 额度使用独立 bucket，保留既有 daily_quota 来源类型以兼容任务快照，policy_key 标识模块。长期余额与周期额度分开；消耗先用即将到期额度。
- 草稿保存不生效，发布才排期；已启用模块的修改在下期生效，当前额度与任务来源不改。首次启动至少提前一分钟，上海时区；月份按原始日历日对齐并处理月底。
- 默认单用户单模块；发布/恢复检查现有重叠，后续岗位变化导致冲突时停止新发放并记录，不扩大权限。管理员不领周期额度。排除名单优先。
- 新加入、重新加入按下一边界开始。首次发布即登记待生效成员，避免服务停机跨过边界后漏掉本期；历史漏期不累计补发，只补当前有效周期。
- 同一用户同一周期唯一发放键，支持重试；周期人数上限防止意外扩大。独立后台进程分批扫描，记录心跳、部分失败及继续位置；生成/查询余额共享兜底入口。
- 管理用户岗位/状态变化以及新建用户时同步成员归属。退出、禁用、暂停、归档不清当前有效额度，不解冻正在进行任务；不再续发。已被周期模块管理的用户不悄悄回到旧每日额度。
- 保留旧每日额度入口用于未被新模块管理的用户。旧零值继承语义兼容；新设置空值继承，显式0表示不发。旧有效小时仍为有效期，不冒充刷新周期。
- 到期只清未使用部分；冻结部分继续记录。成功按原冻结来源结算；失败仅在原额度尚有效时返还，过期返还关闭并记流水。来源损坏或归属异常停止结算，不误扣长期余额。
- 账户与管理页汇总所有未结算冻结，包括已过期桶；本月消费从本月成功扣费流水计算，不用历史累计字段冒充。
- 首期不自动合并拥有额度余额/冻结或周期归属记录的账号；明确阻止并解释，避免丢失来源或重复领点。归档保留历史，不提供物理删除。
- 主控负责后端规则与集成；Luna XHigh 内部执行线程 Cicero 仅负责 quotas 管理页3个文件，须返回回执，不运行验收或部署。

参考已读取的 [OpenMeter grant 设计](https://openmeter.io/docs/metering/billing/credits) 与 [开源实现](https://github.com/openmeterio/openmeter)：借鉴独立有效期、来源追踪，不引入整套服务或复制代码。无新增媒体附件；参考为本项目既有点数、用户和后台实现。

## 3. 验收/审查内容

按项目现行规则不运行功能验收、浏览器/截图、生成或自动回归，不派独立审核线程。主控核对逻辑、代理回执和发布安全；全部实现完成后统一候选构建及其类型检查。构建成功不等于业务验收通过。

- 发布前检查 schema 未变、候选版本一致、差异无密钥/运行资产；保护线上数据库、上传及视频目录，保留源代码和运行构建回退点。
- 发布后核对服务、后台额度进程心跳、公网版本、登录入口和静态资源；不创建测试规则，不消费点数。
- 用户手动重点验收：角色/指定成员/排除名单；新增与改版生效时间；0额度；多模块冲突；暂停恢复；月底周期；跨期任务成功/失败；重试不重复；所有生成入口共用余额；会员禁用/重新加入；执行记录与个人余额一致。

## 4. 审查内容是否对齐目标

本轮目标为可配置的后台额度模块及完整结算接入，不只是页面按钮。发布检查只证明可部署与新产物到位，实际发放与页面操作交用户手动确认。

### 回退边界与剩余风险

新规则启用后，旧0.25版不理解“周期模块已接管”标记及显式零值，不得直接长期回退旧点数逻辑。需要回退时先停止新增发放进程并保留数据库，以兼容修复版恢复；不能把旧数据库覆盖回线上。首发失败、尚无规则/新策略写入时可以还原原构建。批量成员发布处于单事务，超过上限会明确拒绝；持续执行失败要在运行记录处理，不把心跳当发放成功。

### 发布回执

- Luna XHigh 的管理页回执已收，主控复核并修正待生效版本与草稿区分、补发重试计数提示。另补月度配置变更保留原始日历锚点，避免二月后刷新日漂移。
- 统一类型检查首轮发现流水名称重复，集中修复后通过；日历修正随最终候选构建再统一检查。尚未执行功能验收、浏览器或付费调用。
- 已部署 **v0.26.0**，入口：用户管理 → 周期额度，https://sd2.youdooart.com/admin/users/quotas 。代码 `cb9f66dd4dcabc07609a2d40e62d459dc8db315c`，BUILD_ID `q9e8iznlVsvzuC1GfjnnV`。
- `npx tsc --noEmit`、`git diff --cached --check`、发布脚本 `bash -n`、服务器候选 `NEXT_DIST_DIR=.next-prod-candidate npm run build` 及内置检查通过。候选与线上 schema 完全相同；本次无迁移、依赖变动、规则启用或付费生成。
- 四服务 active：sd2-gray、sd2-image-studio、sd2-template-prompts、sd2-periodic-credits。新进程心跳 `2026-09-30T06:05:49.136Z`，规则目录数量0，确认未替用户配置发放。
- 公网 release=0.26.0，公网 config/login 及源站 config=200，X-SD2-Origin=server-42-193。管理页匿名请求307到本站登录，未操作登录页面；该检查只证明受保护入口可达，不冒充功能验收。
- 新页面 JS `page-ae95f44ff0142f46.js` 和 CSS `97b79046018e19e9.css` 公网200，JS包含周期额度接口及发布控件。版本提醒沿用现有 ReleaseNotice：数字版本比较、稍后去重、账户页手动检查、刷新确认；本轮仅源码核对，未执行浏览器验收。
- 分支和回退 tag `rollback/2026-09-30-before-periodic-credits` 已推远端并核对；tag指向7391a07/v0.25.0。服务器备份 `/srv/video-api-debugger/backups/periodic-credits-cb9f66dd4dcabc07609a2d40e62d459dc8db315c` 保存 source、live-build、build.db和pre-switch.db；两份数据库备份完整性检查ok，未覆盖生产库。切换保护已核对上传/视频/storage持久目录。
- [统一代码差异](https://github.com/goukiyang/seedance-api-debugger/compare/7391a07e982dc21edf702c5bcf793868a0f484af...cb9f66dd4dcabc07609a2d40e62d459dc8db315c)。仅本轮点数模块，不包含另分支点赞收藏。

### 文件回执

- `src/lib/credits/periodic-types.ts`：周期、月底、适用对象及不可变周期快照；`periodic.ts`：配置版本、成员归属、防重复发放、冲突、日志、后台心跳；`policy.ts`：统一冻结/结算、过期来源保护、零额度语义与余额汇总。
- `src/app/admin/users/quotas/{page.tsx,QuotaManager.tsx,quotas.module.css}`：管理员入口、规则草稿/发布/暂停/恢复/归档、名单分页、执行记录和重试；`src/app/api/admin/credits/periodic/route.ts`：管理员限定接口、请求来源检查和安全错误。
- `src/app/admin/users/AdminUsersClient.tsx`：新入口与旧策略说明、空值/零值区分；`src/app/api/admin/users/route.ts`：跨期冻结展示；`[id]/route.ts`、`[id]/disable/route.ts`、`[id]/enable/route.ts`、`bulk-profile/route.ts`：成员资格同步；`merge/route.ts`：有周期归属的账号禁止自动合并。
- `src/app/account/page.tsx`、`src/app/api/me/credits/route.ts`：个人余额来源与下次刷新；`src/app/admin/points/{page.tsx,AdminPointsClient.tsx}`：全量冻结、本月流水、周期额度筛选。
- `src/lib/image-studio/tasks.ts`、`src/lib/tools/toolflow-runtime.ts`、`src/lib/tasks/seedance-draft-upgrade.ts`：为冻结/结算流水补来源字段，不改生成参数、价格或Provider。
- `scripts/process-periodic-credits.ts`、`scripts/sd2-periodic-credits.service`：后台分批刷新与服务配置；`package.json`、`package-lock.json`、`src/lib/release.ts`：版本和更新摘要，无依赖新增；`.gitignore`、`tsconfig.json`：隔离候选构建；`tasks/todo.md`及本子计划、hygiene-log：任务与回执。

守门员：本次触及用户点数及管理权限边界，按用户明确实现授权处理；未扩大访问权限，未启用实际发放，无生产数据覆盖。功能手验尚未完成；暂停/归档不恢复旧每日策略、受管账号合并限制及回退兼容边界继续有效。无分级误判。
