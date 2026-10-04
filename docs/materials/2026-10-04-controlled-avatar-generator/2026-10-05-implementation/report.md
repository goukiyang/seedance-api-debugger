# 人物生成器 P1-P5 交付证据

补正：本文件保存0.41.0实际发布的历史证据。监督核对确认P3原标准包含本人video_task及无Asset reference_image，不能以旧接口无撤销缩减范围；P3继续为进行中，接续0.41.1补齐，其他已部署成果保留。下文Asset-only边界是当时缺项，不是用户批准的最终限界。本次归类误判已记录全局复盘。

最新结果：0.41.1已补齐P3并部署，工程检查完成、待用户手动验收；最终对账与证据入口见[0.41.1补齐报告](patch-0.41.1/report.md)及同目录delivery.json。本段不改变下方0.41.0历史发布事实。

结论：0.41.0 已部署到 https://sd2.youdooart.com，待用户手动验收。工程发布检查通过，不代表人物语义、同脸效果、页面交互或功能验收通过。

## 固定对账

| 编号 | 任务 | 完成标准 | 实际状态 |
| --- | --- | --- | --- |
| P1 | 人物生成工具 | 方案D、受控随机、人物/配置/历史及真实出图接通 | 实现并部署；真实收费出图和语义效果待用户主动操作验收 |
| P2 | 与现有系统嫁接 | 工具和参考区入口可达，选图返回原任务，不重复生成 | 实现并部署；入口、草稿保护和回填流程未执行功能验收 |
| P3 | 导入窗口删除素材 | 素材下方可删除，有权限限制和误删保护 | 本人 Asset 素材的安全隐藏、确认、撤销已部署；非 Asset 条目不提供删除，具体差异见下文 |
| P4 | 提交与上线 | 候选构建、回退保护及公网发布检查完成，待手动验收 | 工程发布检查完成；分支、发布标签、回退标签远端可见 |
| P5 | 生成图片恢复设置交互 | 图片单击只显示选中边框；悬停时图下方显示恢复按钮，点击按钮才恢复设置 | 实现并部署；实际鼠标、键盘及完整恢复流程待用户手动验收 |

本轮没有浏览器操作、截图、业务 API 功能测试、自动回归、收费生成、生产素材删除或审核线程。恢复后原 worker 树已关闭，按可用工具容量由 lead 单线完成整合和发布，未新建侧栏任务。

## A1-A7 覆盖

| 契约 | 落地内容 | 证据与未验部分 |
| --- | --- | --- |
| A1 | 描述约束、字段来源、独立 locked/manualLock、排除条件、冲突及三对象类型 | `src/lib/avatar-random/types.ts`、`engine.ts`；明确条件需有原文证据，未知/冲突阻止出图。不以关键词规则冒充任意自然语言准确解析 |
| A2 | 关联抽样、办公/儿童/秃头/年龄规则、记忆点预算、Seed与规则版本；批次随机身份去重和历史组合避让；六类局部重抽 | 每个候选独立 DNA，1/2/4 候选不是同 Prompt 的 count=4；固定项不参与随机差异，条件不足时明确拒绝伪造不同人物；单次微调只改目标字段，不能顺便改人数或描述。多人2/3/4已接入。未做图像差异验收 |
| A3 | DNA -> 标准描述 -> GPT/Gemini模型适配；内部弱背景默认、明确背景覆盖；Prompt可复制 | `engine.ts`。切换模型不重新随机 DNA。图片模型Seed不受支持时如实标为不可复现，不承诺同脸100% |
| A4 | Configuration规则与版本、Character身份和稳定基准、Generation不可变任务快照；最近3配置、命名、保存/编辑/另存/复制、删除和撤销、历史分页、收藏和符合度人工标记 | 复用按账号分区的 PlatformSetting，无 schema 迁移；收藏复用现有 Asset ContentReactions。历史恢复保留模型、质量、分辨率、画幅、原参考图、规则、锁和人物，不改写历史或当前基准，不创建任务扣费 |
| A5 | 独立DNA/Prompt/task接入既有图片队列、冻结点数、已有资产落地；整批确认报价；部分成功、明确失败重试、未知受理不重投 | `submitStudioBatch`请求指纹、事务内外重复检查，任务和冻结原子提交，已存在任务不会再次冻结。新人物任务不继承模板、通用上下文、固定图和风格组。图片自动进现有我的素材，不需额外保存人物。未实际收费调用 |
| A6 | 方案D、工具菜单/侧栏、ComposerTopbar及GeneratePageClient独立视频/IP导航；参考区fullpage工具入口；草稿、账号、模块、槽位、容量、版本、工作现场保护 | 复用现有生成资格，抠图仍 adminOnly；明确“使用这张并返回”才处理单图。目标变化、容量满和来路失效不覆盖；没有自动生成视频。图片本地草稿使用持久receipt + server claimToken + ack/CAS，详见下文 |
| A7 | 单次MINOR0.41.0；更新摘要覆盖人物入口、撤销删除、图片恢复交互；沿用现有检测/稍后/手动重查/草稿保护；统一候选构建、复核、Git和服务器发布 | 唯一运行版本来自package.json；提醒标题不超过8字、字号20且加粗、版本另列。稍后按origin/project/channel/目标版本去重并兼容旧键，手动检查不自动刷新。仅静态代码核对更新交互，未运行旧客户端验收 |

