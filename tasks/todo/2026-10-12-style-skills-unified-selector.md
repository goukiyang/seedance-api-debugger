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
