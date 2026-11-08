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


### 工程进展

- 本地纯函数最终检查已通过，32个固定种子的批次，含English内置词汇检查。初轮fixture误判已纠正；后续检测到单维替换给未选可选维度添加undefined键，已改为保留原detail对象键并仅删除实际清空项。
- 初始功能提交e14ae975b，迭代与英语检查提交687499d07；尚未推送和部署。工具版本0.135.0。
- 本机CodeGraph准备入口针对本工作区执行，索引命令240秒超时；未使用旧索引冒成功，沿实际源码定向复核导航、鉴权、UserPreference及出图两页URL白名单。
- 源码复核：页面及API均有登录与有效账号门；API GET/POST全部用会话user.id限定UserPreference，客户端无owner请求参数，服务端不接收跨账号目标；rename/delete保revision，save原UUID重试不覆盖不同设置。CSV转义公式开头；无模型、生成提交、图片上传、点数或Provider写入。
- 标签规则调整后保留已有清单原组合，并提示重新生成，这是原型行为。手动换卡会锁定，随机刷新保锁，移除后清该锁。


### 正式30整合与类型修正

2026-11-07 23:28（洛杉矶）正式更新至179f267043dc27580400f403c18f93213fdf74bd / v0.134.30 / h-oDly_LBDBj_eojlNFNQ，已核实际服务cwd和公网release。将此已发布增量合入本任务；仅package版本和更新标题发生冲突，保0.135.0角色融合标题，上传稳定性源码与其todo原记录完整保留，未改其实现。原attempt01在native阶段主动停止，尚未完整Next且无生产变动，原证保留，不冒失败后已通过。

完整tsc发现配方接口局部变量settings缺少显式类型，已补FusionSettings | undefined；最终新基线候选完整构建将再次包含类型与lint检查，不沿旧未通过结果冒完成。


### 最终候选工程与窗口协调

- df8dc4ac09d34e3301f06490a12b1734abab7e2b为已继承正式30的应用候选，15个本单文件；本机完整lint exit0，新增文件无警告，原img/hook警告保留。Linux attempt02独立`tsc --noEmit --incremental false` exit0，原类型缺失已修；同源最小规则检查通过，正在fresh native与完整Next。
- 2号角色三栏布局此前与3/15持有构建/切版窗口，本单未持生产写窗、未停服，已在内部说明179f来自7号并确认尊重既定窗口。计划等其正式交付后继承最新源再发布本单，未把离线构建当生产已上线。


本单attempt02在native阶段主动停止，未跑重复Next、未占服务器Next内存，保留已完成的32种子规则及完整类型证据；按已存在的31窗口交接。等待期间只补本工具反馈条在滚动后仍可见，以及保存中禁止重复打开新保存表单，避免错误提示在页首不可见或迟到回执关闭新表单；最终候选构建会包含这些字节。