完整DNA逐字段编辑、付费自动图像语义验收仍留V1.1，没有静默增加到本轮。

## 完整恢复与回填

- `restore`从原Generation任务快照和immutable plan分叉新草稿，不使用当前默认模型、auto、1K或空参考图覆盖历史。
- 当时模型或原图失效仍保留原值，并提示出图前更新报价和重新验证。换造型必须有当前人物的原图参考；微调遇既有身份基准失效也明确拦截，不悄悄丢参考图。
- 保存“这个人”只使用本人成功结果和服务器生成的候选快照；已有基准优先保留，不自动滚动到最近新图。
- 图片模板回填：服务端持久ticket先CAS保存claimToken；客户端先保存receipt，再将单图追加到原完整本机草稿，存储失败不确认；成功后ack同一ticket/claim/asset，服务端CAS置applied。刷新后若素材已在当前目标中，直接补ack，不再追加。已applied的重复返回直接返回原状态。
- 视频模板回填只更新服务器assets/revision，并合并回原本机prompt、参数与编辑内容；回调期间有新编辑则拒绝刷新覆盖。工作区/视频草稿写入与ticket CAS处于同一事务。

## P3 的实际边界

本人有效Asset在素材卡下方显示Trash2及“删除”文案，不仅hover显示。确认框明确写“从我的素材库删除”，可撤销，并说明底层文件、已经加入任务或图集的引用、已共享内容仍保留，这不是彻底删除。

删除只写本账号的PlatformSetting隐藏标记，不修改Asset有效状态、不删文件、不级联引用；我的素材查询和picker应用标记。撤销入口保存到本账号本机工作现场。共享/公共/非本人条目不提供删除权限。

0.41.0未覆盖条目：`video_task`和没有关联Asset的`reference_image`。旧接口确实没有同权恢复，但这不是私有隐藏机制的阻塞。监督纠正后确认它们属于原P3标准，接续0.41.1按真实归属补齐；不调用、改造或假造旧删除/恢复接口，不把本历史Asset-only成果宣称为全类型完成。

## 实际发布检查

1. 正式有效来源116ee2a，经独立归档与服务器应用源码761文件逐项SHA核对一致；切换前及worker排空后再核对763文件，覆盖配置。未使用旧正式根整包发布。
2. 本机两次构建只停在优化编译阶段，已结束自有进程，不能算通过。采用服务器现有node_modules/Prisma Client进行独立源码、独立dist候选构建，无依赖安装/升级。
3. 第一候选内置lint拒绝局部变量`module`；第二候选类型检查报告可缺省字段声明错误。用同一TypeScript编译器汇总四条诊断，集中修正两类字段问题，再整体构建。
4. 最终 `NEXT_DIST_DIR=.next-prod-candidate npm run build` exit0，优化编译、内置lint与类型检查、静态页面生成完成；新增人物、配置、handoff、素材撤销路由在app manifest中存在。构建仍有非阻塞img、Hook依赖及既有CSS兼容警告，没有借机全库改造或禁用检查。
5. 最终 `git diff <运行来源> <交付commit> --check` exit0；自复核归属、不可变恢复、重复冻结、未知重试、引用保护和回填确认，未派审核线程。
6. release-window实际预约/重读确认，归档及切换前核对所有权；服务器deploy.lock以flock覆盖真实候选构建及切换，不是仅留一条文档规则。重核live来源仍116ee2a才切换。
7. 图片worker设置drain标记，原PID3909309自然退出后才停止服务；没有强杀付费任务。随后停止web，同步已验证源码，保留旧构建，切换候选并恢复双服务；不原地构建live。
8. 公网release/health/config/login均200，来源`server-42-193`；从服务器和本机两条路径核对。人物页、图片页、登录页及包含P5的模板工作台chunk SHA与候选一致；仅静态发布证明，不冒充真实页面交互验收。
9. 切换后持续复核两个服务active/running、ExecMainStatus0、NRestarts0；drain已清除，storage/uploads/videos仍指向原/data持久软链接。

