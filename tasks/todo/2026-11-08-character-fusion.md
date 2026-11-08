# 角色融合提示词

日期：2026-11-07（洛杉矶）；状态：实施中，用户手验；版本：计划 0.135.0。

## 目标与来源

在 sd2「工具」增加 `/tools/character-fusion`，复用站内外壳，按 gouki 原型的八维卡片、Boss、三态规则、本地词库、批量提示词与高级融合落地。原型原件为正式根 `docs/materials/2026-11-08-character-fusion-prototype/prototype.html`，来源 https://fusion-character-prompt-lab.goukiyang.chatgpt.site/ 。独立原型导航不移植。

## 基线与 Git Plan

开工线上实读：2266d7d8098acf531a87940929fb6263a9876444 / v0.134.29 / q6NJi504KhO7IJgAleb9f，sd2-gray 实际cwd与公网 `/api/release`匹配。远端 main 2bf3为旧线，不作为发布源；最新正式角色分支 ee7f485仅后续记录，实际程序2266。主目录旧分支 codex/mediakit-video-enhance 的已有脏改保留。

任务分支 `codex/character-fusion-20261108`，隔离目录 `/Volumes/Data/Projects/video-api-debugger-worktrees/character-fusion-20261108`，从2266创建。提交只含本单文件，推已核对 origin `goukiyang/seedance-api-debugger`。发布前重新核对其它任务最新正式增量，必要合入，禁止覆盖。

## 范围与结构判断

- 本地纯规则生成，不调用模型；每轮¥0；批量source分散后再重复，名称去重。
- 复用已有 UserPreference(user_id,key)，每个配方独立 `character_fusion_recipe_v1:<uuid>`；API只用getSessionUser取得本人id，不接收owner，不使用角色管理员豁免。保存原id可重试；改名/删除按revision避免旧页面覆盖；无需DDL、历史迁移或改共享偏好。
- 导航只加入口和顶栏匹配。配方页是本工具内部页签。
- 出图两页没有通用纯提示词接收入口：按用户授权降级为复制选中提示词并打开 `/template-studio?type=image` 或 `/tools/character-lab`，用户粘贴，不提交。无修改生成链、鉴权、Provider、点数、上传或既有图像/角色/多视图数据。
- 拖拽使用卡片手柄；常显“加入融合台”及原生select等价，手机两列Boss/单列规则，不使用宽表。

## 执行清单

- [x] 核对线上源、远端、工作区与原型，隔离任务分支。
- [x] 提取原型词库与本地规则引擎。
- [x] 页面、Boss、规则、批量清单、复制导出、高级融合与配方CRUD实现。
- [ ] 完整类型检查、lint、构建及最小规则检查通过。
- [ ] 对本单范围只读复核，确认私有配方过滤与所有生成出口无提交。
- [ ] 聚焦提交推送，按现有保护流程发布并核对公网可达。
- [ ] 用户手验：Boss锁定与移除/加入、必须/排除、16条分散去重、复制/单维替换/重写/高级、配方刷新/换账号隔离、小屏操作及两个出图入口。

## 验证与边界

风险按局部新增工具与本人持久配方处理。最小可运行纯函数脚本 `node_modules/.bin/tsx scripts/check-character-fusion.ts` 覆盖排除、必须覆盖、锁定、领域分散与去重、配方往返和只换一项保留其它字段；不访问网络或数据库。类型 `tsc --noEmit --incremental false`，lint `npm run lint`，构建沿候选完整Next和原内置检查。配方权限由服务端user_id限定并复核源码，不在真实网站上创建/提交任务，也不自动浏览器或收费测试。公网匿名重定向仅证明登录保护，不冒登录后功能验收。

## 回执与 Review

进行中。首轮纯函数检查有一条fixture错误地要求可选必须项每行都出现；合同为每轮至少一次，已修断言，原日志 `/private/tmp/sd2-fusion-rule-check.log` 保留后续实际结果。无新增范围外项目缺陷。
