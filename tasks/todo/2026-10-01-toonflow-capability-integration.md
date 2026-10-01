# Toonflow 功能地图与现有画布融合建议

项目：video-api-debugger
正式版本来源：package.json；本轮不升级产品版本，不推定线上版本。
目标路径：/Volumes/Data/Projects/video-api-debugger-v12-full-todo
状态：源码调研完成；建议待选择，未授权融合实施。
风险等级：L0 只读扫描及记录；后续跨系统实施须重新分级。
开工重新锁定版本：实施时需要；当前只比较所读源码。
最后更新：2026-10-01

## 目标与范围

用户要求扫描 Toonflow 功能地图，用现有 skills 对照我们的画布，判断更快、更全面的接入方式。本轮只读源码和记录结论，不修改业务代码、不运行生成、不部署、不读取凭据。建议不自动转为产品决策。

| 编号 | 任务内容 | 完成标准 | 状态 |
|---|---|---|---|
| M1 | 扫描 Toonflow 功能地图 | 区分已实现、仅入口和桌面依赖，标出代码依据 | 已完成 |
| M2 | 扫描我们现有画布 | 查清已有能力、可复用接口与缺口 | 已完成 |
| M3 | 比较接入方案 | 给出最快可用路径、融合范围与风险 | 已完成 |

## 来源与证据口径

- Toonflow 官方 MIT 仓库 https://github.com/HBAI-Ltd/Toonflow-app ，固定 tag v2.0.2，提交 ec8f54597bf6e6114ed56b832f9052cd6f735311。源码路径 `/Volumes/Data/Tools/ai-video-trial-20261001/sources/Toonflow-app`；已读关键实现，未安装该源码依赖或执行生成。第三方依赖与素材仍须单独核许可。
- SD2 读取 `codex/gpt-image-studio` 当前工作区。已有未提交内容保留；不能把该分支或固定待办的历史状态冒充当前线上实况。
- 首轮使用 landing-execution、model-task-routing、product-design-philosophy、integrate-external-code、codegraph、graphify。SD2 复用既有 CodeGraph 索引并回到源码核验；Toonflow 当时无索引，先回退源码检索。用户随后授权建立 Toonflow CodeGraph，现已完成，见末节。Graphify 未生成，不混称两种工具。
- 原始来源为上游代码；无本轮用户附件。下列源码路径相对各自仓库，后续实施须重读，不以本报告替代原文。

## 功能地图

| 能力 | Toonflow v2.0.2 源码 | SD2 当前源码 | 融合判断 |
|---|---|---|---|
| 画布与节点 | 文本、图、视频、音频、图生成、视频生成、3D 导演共七类；Vue Flow | 原生 JS CanvasEngine，iframe 页面；有文本/脚本、媒体、导演台、合成及工具流节点 | 不重造第二套通用画布；节点存在不代表完整执行能力 |
| AI 操作画布 | 读取、查找、增改删节点、连线、排版；工具调用由打开的页面执行 | 已有文本/脚本生成；本轮未发现同等通用 AI 操作画布层 | 最值得优先借鉴工具协议与受控操作层 |
| 图片与视频生成 | Provider 插件、参考图和生成节点；产物保存本地工作区 | 现有图片/视频接口、项目资产、任务记录；普通画布图片计费/持久任务尚有待办 | 统一经过 SD2 服务端，不能让新 AI 直连 Provider 绕过计费权限 |
| 音频 | 导入/播放节点，媒体工具有生成音频能力；没有独立音频生成节点 | 音频节点存在，生成映射未确认接通 | 不写成双方完整支持配音流程 |
| Skills 与 Agent | 技能、工具插件、子 Agent、MCP/A2A、会话历史 | 可复用项目业务接口，但不等于已有相同代理能力 | 挑选提示词/流程适配；不能直接复制 Codex 全局 skills 和机器路径 |
| 剧本与分镜团队 | 存在 director/writer/reviewer 团队源码，启动处暂不安装内置团队 | 文本/脚本节点与项目、视频卡业务 | 不能宣称装好即可自动跑完整团队 |
| 3D 导演 | Three.js 场景、角色姿态/动画、镜头、PNG/MP4 输出；视频依赖 FFmpeg | 有导演台节点入口，本次不证明与 Toonflow 同等完整 | 后续作为专用编辑器接入更合理，回传参考图/镜头视频 |
| 持久运行 | 会话落文件；画布调用依赖前端连接，部分运行状态在进程内 | ToolFlowRun/NodeRun 与任务持久化、暂停/继续、筛选、确认、重试；目前主要图片模板流 | 使用 SD2 运行层，不能把连线或聊天记录当可靠后台流水线 |
| 保存恢复 | 工作区文件、画布 JSON、媒体子目录 | 数据库画布、修订历史、冲突处理、草稿恢复 | SD2 保持正式数据源，禁止双向自动同步两套完整画布 |
| 多用户与共享 | 官方说明 Web/API 是管理端，MCP 凭证不是全站认证 | 内部账号限制、个人画布隔离；工具流保存私有，分享按钮待接入 | 不原样公开 Toonflow，也不把 SD2 写成现成协同白板 |
| 成片剪辑 | 有 FFmpeg 媒体基础能力，不等于完整时间线剪辑器 | 视频合成节点存在，不能据节点名证明成片全链路 | 完整剪辑需单列需求，不作为本轮融合自动获得的能力 |