## Git、线上与回退

- 产品版本：0.41.0，一次交付仅升一次号。锁文件及依赖未修改；其历史根metadata不作为运行版本来源。
- 部署commit：`3e55c6609920e6e81253f087f59307eca9327293`。
- 分支：`codex/avatar-generator-20261005`，推送到已有origin，不forcepush。
- 发布标签：`release/0.41.0-avatar-generator-20261005`，远端peeled commit为上述部署commit。
- 回退标签：`rollback/2026-10-05-before-avatar-generator-0.41.0`，远端peeled commit为`116ee2a82c1c3541c10c751674433d4958ffb54f`。
- 新BUILD：`HCmFzUDsnr43fQC62KZlg`。旧BUILD：`irfPSW4cqY4pqCko6De9P`。
- 正式入口：https://sd2.youdooart.com/tools/avatar-studio；配置管理：https://sd2.youdooart.com/tools/avatar-studio/configs；图片/模板工作台保留现有入口。
- 独立候选源码：`/srv/video-api-debugger/releases/3e55c6609920e6e81253f087f59307eca9327293`。
- 旧源码：`/srv/video-api-debugger/releases/116ee2a82c1c3541c10c751674433d4958ffb54f-avatar-rollback`。
- 旧构建：`/srv/video-api-debugger/app/.next-prod-prev-avatar-3e55c66`。
- 归档SHA：新`fa21b0ad0f78a3bbec6cc1ceef2ac29e13ac3e111b8dc6a7316e3ae18ac8466e`；旧`b40608677a43a31430de3d1755ac93dcc64f97439bc30d3491b4fd06d39142cf`。
- 实际app仍`/srv/video-api-debugger/app`目录，无current软链。运行dist`.next-prod`，旧构建单独保留。上传/rsync排除.env*、node_modules、.next*、storage、dist、DB、public/uploads、public/videos与部署运行标记，保护全部现有持久数据软链。
- 发布脚本带源码/构建回退路径；本轮没有实际触发或演练回退。以后回退也须预约、复核当前来源、重新安全排空worker，再恢复上述源包和旧构建，不能在新付费任务仍执行时直接换源。
- 版本登记已写入`/Volumes/Data/Projects/project-version-registry.md`，runId `avatar-generator-20261005-3e55c66`。正式根工单、索引及todo由supervisor维护，本lead未编辑或暂存它们。

## 完整源码改动（33文件）

所有以下路径均相对`/Volumes/Data/Projects/video-api-debugger/worktrees/avatar-generator-20261005`；`delivery.json`另含完整绝对路径。完整统一diff见`source.diff`。

