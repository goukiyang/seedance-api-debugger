# ASSET-ENHANCE01 恢复资产页视频悬停超分入口

日期：2026-11-09 America/Los_Angeles。用户要求：资产页鼠标移到视频后恢复原有超分按钮。用户曾同轮追加下载按钮，随后明确“下载按键的事忽略”，已撤回该部分；最终仅修超分。状态：已部署v0.141.3，待用户手动验收。

## 目标与范围

恢复成功视频的悬停超分入口；无视频卡的新视频可沿原项目创建超分。复用现有超分组件的真实报价、v2创作归属、权限和原请求保护，不另造提交链，不执行收费生成或浏览器验收。

1. [x] 核对现网与原因：2026-11-10T06:18Z 仍为 ea910bed8c26c8a5bfa64d1afe94f7ecf7b90e80 / v0.141.1；sd2-gray active，公网 release 相符。
2. [x] 最小修复入口及共用组件，保留现有分辨率/帧率和返回资产页现场。
3. [x] Linux完整src类型检查和四文件相关lint均exit0（仅资产页既有invalidateAssetCache依赖warning）；fd3c22756164652c98660f8095f24260811a1a4f已推origin并核同头。
4. [x] 完整继承健康ae8c/0.141.2并保护构建部署，公网/服务检查通过，待用户手验。

## 原因与共享影响

现网 `src/app/api/assets/library/route.ts` 的 `canEnhanceVideo` 仍以 `Boolean(task.duration && task.video_card_id)` 为必需条件，导致当前允许无卡的新视频无法显示入口；`src/app/assets/page.tsx` 旧内联提交同样要求视频卡且不带v2创作合同。仅去掉隐藏条件会露出无法提交的旧链路。

现有 `src/components/EnhanceVideoAction.tsx` 已使用 `useCreationContext`、源任务报价、原号查询和v2意图，支持无卡、沿源项目及历史无项目显式选目的地。拟资产页直接复用此组件，保其他入口默认呈现和参数；API只移除旧卡门槛，服务端权限/项目/时长/禁止递归超分保持。共享影响限资产列表投影与该组件的可选展示参数；不改数据库、旧任务/原请求、账本、价格及媒体。

下载按钮的渲染、文案及处理全部恢复ea910原实现，未纳入最终差量。超分浮层复用资产页现有Radix定位/useDialogDismiss，跟随按钮、避让边缘、外点/Esc/关闭键关闭，内部操作不触发卡片打开；共享组件默认展示保持。

代码关系索引准备在正式根因 Git 文件枚举30秒超时失败，已按规则转定向源码，未拿旧索引冒查询成功。正式根旧业务树和他人脏改不作发布输入；隔离候选从实际ea910开始，最终完整继承前序4的新健康源，避免覆盖9/2已冻结修复。首次完整工作区检出因本机文件读取缓慢中断，已改稀疏隔离，不重跑功能验收。

实际稀疏隔离目录为 `/private/tmp/sd2-assets-enhance-20261109`，Git对象只读借正式根，独立索引/分支；本机标准worktree准备耗时过长，未覆盖原目录。该目录索引未初始化，沿已核源码接续，不为一次四文件小修建新图谱。候选上传前核每个差异、元数据和远端；正式根记录同步。未运行完整空检出工作区的构建。

已实现4个源码文件，删除旧资产页独立报价/提交分支后直接用现有组件；默认其它入口不变，资产页保持720p/1080p/2k/4k和原返回现场。资产标准版继续使用原`asset-enhance:<源任务>:<分辨率>:<fps>`操作key，已受理/未知旧请求不会因接入共用组件换号。浮层默认展开，不先收费或生成。

## 验证与交付边界

本轮为局部UI/投影修复，必要类型/lint和现有Linux构建内置检查沿发布入口执行；不新增模拟点击验收、收费生成或独立审核。构建、服务、公网产物不冒功能验收。实际悬停/参数/创建由用户手验。

隔离工程目录 `/data/video-api-debugger-engineering/assets-enhance-hover-20261109` 复制实际ea910的src/类型配置，只读复用同版node_modules，四文件上传后`tsc --noEmit --incremental false`及定向`next lint` exit0；日志types.log/lint.log。未修改运行目录、环境、数据或媒体。完整Next待前序4健康后最终组合源码执行，不以本次类型/lint冒已构建或上线。

## 本轮新发现的线索与问题

未新增范围外问题；旧资产超分提交和无卡过滤为本次同一问题的必要配套，下载诉求已撤回。

## 最终候选与发布接续

4已正式交接实际健康ae8c3ab42374523dcb090bf55128823eaa291130 / v0.141.2 / BUILD _VfkjoUvLHnDSM1en0Dk8，2026-11-10T06:42:58Z收口，窗交7。最终候选完整继承此源，新增仅超分四文件及PATCH v0.141.3/短通知/本单；下载原字节保持。guard仍79abce5c6b06bd714261609678992a3161ba4bad / zxSxN0_ODrOhrA3gjUCPz，按原成功构建和原时间复用。未把ea910作最终基线。

## 发布结果（2026-11-09 America/Los_Angeles）

已部署，待用户手动验收。实际cfaa689a5361f2dc765acf12ad960d6afc8fc081 / v0.141.3 / BUILD scV6jSPgiMjf7ibSc8u3j，完整继承ae8c和前序视频、UX04、生成误拦修复。2026-11-10T07:01:14Z完整Next含types/lint完成，build0；07:02:40Z公网58静态资源字节/4匿名401，07:04:13Z七服务/四timer健康/controller0，cutover0，6真实启动检查通过。17原生+17关联中实际受影响5组新跑、29项沿匹配02f/15/4原证复用且保原时间，当前计价门通过。无浏览器、收费生成或独立功能验收，下载块与ae8c逐字相同。

stage `/data/video-api-debugger/release-staging/assets-enhance-hover-20261109/attempt01`，pair `3b072a70-1445-48ec-bd6f-3d8709c3d11d`；19项控制/源码输入与2475选定Git blob核同。价格全字段d03c539d74a31b5e2a6a0305724b1b9f193e0ade878370898c7632d1bdc96539、私有策略/环境/数据和媒体链接保持；一致备份SHA256 b09a86ec3b6c21ca016f52014504f5dd39eae78c8bb3a5af4df2db7d0e0c854b。无新DDL、业务数据回退或旧原号重发。

恢复入口为同stage `bash program-recovery.sh release-input.json`，只回相容79abce5c6b06bd714261609678992a3161ba4bad / zxSxN0_ODrOhrA3gjUCPz程序；原guard构建复用，不重编或改原时间，未实际回退。后续先鲜核当前源与窗口，不重放旧恢复。[资料及元证](../../docs/materials/2026-11-09-assets-enhance-hover/README.md)。7已释放窗口并告知前序4，9明确无后续窗口需求；本轮不再Next或切版，未新增范围外问题。