### 关键代码入口

Toonflow：
- `apps/web/src/pages/workspace/panels/canvas/useCanvasTools.ts:74`：调用绑定画布、120 秒超时；`:138` 节点类型校验；`:176` 附近连接校验；`:234` 排版。
- `apps/server/src/agent/bridge/canvas.ts:36`：等待页面执行的调用超时，说明不是独立持久工作流引擎。
- `apps/web/src/pages/workspace/panels/canvas/index.vue`：画布 JSON 保存；`packages/nodes/*/readme.md` 及节点源码：七类节点实现。
- `packages/nodes/director3dNode/src/sceneEditor.vue`、`renderMedia.ts`、`sceneAnimation.ts`：导演场景、输出与动画。
- `apps/server/src/utils/media/generation.ts`：Provider 校验和媒体生成；`packages/tools`：画布、工作区、媒体、搜索、网页、技能与提问工具。
- `packages/mcp/README.md:13,44`：页面连接依赖与管理端安全边界；`apps/server/src/utils/mcp/control.ts:58` 的页面来源/header 检查不是用户身份认证。
- `apps/server/src/index.ts:15`：内置团队暂不安装；`apps/server/src/utils/plugins/tools.ts`：插件按可信服务端代码加载，不是安全沙箱。

SD2：
- `src/app/tools/ultimate-canvas/page.tsx:8`：内部用户限制；`:17` iframe。依赖里有 React Flow，不等于当前画布使用它。
- `public/tools/ultimate-canvas/canvas-engine.js:417`、`backend-contract.js:10`、`generation-api.js:18`：节点与执行映射。
- `src/lib/canvas-documents.ts:476`、`prisma/schema.prisma:714,773`：画布保存和工具流持久记录。
- `src/lib/tools/toolflow.ts:84`、`toolflow-runtime.ts:293,466`：图校验、点数与现有执行类型。
- `src/app/api/tools/ultimate-canvas/document/route.ts:32`、`flows/route.ts:14,49`、`upload/route.ts:34`、`quote/route.ts:39`：现有业务边界。
- `tasks/todo/2026-09-22-canvas-toolflow.md:266`：普通画布计费/持久任务缺口；`public/tools/ultimate-canvas/index.html:56`：分享待接入。

## 方案比较与推荐

| 路线 | 快在哪里 | 成本与限制 | 建议 |
|---|---|---|---|
| 独立 Toonflow，个人本地使用 | 保留现成完整交互，最快体验其原生能力 | 两套项目/素材；模型配置与费用另算；不等于已经融合或可给多人公开使用 | 可作为试用台，不作为正式平台替换 |
| SD2 保留主画布，接 AI 操作与必要专用工具 | 复用已有项目、资产、历史和运行接口，避免同时维护两个业务入口 | 需适配工具协议、权限和任务映射；不是复制目录即完成 | 推荐正式路线 |
| 整套替换为 Toonflow 或直接 iframe 全站 | 短期看得到界面 | Vue/原生 JS 两套节点、文件/数据库、账号/计费/资产全部需打通；iframe 不会自动解决边界 | 不推荐作为最快上线方案 |

建议分三步，尚未授权实施：
1. 最小闭环：给现有画布加入“描述需求 -> 生成节点/连线草案 -> 用户确认 -> 调用已有生成流程 -> 结果回到项目和节点”。先借鉴 Toonflow 的工具 schema、节点查询/变更/排版和技能组织；写入须校验权限与版本，提供撤销，生成费用在执行前明确。避免首期承诺音视频全自动。
2. 把常用任务做成可重复模板：素材 -> 提示词 -> 图生成 -> 筛选/确认 -> 视频。图片部分复用 ToolFlow；视频/音频先补运行节点适配、幂等、重试与点数结算，不能以已有视频生成 API 冒充现成跨媒体编排。
3. 按真实使用价值接入 3D 导演专用面板、受控技能与分享导出。3D 可隔离为独立工具面板，只传批准的数据和产物，不共享原始 Provider 密钥或任意文件权限。