| 文件 | 本轮核心改动 |
| --- | --- |
| package.json | 运行版本单次MINOR到0.41.0，无依赖变化 |
| src/app/api/assets/library/removal/route.ts | 本账号Asset素材隐藏/撤销入口 |
| src/app/api/assets/library/route.ts | 我的素材查询应用隐藏标记，保持底层引用 |
| src/app/api/assets/picker/route.ts | 真实Asset归属删除能力、本人隐藏筛选 |
| src/app/api/avatar-studio/handoff/route.ts | 既有图片资格鉴权及ticket选择/应用/ack入口 |
| src/app/api/avatar-studio/route.ts | 私有配置/历史、准备/报价/提交/重试/完整恢复及保存人物 |
| src/app/image-studio/studio.module.css | 稳定图下恢复footer，整卡hover及键盘聚焦显示 |
| src/app/image-studio/studio.tsx | 单击只选中；显式按钮完整恢复；安全单图本机草稿回填 |
| src/app/tools/avatar-studio/configs/page.tsx | 权限内配置管理独立页面 |
| src/app/tools/avatar-studio/page.tsx | 权限内人物工具页面及情境ticket |
| src/app/tools/avatar-studio/studio.module.css | 方案D响应布局、稳定候选和工具控件 |
| src/app/tools/avatar-studio/studio.tsx | 六快设、锁/来源、多人/候选、Prompt、配置/历史、收藏下载恢复继续及现场保存 |
| src/components/ComposerTopbar.tsx | 工具菜单入口，保留旧功能 |
| src/components/GenerationComposer.tsx | 工作区参考区安全生成人物来路 |
| src/components/ReleaseNotice.tsx | 项目/渠道/目标版本稍后去重，兼容旧键，沿用手动重查和草稿保护 |
| src/components/ResourceLibraryPicker.module.css | 素材下方常显删除按钮 |
| src/components/ResourceLibraryPicker.tsx | 确认/撤销删除、情境人物入口、持久receipt及回填确认 |
| src/components/ResultImageCover.module.css | 选中边框改由选择状态驱动，不再自动套用 |
| src/components/ResultImageCover.tsx | 单击onSelect；独立双击预览，移除单击restore |
| src/components/ToolsMenu.tsx | 复用共享导航权限的工具菜单 |
| src/components/generate/GeneratePageClient.tsx | 视频/IP页自有顶部数组加入受限人物入口，保留旧入口 |
| src/components/template-studio/VideoTemplateWorkbench.tsx | 模板素材来路、槽位版本保护、保留本机编辑的回填合并 |
| src/lib/assets/library-removal.ts | 私有隐藏标记，严格本人有效Asset，不修改资源/文件 |
| src/lib/assets/picker-types.ts | 明确来自服务器的可删除能力字段 |
| src/lib/avatar-random/catalog.ts | 分层字段和关联随机词库、六快捷字段、普通用户标签 |
| src/lib/avatar-random/engine.ts | 约束校验、优先级、来源/锁、相关随机、预算、Seed、独立候选和模型Prompt |
| src/lib/avatar-random/handoff.ts | 归属/版本/容量/签名校验，目标事务写入、claimToken/ack/CAS幂等 |
| src/lib/avatar-random/service.ts | 后台已有文本解析、不可变人物计划、稳定参考、报价及既有队列接入 |
| src/lib/avatar-random/store.ts | 本账号三对象、配置版本、分页最近3、命名/另存/删除撤销CAS |
| src/lib/avatar-random/types.ts | A1共享契约、来源与独立锁、三对象和不可变计划 |
| src/lib/image-studio/tasks.ts | 每候选独立Prompt/snapshot/task、禁止模板暗继承、幂等事务接入 |
| src/lib/navigation.ts | 人物工具权限入口、原抠图adminOnly保留 |
| src/lib/release.ts | 同一运行版本与覆盖本轮三类用户可感知变化的摘要 |

## 证据目录与原始需求

本文件和同目录`delivery.json`、`source.diff`、`public-from-local.json`、`sd2-avatar-public-proof.json`、`sd2-avatar-runtime-proof.json`、`sd2-avatar-p5-static-proof.json`、最终及失败候选build.log、两份实际发布脚本为本轮证据。它们位于正式根下的nested worktree，可由supervisor归档到正式资料目录及固定索引；不以聊天消息作为唯一证据。

原始有效入口（本lead不修改）：

- `/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-04-controlled-avatar-generator.md` v1.1.0第12节，当前授权及P1-P5。
- `/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-04-controlled-avatar-generator/requirements.txt` 原30节。
- `/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-04-controlled-avatar-generator/supplements.txt` 十二补充，三对象/动作的最新口径。
- `/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-04-controlled-avatar-generator/wechat-face-library-reference.json`，仅参考建议，非独立批准要求。

## 未验事项与风险

- 未做浏览器/鼠标/键盘/移动端功能验收、真实同脸/人物差异/自然语言语义验收、真实付费生成、点数/并发/网络故障自动回归或回退演练；用户在正式页面主动点击后手动验收。
- 自然语言描述依赖后台既有文字模型和用户明确费用确认；未知、冲突、无配置会阻止相应动作。解析异常时同描述不自动重复付费请求，需要调整描述或人工处理，不把未知当成功。
- 保持同人必须原图和通道支持，仍不承诺100%同脸；图片Seed不受支持不能冒称精确出图复现。
- P3是库内隐藏而非隐私擦除，已有引用及共享保留；非Asset条目没有新增删除能力。
- 本机不可用缓存构建未作发布依据，残留自有`.next-avatar-candidate`不提交、不上传；证据文件为交接产物，不改变已部署源码commit。
- 无权限扩大、独立账本、schema迁移、数据库覆盖、敏感.env读取、依赖安装/升级、生产素材删除、强杀付费worker或破坏性Git。用户功能验收未执行；P3范围归类误判已记录并接续修正。
