# 视频提示词组统一选择器

## 13.11 PG-UI03/04 与 PG-IP01 实施增量（2026-10-30）

项目：video-api-debugger。用户明确要求原单落地，本节进入实施；前置阶段的“仅前置”保留为历史，不限制本次授权。正式根同路径保存完整§1–13.10与五张私有参考图，公开版本仅含本次安全执行摘录。

| 编号 | 原任务名称 | 本轮完成标准 | 状态 |
|---|---|---|---|
| PG-UI03 | 视频生成页四处布局调整 | U1–U4实现，必要工程检查与本人自复核 | 已完成工程交付；待用户手验 |
| PG-UI04 | 提交与发布 | 聚焦提交推送、保护部署和可恢复准备；功能用户手验 | v0.120.0已部署；待用户手验 |
| PG-IP01 | 同一模型下拉整合IP生成线路 | U5实现并保草稿、素材、身份、权限、费用与未知请求合同 | 已完成工程交付；待用户手验 |

执行范围：沿原PromptEditor与ReferenceStrip局部CSS、160×32组chip、既有SortableStudioList可选rect策略；原默认纵向不变。普通/IP共享紧凑外观，但能力独立。型号选择只在原底部下拉，真实surface+model映射继续原接口；复用原输入恢复，mode-switch不冒task-reuse。显式换线先同步保来源完整快照、目标旧稿和带nonce的隔离交接并读回，不清空/替换/重传素材。旧v2稿无素材则如实保当前素材，目标初始化先于旧稿和迟到偏好。

Git计划：从已部署`f4ccc79eb2fe10f8fa6c3ecfeb9f54aa8a7d44dd`/v0.119.0的干净源码checkout分出`codex/prompt-group-ui-ip-20261030`；保ARCH03、a8c6d4d7、主会话及目录有界读取，不碰正式根旧dirty。候选v0.120.0，提交至现有origin。原生worker入口不可用，本执行者直接接续，未建侧栏任务。

守门员：局部跨线路输入交接，保持现有鉴权/请求/费用API，不迁库，不改私密策略。仅执行受影响纯函数工程检查、完整Next类型/构建/lint及必要启动/公网产物检查；不浏览器、不收费生成、不真实业务保存删除、不独立审核。实际页面与完整操作效果由用户手验；L2工程边界，无分级误判。

CodeGraph：实际checkout已prepare，真实context查询命中GenerationComposer、ComposerActionBar、PromptGroupSelection；图结果回源核对，未拿其它目录索引替代。开源方案复用前置已读React Aria TagGroup与现有dnd-kit，不新增依赖。

最终工程交付：2026-10-31T02:17:19Z已部署v0.120.0，源码`e6c461223f2b26a3fcbc2ea218d30862116f68f4`、BUILD `lKaGPYfNr9KqTNHAXqOz1`，origin任务分支同源已核。最终完整Next/types/lint通过，1958份源码与工程目录及Git包核同；7组换线/有序引用合同与任务复用基础检查复用，6项主/保护版实际启动检查、7服务/4timer及两个公网路由资源哈希通过。入口`https://sd2.youdooart.com/generate`及原`/generate/ip`。实际页面、触摸/键盘和恢复流程待用户手验，不冒功能验收。

保留问题及次数：类型检查2轮错误已定向修正并通过；旧`test-task-reuse-intent-integration.ts`在候选与未改f4ccc79e均于203行同一断言失败，未作为通过证据，未扩修。发布准备1次旧目录重名，改用源码编号备份并从部分完成处续跑，未停服；构建成功后的SSH回执连接卡住，已依据服务器完成JSON、ready标记及无构建进程核实后结束本机连接，未重复构建。两份完整构建均成功，切版0失败，无生产数据恢复或删除。菜单旧bottom定位与真实参数型号分离仅作已有共享控件因果修正，不追加理论边界。

回退沿原相容版`6c3d4bb1d068242e71a9791dd50a7be87a800f72`/`0.118.5+arch03-guard.1`，BUILD `MMAEfyVWF5QO500lN6MR-`；固定恢复入口和配置备份保服务器现有staging，程序回退不回DB/账本/媒体/回执。原v0.119.0原件另保留，未扩启动门两版上限。中断后和切版前已鲜核实际线上f4ccc79e及无发布占用，未覆盖同期成果。

本批证据沿正式根`docs/materials/2026-10-12-studio-ui-clarity/prompt-group-ux-20261030/ui03-implementation/`保存；原五图仍在相邻ui03-preflight目录，仅私有本地，不上传Git/公网。