“我们的 skills”本轮指已用技能辅助分析。未来供网站 AI 使用时只挑选业务相关、可移植、可审阅的内容；Codex 调度、部署、浏览器登录等机器技能不能照搬为网站用户可执行工具。Toonflow 插件是可信代码扩展，不开放普通用户安装/执行任意插件。

## 检查、风险与后续完成标准

- 已完成：定向源码阅读、CodeGraph 辅助、双项目能力对照、授权/租户/计费/前端连接依赖识别；子 agent 只读负责 SD2 扫描，不承担额外功能验收。
- 未执行：浏览器、截图、构建、付费生成、线上功能检查；本轮不修改产品，因此无升级版本或部署。源码发现不等于运行验收通过。
- 守门员：未修改登录、点数、Provider、上传或数据库；无分级误判。既有脏改不纳入本轮记录提交。
- 后续实施前重新锁定当前代码和线上版本，优先解决现有普通画布计费/持久任务边界。最小闭环应证明：确认前不扣费；跨用户访问被拒；重复请求不重复生成；结果关联正确项目/节点；刷新后可恢复；费用与任务状态一致；失败有可理解的恢复路径。按项目规则由用户手动功能验收，部署检查与功能验收分开。
- 本记录是方案依据，不是实施工单或已批准重构。下一步由用户选择试用独立工具，或确认最小 AI 画布融合范围。

## Toonflow CodeGraph 建图补充

来源：2026-10-01 用户确认使用 CodeGraph 后指令“开整”。仅授权本地建图和关键依赖核对，不授权融合业务实施。

| 编号 | 任务内容 | 完成标准 | 状态 |
|---|---|---|---|
| C1 | 建立并使用 Toonflow 代码地图 | 索引可查询，核对关键依赖并补充融合记录 | 已完成 |

- 实际运行工具为已安装 CodeGraph CLI 0.9.3，未安装或升级依赖。当地工具源码参考库为 0.9.4，两者不可混称；0.9.3 CLI 不提供 callers/callees 子命令，已改用现有 CodeGraph MCP 成功查询，未修改工具配置。
- 索引位置：`/Volumes/Data/Tools/ai-video-trial-20261001/sources/Toonflow-app/.codegraph/codegraph.db`，对应 Toonflow v2.0.2 / `ec8f54597bf6e6114ed56b832f9052cd6f735311`。执行 `codegraph init -i <root>` 成功；最终 `codegraph status <root>` 报告 398 文件、5,566 节点、11,779 关系，11.07 MB，状态 up to date。数字采用最终 status 口径，不采用解析阶段计数。
- 已运行 CLI context 和 MCP explore/callers/callees，不只是创建空目录；guard 返回 CODEGRAPH_READY。已加入 `~/.codex/codegraph/projects.txt` 便于后续复用与维护，但没有新增自动任务或声称持续后台更新。
- 图谱定位并经源码确认：`useCanvasTools` 使用 `useVueFlow`、`useNodeToolsContext`、`createCanvasQueries`，所以适合借鉴操作协议并为 SD2 编写适配，不宜直接搬整个组件。
- 图谱定位并经源码确认：`createAgentToolContext` 在 `apps/server/src/agent/tools/index.ts:14` 将 image/video/audio 统一交给服务端 `generateMedia`；`generation.ts:129` 负责供应商、参考素材和结果写入。另有前端 `useNodeAi` 内部同名 `generateMedia`，实际通过 HTTP 请求服务器，不能误认为前端直接调用服务端函数。
- 图谱定位并经源码确认：`createAgentTools`、`createTeamRunner` 都调用 `loadTool`；后者动态加载可信服务端插件。融合时应只开放明确允许的工具，不把任意插件安装权限交给普通用户。
- 新增关键适配点：`packages/providers/types.d.ts:155` 约定生成接口返回最终媒体数组、不能返回任务 ID，轮询由 Provider 内部处理；对接 SD2 持久任务时须明确任务 ID、等待/恢复和产物回传，不能只替换接口地址就宣称接通。
- 限制：静态图谱按名称匹配会聚合同名符号，部分关联可能误命中；398 文件是可索引范围，不是整个仓库所有文件数量。关键结论均回到源码核对；建图不证明运行正确、线上生效或完整功能可用。
- 范围检查：Toonflow Git 状态只有新增 `.codegraph/`，业务文件未改；索引仅留本地，不向上游仓库推送。不运行构建、浏览器、生成或部署。融合建议不变：保留 SD2 主画布与正式数据源，优先接受控 AI 操作和现有任务链。
