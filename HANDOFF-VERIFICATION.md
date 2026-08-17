# 交接文档 vs 当前代码 — 对照核查报告

> 核查日期:2026-08-17
> 参照文档:`E:\feishu\ultimate-canvas-codex-api-handoff.md`
> 核查对象:`E:\Ultimate-canvas\seedance-api-debugger`(本地 HEAD = origin/teammate/ultimate-canvas-complete 147cf84)

## 结论总览

**交接文档描述的状态与当前代码完全一致,无未落地项。** 文档约定的全部接口契约、权限边界、前端实现均已就位,本地与远端分支同步(0 ahead / 0 behind),前端关键文件语法检查通过。以下为逐项核对明细。

---

## 一、代码基线 ✅

| 文档要求 | 现状 | 状态 |
|---|---|---|
| 仓库 `github.com/goukiyang/seedance-api-debugger.git` | `origin` 指向一致 | ✅ |
| 交接开发分支 `teammate/ultimate-canvas-complete` | 当前分支即为该分支 | ✅ |
| 分支以远端为准、不固定旧 commit | HEAD=147cf84,与 `origin/teammate/ultimate-canvas-complete` 完全同步(0/0) | ✅ |
| `node --check` 前端文件 | app.js / canvas-engine.js / generation-api.js 全部通过 | ✅ |

## 二、权限边界 ✅

| 文档要求 | 现状 | 状态 |
|---|---|---|
| `/tools/ultimate-canvas` 页面入口 + 静态全屏页非 admin-only | `src/app/tools/ultimate-canvas/page.tsx` 仅要求登录,iframe 全屏打开 | ✅ |
| `bootstrap/document/generate/upload` 不再整接口 admin-only,普通账号需登录 | 四个路由均走 `getSession` + 项目/视频卡权限(如 `assertCanUseCanvasProject`、`getProjectForGeneration`),无 admin 门槛 | ✅ |
| `localization-health` 仍仅管理员 | `user.role !== 'admin'` 直接拦截 | ✅ |
| 不给普通账号后台管理页 | `/admin/*` 全部要求 `getAdminUser`(角色校验) | ✅ |

## 三、后端接口契约 ✅(全部吻合)

| 文档 | 代码 | 状态 |
|---|---|---|
| bootstrap 返回 `capabilities.text/image/video`(enabled/model/endpoint/message) | `bootstrap/route.ts:344-401` 完整返回四项 + image 能力详情 + video 的 `status_endpoint_template=/api/video/status/:taskId?refresh=true` | ✅ |
| bootstrap 不返回 API Key/密钥/完整后台配置 | 仅返回布尔与模型名/端点,无任何密钥 | ✅ |
| document:读取 `document_json`/`documentJson`/`document`,空内容报"画布内容不能为空",2MB 上限 | `document/route.ts:109-118` 三键兼容 + `{}` 拦截 + 413 | ✅ |
| document:`video_card_id` 放在 `document_json.context.video_card_id`,保存接口不读顶层字段 | 路由不读顶层 `video_card_id`;前端 `canvasDocumentPayload()` 将 `video_card_id` 写入 `context` | ✅ |
| generate:最小 payload(kind/mode/prompt/project_id/video_card_id/canvas_document_id/canvas_node_id),kind 仅 text/script | `SUPPORTED_TEXT_KINDS={'text','script'}` + 各字段清理 + 走 Musk 后端模型 | ✅ |
| upload:multipart `file/project_id/video_card_id/canvas_document_id/canvas_node_id` | `upload/route.ts:30-40` 字段齐全,另有 role 字段 | ✅ |
| 视频生成必须带 `client_name=ultimate_canvas` + `source_metadata.source` | `tasks/create/route.ts:369-377` 识别两种来源并归一为 `ultimate_canvas` | ✅ |
| 付费生成保护:`PAID_GENERATION_AUTH_REQUIRED` + `x-paid-generation-intent/reason` 头 | `paid-generation-guard.ts` 完整实现(agent 客户端名/来源判断 + 双头放行) | ✅ |
| 状态轮询 `/api/video/status/:taskId?refresh=true` | 前端契约与后端路由一致 | ✅ |
| 项目:空项目可删、有内容仅归档、默认/系统项目保护 | bootstrap 返回 `removal_action/removal_reason`;后端 projects 路由按规则放行 | ✅ |
| 视频卡:`sealed/archived/merged` 禁止继续生成 | `video-cards/permissions.ts` `canGenerateInVideoCardStatus` + `assertCanGenerateInVideoCard` | ✅ |

## 四、前端实现 ✅

| 文档要求 | 现状 | 状态 |
|---|---|---|
| 参考 `canvasDocumentPayload()` / `saveCanvasDocument()` | 两函数均存在:`schema: ultimate_canvas.v1` + `context{project_id,video_card_id,video_branch_id}` + `canvas: engine.serialize()` | ✅ |
| 自动保存 + 修订号协调器 | 900ms 防抖 `scheduleCanvasSave` + `saveCoordinator`(revision 队列,含 context 匹配、flush) | ✅ |
| 从 bootstrap 消费 capabilities(端点/模型/可用性) | `app.js:95-100,3916` 由 capabilities 推导端点,不可用时展示后端 `message` 而非触碰设置页 | ✅ |
| 项目选择器:前面都有头像、同名可区分 | `context-avatar`(img/首字母 + hue),owner/类型/任务数/图集数来自 bootstrap | ✅ |
| 新建项目、删除空项目、归档有内容项目 | `createProjectFromMenu` + 按 `removal_action` 出"删除/归档"确认弹窗 | ✅ |
| 新建/查看/归档/废弃视频卡 | `removal_action`(discard/archive)驱动按钮与文案 | ✅ |
| 切换项目/视频卡后保存与生成用新上下文 | `contextEpoch` 机制 + `canvasSaveContextMatches` 防旧快照回写 | ✅ |
| 失败提示保留用户输入和已选素材 | "生成请求失败,输入和已选素材已保留" + 节点状态 error 保留内容 | ✅ |
| 前端不传 base_url/api_key/自定义 provider 配置 | 全量 grep 无传输;`backend-contract.js` 仅白名单端点 + 对后端消息做密钥泄漏正则拦截 | ✅ |

## 五、与上一轮安全审查的交叉点 ⚠️

文档验收标准要求"**不泄露 API Key、cookie、签名 URL、数据库路径**",以下两点与文档精神冲突,已在专项审查报告中列为 P1,建议一并处理:

1. `GET /api/assets/list` 无鉴权、无 owner 过滤 → 全库资产记录泄露(含 URL/名称)。
2. `DELETE /api/assets/[id]/provider-delete` 无鉴权、无归属校验 → 匿名可删任意用户官方资产(不可逆)。

(另:`/api/config` 公开返回 provider base_url/model/布尔配置,不含密钥,危害低,建议收敛。)

## 六、结论与建议

1. **交接状态正常**:文档所述功能与权限边界全部落地,分支同步,可交付 Codex/同事继续开发。
2. **下一步建议**:按文档"验收标准"用真实普通账号登录线上 `sd2.youdoodesign.com` 做一次端到端验收(登录 → 加载上下文 → 文本/图片/视频生成 → 点数消耗与返还);这部分需要线上环境,本地无法完全验证。
3. **顺带修复**:上轮安全审查的 P0/P1(assets/list、provider-delete 等)与本文档"不泄露"原则直接相关,建议在交付前完成止血。

---

*核查完 — 需要的话我可以直接补上 assets/list 归属过滤和 provider-delete 鉴权,或协助整理线上验收清单。*