## 13.12 PG-COVER01 提示词组封面区前置（2026-10-31收口）

用户反馈编辑提示词组弹窗缺少封面上传设置模块，要求复用旧模块；最新明确“把这个前置任务做完”。本轮仅补齐前置并提交安全文档，不继续业务代码、版本、构建或部署。完整原单、用户截图及来源沿正式根同路径和私有`cover01/`资料保留，不公开截图或内部提示词。原PG-UI03、PG-UI04、PG-IP01状态不变。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| PG-COVER01 | 恢复提示词组封面设置模块 | 根因、旧模块、接线依赖、权限保存、回退及最小手验齐备；仅文档提交推送 | 业务前置已完成；既有代码草案未交付；CodeGraph状态接口缺口另列 |

根因已核：`GroupEditor`只在折叠“简介、条件与封面”中提供依赖上传回调的文字按钮，没有旧封面区和当前预览；`GenerationComposer → PromptGroupSelection → GroupEditor`已经传入`workspace.uploadAssetToHistory`，不是上传接口缺失。旧`src/app/image-studio/skills-view.tsx`同业务封面区具备预览、原素材选择器、拖入/粘贴上传和解除关联；`ModuleCoverEditor`是模板拼图裁剪与独立保存，职责不同，明确排除。主控已确认复用同业务模块，抽新旧共用组件有两处真实消费，无待定产品选择。

后续实施落点：
- `src/components/PromptGroupCoverField.tsx`及CSS：从旧封面区提取受控展示组件，接收assetId/coverUrl/disabled及选图、上传、移除回调，不自行保存组定义。
- `src/app/image-studio/skills-view.tsx`：原封面区换为共用组件，原上传、素材选择器与保存回调保持，不扩其它页面业务。
- `src/components/generate/PromptGroupPicker.tsx`：名称后、正文前常显同一模块，覆盖新增和编辑；封面仍写原coverAssetId，已有封面用服务器受保护版本URL，新选图片沿原合法缩略图入口；简介/条件继续独立折叠。
- 依赖现有`ResourceLibraryPicker`、`useWorkspace.uploadAssetToHistory`、prompt-groups服务器权限/版本与封面读取路由，不新增接口、组件库、裁剪规范或权限。共用组件与两个消费者一并接入后，检查原回调和字段链路，再做必要工程检查。

保存边界：上传、选取、更换、解除关联只改变当前编辑及原草稿，不自动保存组定义、不加入生成参考区、不删原素材。原显式保存真实成功才更新已保存版本并关闭；取消选图不改当前值，失败/冲突保稿，未知只查原请求，不换号重发。新旧编辑器各自保原保存合同，上传继续原权限/请求号/恢复底座，不合并后台模型或另加理论防御。

工程与回退：本轮不检查/构建/部署代码草案。后续另获实施授权时仅做必要类型/lint/Next构建和自复核，复用匹配证据，不加字符串自证/全站回归；沿既有保护部署鲜核实际线上、同期成果、发布占用和可执行相容回退，不沿用旧调查时的版本号。无数据迁移，回退只回程序与匹配配置，不回DB/媒体/账本/回执，不删除已上传素材或合法封面关联。

最小用户手验：新增/编辑封面常显及已有预览；原选择器上传/选取、更换、拖入/粘贴与取消；解除关联不删素材；显式保存成功回显、失败/版本冲突/未知保稿；窄屏和键盘可达。无浏览器、收费、真实业务保存删除或独立审核，不用构建冒手验。

现状分开：阶段切换前已在本地写入7份未提交源码/版本草案（共用组件及CSS、skills-view、PromptGroupPicker、package.json、package-lock.json、release.ts），未完成本项必要工程检查、未提交/推送/部署；原样保留，不夹带文档提交。完整截图736×795 PNG、168219字节已实际查看并私有归档。已有同站后续交付不被本前置覆盖，草案暂写版本不视为未来发布版本。

CodeGraph证据与缺口：主控完成实际源码checkout的sync，1661 files / 28366 nodes / 97550 edges、up to date；CLI context指定实际路径、max-nodes 6、no-code、JSON返回6 symbols / 4 files / 3 relations，命中GroupEditor、PromptGroupCoverField和Cover，证明当前未提交源码关系，不证明线上或决策记忆。当前MCP无CodeGraph工具，CLI v0.9.3及其README/help/MCP实现无memory/docs状态存取接口，现有适配器仅负责源码新鲜度。无法完整读取/回写项目全局状态与决策，不把索引同步冒状态回写；缺口由主控上报，不留给实施者重做业务调查，不安装依赖或造新平台。
