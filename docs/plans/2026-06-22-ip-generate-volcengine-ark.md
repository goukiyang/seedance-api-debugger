# (IP) Generate Page Volcengine Ark Implementation Plan

> **For Codex:** Use `${CODEX_HOME:-$HOME/.codex}/skills/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** 把现有“普通生成页”的第二入口正式改造成 `(IP) 生成页`，让它调用火山引擎火山方舟官方视频生成 API，支持授权 IP / 授权肖像 / 授权品牌素材的视频生成；现有扣点、冻结、失败退款、任务记录、生成列表、缓存下载、项目预算、后台流水等链路保持不变。

**Architecture:** 继续复用当前 `VideoTask`、点数、生成记录和前端工作台，正式新增火山方舟 Provider、Provider 路由、授权素材记录、官方任务对账和取消/删除能力。`(IP) 生成页` 在提交时标记 `provider=volcengine_ark`，服务端按 provider 路由到火山方舟官方接口；普通生成页仍走原 provider。任务状态查询、结果落库、本地化缓存、扣点结算、后台流水和线上部署验收都进入同一正式闭环。

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Prisma, SQLite, existing credits and cost ledger, Volcengine Ark Video Generation API.

---

## 1. 官方文档来源

本规划按 2026-06-22 核对的火山官方文档整理：

- [创建视频生成任务 API](https://www.volcengine.com/docs/82379/1520757?lang=zh)
- [查询视频生成任务 API](https://www.volcengine.com/docs/82379/1521309?lang=zh)
- [查询视频生成任务列表](https://www.volcengine.com/docs/82379/1521675?lang=zh)
- [取消或删除视频生成任务](https://www.volcengine.com/docs/82379/1521720?lang=zh)
- [Seedance 2.0 系列模型资源包使用规则](https://www.volcengine.com/docs/82379/2191775?lang=zh)

关键官方事实：

- 鉴权：只支持 API Key，服务端请求头使用 `Authorization: Bearer $ARK_API_KEY`。
- 创建任务：`POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`。
- 查询单个任务：`GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}`。
- 查询任务列表：`GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks?page_num=...&page_size=...&filter.status=...&filter.task_ids=...&filter.model=...`。
- 取消或删除任务：`DELETE https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}`。
- 状态：`queued`、`running`、`cancelled`、`succeeded`、`failed`、`expired`。
- 只支持查询最近 7 天任务；生成视频 URL 和尾帧 URL 有效期为 24 小时，必须及时转存到现有本地化缓存链路。
- Seedance 2.0 系列开通和调用要求依赖账号余额或资源包；资源包不足后会转为按量后付费。
- Seedance 2.0 不支持直接上传含真人人脸的参考图/视频；可用平台认可的模型生成样片、预置虚拟人像、或授权真人素材资产。

---

## 2. 本项目现状结论

当前普通生成链路已经有一套可复用闭环：

- 页面入口：`src/app/generate/page.tsx` 已承载普通生成工作台；`src/app/generate/ip/page.tsx` 已作为 `(IP) 生成页` 入口复用普通页面。
- 导航入口：`src/lib/navigation.ts`、`src/components/ComposerTopbar.tsx` 已有生成页入口模式。
- 任务创建：`src/app/api/tasks/create/route.ts` 负责登录校验、参数校验、点数冻结、项目预算、创建 `VideoTask`、记录 `ProviderApiRequest`、调用 provider。
- 点数估算：`src/app/api/tasks/estimate/route.ts` 和 `src/lib/pricing.ts` 已有估算逻辑。
- Provider 适配：`src/lib/provider/jimeng.ts` 当前封装原有外部 create/status 调用，并且已经能构造 `text`、`image_url`、`video_url`、`audio_url`、`first_frame`、`last_frame`、`reference_image` 等内容结构。
- 状态终结：`src/lib/video/task-finalizer.ts` 负责拉 provider 状态、写回任务结果、触发本地化缓存、结算点数。
- 状态接口：`src/app/api/video/status/[id]/route.ts` 已通过 finalizer 统一返回任务状态。
- 数据模型：`prisma/schema.prisma` 的 `VideoTask` 已有 `provider`、`model`、`provider_task_id`、`provider_status`、`provider_payload_json`、`provider_raw_create_response_json`、`provider_raw_status_response_json`、`result_video_url`、`result_last_frame_url`、`params_json`、`source_metadata_json`、`reference_video_urls`、`reference_audio_urls` 等字段，正式版优先复用这些字段，不先做数据库迁移。

结论：这次不要复制整套后端任务系统，也不要只做一个最短可用版。正式版做法是“复用现有任务/扣点/缓存闭环，新增火山官方 Provider、授权素材闭环、官方列表对账、取消/删除和部署验收”。

---

## 3. 复用与新增边界

| 模块 | 处理方式 | 原因 |
| --- | --- | --- |
| `(IP) 生成页`入口、布局、提示词、比例、时长、分辨率、参考图交互 | 复用普通生成页，按 `isIpSurface` 做少量差异 | 用户要求“直接复制现有普通生成页基础上改”；这样最快，也能保持体验一致 |
| 登录态、用户信息、项目/视频卡归属 | 复用 | 和 provider 无关 |
| 点数估算、冻结、项目预算、失败退款、成功扣点 | 复用，不改规则 | 用户明确要求“扣点等等保持原有链路不变” |
| `VideoTask`、生成记录、后台最近生成、任务列表 | 复用 | 现有字段足够保存新 provider 的任务 ID、状态、结果 URL 和原始响应 |
| 本地化缓存、缩略图、尾帧、结果转存 | 复用，但必须接入新 provider 的结果字段 | 官方视频 URL 只有 24 小时有效，现有本地化链路正好需要继续用 |
| 原 `src/lib/provider/jimeng.ts` | 保留给普通生成页 | 避免影响旧页面 |
| 火山方舟官方 API 调用 | 新增 `volcengine_ark` provider | 原 provider endpoint 和官方 API 完全不同 |
| provider 路由 | 新增或抽象 | create/status/list/delete 要按任务 provider 切换 |
| IP 授权确认与素材来源记录 | 新增 | `(IP) 生成页`的核心差异是授权素材使用责任和可追溯 |
| 火山官方任务列表、取消/删除接口 | 正式版纳入后台诊断和任务操作闭环 | 用户要求“所有接口”，不能只停在 create/status |
| Seedance 2.0 资源包/余额检查 | 正式版纳入配置检查和上线验收 | 这是火山账号侧前置条件，不能用现有点数系统替代 |

---

## 4. 官方接口清单与项目映射

| 官方接口 | 项目内入口 | 正式版定位 | 说明 |
| --- | --- | --- | --- |
| `POST /api/v3/contents/generations/tasks` 创建视频任务 | 复用 `POST /api/tasks/create`，内部按 `provider=volcengine_ark` 路由 | 必做 | 创建成功后保存官方 `id` 到 `VideoTask.provider_task_id` |
| `GET /api/v3/contents/generations/tasks/{id}` 查询单个任务 | 复用 `GET /api/video/status/[id]`，内部 finalizer 按 provider 路由 | 必做 | 把 `queued/running/succeeded/failed/cancelled/expired` 映射到本地任务状态 |
| `GET /api/v3/contents/generations/tasks` 查询任务列表 | 新增后台诊断 API 和 provider 函数 | 必做 | 用于火山侧任务对账、异常补偿、批量排查，覆盖最近 7 天任务 |
| `DELETE /api/v3/contents/generations/tasks/{id}` 取消或删除任务 | 新增本地取消/删除 API，内部按 provider 调用官方 DELETE | 必做 | 排队中任务取消，本地释放冻结点数；终态任务只删除/隐藏外部记录，不破坏本地审计 |
| 资源包使用规则 | 不做 app API；做配置检查、后台提示和上线验收项 | 必做 | 火山账号资源包和本系统点数是两层账，不能混为一个系统 |
| `callback_url` 回调 | 新增本项目回调接收入口，同时保留轮询兜底 | 必做 | 官方创建接口支持回调；正式版要能接收回调，但不能依赖回调作为唯一状态来源 |

---

## 5. 火山方舟字段映射

### 5.1 请求顶层字段

| 火山字段 | 现有字段/新字段 | 处理方式 |
| --- | --- | --- |
| `model` | 新增服务端配置 `VOLCENGINE_ARK_VIDEO_MODEL`，也保存到 `VideoTask.model` | 必填；不要写死在前端 |
| `content` | 由现有 prompt、参考图、参考视频、参考音频组装 | 必填；按场景生成不同 role |
| `callback_url` | 现有 `callback_url` + 新增本项目 provider callback route | 正式接入；回调负责加速状态更新，轮询负责兜底 |
| `return_last_frame` | 现有 `return_last_frame` | 复用，结果写 `result_last_frame_url` |
| `execution_expires_after` | 现有 `execution_expires_after` | 复用，默认可沿用现有值或官方默认 172800 秒 |
| `generate_audio` | 现有 `generate_audio` | 复用；Seedance 2.0 支持有声视频 |
| `safety_identifier` | 新增，建议使用稳定用户 ID 的不可逆派生值 | 不暴露密钥或隐私；用于火山安全审计 |
| `priority` | 新增，高级设置或管理员默认值 | 正式版支持；flex 不支持 priority |
| `resolution` | 现有分辨率 | 复用；官方建议用顶层字段，不再塞进 prompt 后缀 |
| `ratio` | 现有比例 | 复用；参考图/视频场景可结合官方自适应能力 |
| `duration` | 现有时长 | 复用；和 `frames` 二选一 |
| `frames` | 新增高级参数 | 正式版支持；如果传 `frames`，不要同时传 `duration` |
| `seed` | 现有 seed | 复用 |
| `camera_fixed` | 新增高级参数 | 字段留在类型中，但 Seedance 2.0 暂不发送，避免无效参数 |
| `watermark` | 现有 watermark | 复用 |

### 5.2 `content` 场景映射

| 页面模式 | 火山 content 结构 | 是否复用现有输入 | 说明 |
| --- | --- | --- | --- |
| 文本生视频 | `[{ type: "text", text: prompt }]` | 复用 prompt | `(IP)` 页面也要支持无参考素材测试 |
| 首帧生视频 | `text` + 1 个 `image_url`，`role=first_frame` 或不填 | 复用首张参考图 | 适合严格指定起始画面 |
| 首尾帧生视频 | `text` + 2 个 `image_url`，分别 `role=first_frame`、`role=last_frame` | 复用现有 `first_last_frame` | 官方要求 role 必填 |
| 多图参考生视频 | `text` + 1 到 9 个 `image_url`，每个 `role=reference_image` | 复用参考图集合 | 适合 IP 人物/角色/产品多角度参考 |
| 视频参考 | `text` + 最多 3 个 `video_url`，`role=reference_video` | 服务端已有字段，UI 需要补入口 | 单个视频 2 到 15 秒、最多 50MB、总时长不超过 15 秒 |
| 音频参考 | `text` + `audio_url`，`role=reference_audio`，且必须同时有图或视频 | 服务端已有字段，UI 需要补入口 | 单个音频 2 到 15 秒、最多 15MB，请求体不超过 64MB |
| 授权素材资产 | `asset://<ASSET_ID>` | 新增配置/素材登记 | 用于火山预置素材、虚拟人像、授权真人素材资产 |
| 样片任务 | `draft_task` | 暂不纳入正式版 | 官方说明 Seedance 1.5 Pro 支持，Seedance 2.0 不是本次主目标 |

### 5.3 官方状态映射

| 火山状态 | 本地状态建议 | 点数处理 |
| --- | --- | --- |
| `queued` | `queued` 或保持处理中 | 点数保持冻结 |
| `running` | `processing` | 点数保持冻结 |
| `succeeded` | `completed` | 按现有成功结算 |
| `failed` | `failed` | 按现有失败退款/释放 |
| `cancelled` | `failed` 或本地取消态 | 排队任务取消后释放冻结；终态删除不改变本地点数审计 |
| `expired` | `failed`，同时保存 `provider_status=expired` 和错误信息 | 按失败释放冻结 |

---

## 6. `(IP) 生成页`正式版功能清单

### 6.1 正式版必须有

- 页面标题和导航统一为 `(IP) 生成页`。
- 继续复用普通生成页的主要布局、提示词输入、参考图选择、比例、时长、分辨率、声音、尾帧、seed、水印等控件。
- 页面提交时传 `provider=volcengine_ark`。
- 服务端创建任务时保留原有点数冻结、项目预算、`VideoTask` 创建、`ProviderApiRequest` 记录和失败回滚。
- 新 provider 用火山官方 `POST /contents/generations/tasks` 创建任务。
- 状态查询用火山官方 `GET /contents/generations/tasks/{id}`。
- 成功后保存 `content.video_url`、`content.last_frame_url`、`usage`、`error` 等原始字段。
- 成功后立即进入现有本地化缓存，避免 24 小时 URL 过期。
- IP 授权确认：提交前必须让用户确认参考素材已授权，确认结果写入 `params_json` 或现有 metadata 字段。
- 素材来源记录：至少记录素材类型、来源说明、授权确认时间、提交用户。
- 缺少火山 API Key 或模型配置时，前端/服务端给出明确错误，不冻结或及时释放点数。
- 普通生成页继续走旧 provider，不被新逻辑影响。
- 参考视频输入：支持公网 URL、已上传资产 URL、或火山 `asset://`。
- 参考音频输入：支持公网 URL、base64、或火山 `asset://`，并校验必须搭配图或视频。
- 火山任务列表查询：做后台诊断/对账入口，支持按状态、task id、model 查最近 7 天。
- 火山取消/删除：先做后台按钮，再决定是否开放给用户任务卡。
- `priority` 高级参数：管理员或内部用户使用。
- `frames` 高级参数：支持小数秒需求，但要和 `duration` 互斥。
- 授权素材库：把常用 IP 角色、虚拟人像、品牌资产和火山 asset id 做成可选择素材。
- 资源包/余额提醒：后台集成页展示配置状态和外部账号检查清单，但不把火山资源包余额误当成本系统点数。
- 回调接收：新增火山方舟任务回调入口，验证 task id 归属后触发 finalizer。
- 官方对账：后台能用官方列表接口对照本地 `VideoTask`，发现本地漏更新、外部已终态、URL 快过期等异常。
- 取消闭环：排队任务取消后本地状态、冻结点数、操作日志、ProviderApiRequest 状态全部一致。
- 删除闭环：终态任务删除外部记录时，本地保留审计和已本地化结果，不能让历史生成记录消失。

### 6.2 正式版仍不做

- 不改现有点数价格公式。
- 不新增数据库迁移，除非实现时发现现有 `params_json`、`source_metadata_json`、资产 metadata 无法承载授权素材审计。
- 不把火山 API Key 放到前端。
- 不把普通生成页切到新 provider。
- 不自动判断用户是否真的拥有 IP 法律授权；系统只做确认、记录和审计提示。

---

## 7. 功能决策总表

| 功能/模块 | 正式版是否做 | 处理方式 | 解决方案状态 | 说明 |
| --- | --- | --- | --- | --- |
| `(IP) 生成页`入口和导航 | 做 | 用当前 | 已有方案 | `src/app/generate/ip/page.tsx` 复用普通生成页，导航继续用现有入口 |
| 普通生成页原链路 | 做保护 | 用当前 | 已有方案 | 不切 provider，不改扣点，不改 UI 主行为 |
| 页面基础布局、提示词、参考图、比例、时长、分辨率、seed、水印、声音、尾帧 | 做 | 用当前，按 IP 模式补少量差异 | 已有方案 | 复用 `src/app/generate/page.tsx` 和 `GenerationComposer` |
| IP 授权确认 | 做 | 新增 | 已有方案 | 提交前强制确认，写入 `params_json` 或 `source_metadata_json` |
| 授权素材来源记录 | 做 | 新增 | 已有方案 | 记录素材类型、来源说明、授权确认时间、提交用户、关联资产 |
| 火山 `asset://<ASSET_ID>` 授权素材 | 做 | 新增 | 需要配置/白名单方案 | 不允许普通用户任意输入；先做后台白名单或受控配置 |
| 创建视频任务 | 做 | 当前 `/api/tasks/create` + 新 provider | 已有方案 | 保留登录、校验、点数冻结、任务创建和 ProviderApiRequest |
| 火山官方 create API | 做 | 新增 | 已有方案 | `POST /api/v3/contents/generations/tasks` |
| 查询单个任务 | 做 | 当前 status API + 修改 finalizer | 已有方案 | `GET /api/v3/contents/generations/tasks/{id}` |
| 火山官方任务列表 | 做 | 新增后台诊断 API | 已有方案 | `GET /api/v3/contents/generations/tasks`，用于最近 7 天对账 |
| 火山官方取消/删除 | 做 | 新增本地取消/删除 API | 需要细化状态规则 | `DELETE /api/v3/contents/generations/tasks/{id}`；排队任务释放冻结，终态删除保留本地审计 |
| 官方回调接收 | 做 | 新增 | 需要 live 验证回调格式 | 创建任务传 `callback_url`，回调只加速状态更新，轮询兜底 |
| Provider 适配 | 做 | 新增 | 已有方案 | 新建 `src/lib/provider/volcengine-ark.ts`，旧 `jimeng.ts` 保留 |
| Provider 路由 | 做 | 新增/重写调用点 | 已有方案 | `tasks/create` 和 `task-finalizer` 不能再直接绑定旧 provider |
| 扣点估算 | 做保护 | 用当前 | 已有方案 | `src/lib/pricing.ts` 不改公式 |
| 点数冻结、失败释放、成功扣点 | 做保护 | 用当前 | 已有方案 | `allocateTaskCredits`、`settleTaskCredits` 保持原事务链路 |
| 项目预算 | 做保护 | 用当前 | 已有方案 | 不绕过项目预算账户和 ledger |
| ProviderApiRequest 记录 | 做 | 用当前，补 endpoint 名称 | 已有方案 | endpoint 从旧 `seedance.createVideoTask` 扩展出 `volcengine_ark.createVideoTask` 等 |
| 结果落库 | 做 | 用当前字段 | 已有方案 | 写 `result_video_url`、`result_last_frame_url`、raw response、usage |
| 本地化缓存 | 做保护 | 用当前 | 已有方案 | 官方 URL 24 小时有效，必须沿用 `startTaskLocalization` |
| 缩略图/生成记录列表 | 做保护 | 用当前 | 已有方案 | 成功结果进入现有任务列表和后台最近生成 |
| 参考图片 | 做 | 用当前 + 官方 role 映射 | 已有方案 | 首帧、首尾帧、多图参考分别映射 `first_frame`、`last_frame`、`reference_image` |
| 参考视频 | 做 | 扩展当前字段和 UI | 已有方案但需补校验 | 当前 route 已有 `reference_video_urls`，前端入口和格式/时长/大小校验要补 |
| 参考音频 | 做 | 扩展当前字段和 UI | 已有方案但需补校验 | 当前 route 已有 `reference_audio_urls`，但必须校验不能单独传音频 |
| `resolution`、`ratio`、`duration`、`seed`、`watermark` | 做 | 用当前字段，改官方顶层传参 | 已有方案 | 不再依赖 prompt 后缀 |
| `frames` | 做 | 新增高级参数 | 已有方案 | 和 `duration` 互斥 |
| `priority` | 做 | 新增高级参数 | 已有方案 | 管理员/内部默认值；flex 不支持时禁用 |
| `camera_fixed` | 不发送 | 不做前端开放 | 官方限制明确 | Seedance 2.0 暂不支持，保留类型但不传 |
| `draft_task` 样片任务 | 不做 | 不接入 | 官方目标不匹配 | 文档说明主要是 Seedance 1.5 Pro，不是本次 Seedance 2.0 IP 页目标 |
| 火山资源包/余额实时查询 | 不做自动化 | 后台提示 + 上线人工检查 | 暂无本规划内官方 API | 当前文档只有资源包规则，不提供本应用可直接查余额的接口 |
| 火山真实模型 ID | 做配置 | 运维/控制台配置 | 未有本地答案 | 需要从火山控制台确认 `VOLCENGINE_ARK_VIDEO_MODEL` |
| 火山 API Key | 做配置 | 服务端环境变量 | 未有本地答案 | 不能写进代码和文档明文 |
| 自动判断 IP 法律授权 | 不做 | 用户确认 + 记录 + 白名单 | 无可靠自动方案 | 系统不能替代法律授权判断 |
| 直接上传含真人人脸参考图/视频 | 不做 | 按官方限制拦截/提示 | 官方不支持 | 只能用平台认可的生成样片、预置虚拟人像或授权素材资产 |
| 数据库迁移 | 默认不做 | 用当前 JSON 字段承载 | 待实现验证 | 只有现有字段无法满足授权审计时再单独规划迁移 |
| 线上部署 | 做 | 用当前 `youdoo-sites` 正式闭环 | 已有方案 | 只在实际生产工作树构建、重启、验公网 |

### 7.1 当前可直接复用

- `src/app/generate/page.tsx`：普通生成页主体和 IP 模式判断。
- `src/app/generate/ip/page.tsx`：IP 页面入口。
- `src/app/api/tasks/create/route.ts`：登录、校验、点数冻结、任务创建、ProviderApiRequest、失败回滚主链路。
- `src/app/api/video/status/[id]/route.ts`：任务状态入口。
- `src/lib/video/task-finalizer.ts`：状态终结、结果写回、扣点结算、本地化触发框架。
- `src/lib/video/task-localization-runner.ts`：结果本地化缓存。
- `src/lib/pricing.ts`：点数估算规则。
- `src/lib/credits/policy.ts`：冻结、释放、结算。
- `src/lib/costs/ledger.ts`：Provider 请求流水。
- `prisma/schema.prisma` 当前字段：`provider`、`model`、`provider_task_id`、`provider_status`、`params_json`、`source_metadata_json`、`provider_payload_json`、raw response、参考视频/音频 URL、结果 URL。

### 7.2 必须新增

- `src/lib/provider/volcengine-ark.ts`：官方 create/status/list/delete 调用。
- `src/lib/provider/video-provider.ts`：按 provider 选择 create/status/list/delete。
- `src/app/api/admin/provider/volcengine-ark/tasks/route.ts`：官方任务列表对账。
- `src/app/api/provider-callbacks/volcengine-ark/video/route.ts`：官方任务回调接收。
- `src/app/api/video/cancel/[id]/route.ts` 或复用现有任务操作入口：取消/删除任务。
- IP 授权确认 UI 和授权 metadata 写入。
- 参考视频/音频输入 UI、校验和官方 payload 映射。
- 火山配置检查：API Key、Base URL、Model ID、资源包/余额上线提示。

### 7.3 必须重写或改造

- `src/app/api/tasks/create/route.ts`：不能固定调用旧 `createVideoTask`；要按 provider 路由，同时保持原扣点事务。
- `src/lib/video/task-finalizer.ts`：不能固定调用旧 `getVideoTaskStatus`；要按 `VideoTask.provider` 查询。
- `src/lib/provider/jimeng.ts` 的内容构造不能直接覆盖为火山官方实现；旧 provider 要保留，新 provider 单独实现。
- 任务取消逻辑要新增本地规则：排队取消释放冻结，运行中/终态删除不破坏本地审计。
- 生成页提交 payload 要区分 `/generate` 和 `/generate/ip`，避免普通生成页误走火山。

### 7.4 当前未有完整解决方案，进入实现前要确认

- 火山控制台实际可用的模型 ID 或 Endpoint ID。
- 火山 API Key 和线上环境变量配置位置。
- 火山资源包/余额是否足够，以及是否允许真实烟测消耗。
- 官方 callback 的真实 payload 是否和文档示例完全一致，需要 live 验证。
- 授权素材 `asset://` 的来源管理：先用受控配置还是做后台素材白名单。
- 参考视频/音频的服务端时长和大小检测方式：是否已有可复用媒体探测能力，还是先用上传阶段 metadata。
- `DELETE` 对 `running` 状态的真实表现和本地点数策略，需要用官方接口或文档进一步确认。

---

## 8. 推荐文件改造清单

### Task 1: Provider 类型和常量

Files:

- `src/lib/provider/video-provider-types.ts` 新增
- `src/lib/provider/index.ts` 修改或新增导出

Steps:

1. 定义 provider id：`seedance`、`volcengine_ark`。
2. 定义统一的 create/status 返回结构，尽量贴合现有 `jimeng.ts` 返回。
3. 定义火山状态到本地状态的转换函数。

Validation:

- `npm run lint`
- TypeScript 编译随 `npm run build` 覆盖

### Task 2: 新增火山方舟官方 Provider

Files:

- `src/lib/provider/volcengine-ark.ts` 新增

Steps:

1. 读取 `VOLCENGINE_ARK_API_KEY`、`VOLCENGINE_ARK_BASE_URL`、`VOLCENGINE_ARK_VIDEO_MODEL`。
2. 实现 `createVolcengineArkVideoTask(input)`，请求官方 `POST /contents/generations/tasks`。
3. 实现 `getVolcengineArkVideoTaskStatus(taskId)`，请求官方 `GET /contents/generations/tasks/{id}`。
4. 实现 `listVolcengineArkVideoTasks(filters)`，请求官方列表接口，先供后台/脚本使用。
5. 实现 `deleteVolcengineArkVideoTask(taskId)`，请求官方 DELETE 接口，供本地取消/删除 API 调用。
6. 把 HTTP 错误、官方 `error.code/error.message` 转成现有 provider failure 格式。
7. 保存原始 request payload 和 raw response，方便后台排查。

Validation:

- 无 API Key 时返回明确配置错误。
- mock fetch 或本地脚本验证 payload 结构。
- 有 API Key 后再做最小真实烟测，真实烟测会消耗火山资源，必须单独标记。

### Task 3: Provider 路由层

Files:

- `src/lib/provider/video-provider.ts` 新增
- `src/app/api/tasks/create/route.ts` 修改
- `src/lib/video/task-finalizer.ts` 修改

Steps:

1. `createVideoTaskByProvider(provider, input)`：旧 provider 走 `jimeng.ts`，新 provider 走 `volcengine-ark.ts`。
2. `getVideoTaskStatusByProvider(task)`：按 `task.provider` 决定状态查询函数。
3. 创建任务时保存 `provider='volcengine_ark'` 和官方 model。
4. finalizer 不再直接 import `getVideoTaskStatus` from `jimeng.ts`，改走路由层。

Validation:

- 普通生成页 provider 不变。
- 新任务 provider 为 `volcengine_ark`。
- 旧任务状态查询仍可兼容。

### Task 4: `(IP) 生成页`提交参数

Files:

- `src/app/generate/page.tsx`
- `src/app/generate/ip/page.tsx`
- `src/components/GenerationComposer.tsx` 视现有组件拆分决定

Steps:

1. `usePathname()` 判断 `/generate/ip` 时进入 IP 模式。
2. 提交 body 增加 `provider: "volcengine_ark"`。
3. IP 模式展示授权确认控件，未确认时禁止提交。
4. 把授权确认、素材来源、素材类型写入提交 payload。
5. 普通生成页不展示强制授权确认，不改变原提交 body。

Validation:

- 普通 `/generate` 创建请求不带新 provider 或仍为旧 provider。
- `/generate/ip` 创建请求带 `provider=volcengine_ark`。
- 未勾选授权确认不能提交。

### Task 5: 参数构造和校验

Files:

- `src/app/api/tasks/create/route.ts`
- `src/lib/provider/volcengine-ark.ts`
- `src/lib/provider/volcengine-ark-payload.ts` 新增，若 payload 逻辑足够短也可合并进 `volcengine-ark.ts`

Steps:

1. 把 `resolution`、`ratio`、`duration`、`seed`、`watermark` 放到官方顶层字段。
2. 继续支持 `return_last_frame`、`generate_audio`、`execution_expires_after`。
3. 仅当 `frames` 存在时不传 `duration`。
4. 多图参考统一 `role=reference_image`。
5. 首尾帧模式严格传 `first_frame`、`last_frame`。
6. 参考视频最多 3 个，总时长和大小先做前端提示，服务端做数量和格式校验。
7. 参考音频最多 3 个，且必须搭配至少 1 个图片或视频。
8. `asset://` 只允许来自后台配置或已记录授权素材，不允许普通用户随便填写。

Validation:

- 文本生视频 payload。
- 首帧 payload。
- 首尾帧 payload。
- 1 到 9 张参考图 payload。
- 图 + 音频 payload。
- 视频 + 音频 payload。

### Task 6: 结果落库和本地化

Files:

- `src/lib/video/task-finalizer.ts`
- `src/lib/provider/volcengine-ark.ts`
- 现有本地化相关文件按 finalizer 调用点确认

Steps:

1. 从官方响应读取 `content.video_url` 写入 `result_video_url`。
2. 从官方响应读取 `content.last_frame_url` 写入 `result_last_frame_url`。
3. 保存 `usage` 到 raw status response；若现有 usage/cost 字段可兼容，再做字段同步。
4. 一旦 `succeeded`，立即触发现有本地化缓存。
5. 缓存失败时不吞错，保留外部 URL 和错误日志，方便后续补偿。

Validation:

- 成功任务在列表第一列能看到缩略图或稳定占位。
- 外部 URL 过期前已转存。
- 本地化失败不导致点数重复结算。

### Task 7: 官方列表和取消/删除能力

Files:

- `src/lib/provider/volcengine-ark.ts`
- `src/app/api/admin/provider/volcengine-ark/tasks/route.ts` 新增
- `src/app/api/video/cancel/[id]/route.ts` 新增，若项目已有任务操作入口则扩展现有入口

Steps:

1. 列表接口只给管理员/内部诊断使用。
2. 支持 `page_num`、`page_size`、`filter.status`、`filter.task_ids`、`filter.model`。
3. 本地取消接口只允许取消本系统创建且属于当前用户/项目权限范围内的任务。
4. 排队任务取消成功后写本地取消/失败状态，释放冻结点数，记录操作日志。
5. 终态任务删除外部记录时，本地生成记录和审计记录保留。
6. `running` 状态的 DELETE 行为必须用官方返回结果或真实测试确认后再决定是否开放给普通用户。

Validation:

- 管理员可以按官方 task id 查询最近 7 天任务。
- DELETE 只对新 provider 任务生效，不误删旧 provider。
- 取消排队任务后冻结点数释放且不会重复结算。

### Task 8: 官方回调接收

Files:

- `src/app/api/provider-callbacks/volcengine-ark/video/route.ts` 新增
- `src/lib/provider/video-provider.ts` 修改
- `src/lib/video/task-finalizer.ts` 修改

Steps:

1. 创建火山任务时填入本项目 callback URL。
2. 回调入口解析官方 task id、状态、错误和结果 URL。
3. 只允许更新本地存在且 provider 为 `volcengine_ark` 的任务。
4. 回调只触发 finalizer 或同等状态刷新，不直接绕过点数结算。
5. 回调失败不影响轮询；轮询仍作为最终兜底。

Validation:

- 用 fixture 模拟 `succeeded` 回调，任务进入现有 finalizer。
- 用不存在 task id 的回调，返回安全失败，不创建陌生任务。
- 重复回调不会重复结算点数。

### Task 9: 配置和上线检查

Files:

- `.env.example` 或项目配置文档是否更新按团队规则决定
- 后台集成配置页面或现有后台设置页

Steps:

1. 增加服务端环境变量约定：
   - `VOLCENGINE_ARK_API_KEY`
   - `VOLCENGINE_ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3`
   - `VOLCENGINE_ARK_VIDEO_MODEL=<火山控制台模型 ID 或 Endpoint ID>`
2. 不在前端打印 API Key。
3. 启动时或创建任务前检查缺失配置。
4. 上线前人工确认火山账号满足余额或资源包要求。
5. 后台只展示“已配置/未配置”和模型 ID，不展示 API Key 明文。

Validation:

- 缺 API Key 时不发外部请求。
- 缺 model 时明确提示配置缺失。
- 线上部署前检查目标工作树是否为实际 sd2 生产来源。

---

## 9. 验证闭环

### 本地验证

- `npm run lint`
- `npm run build`
- payload 构造测试或脚本：覆盖文本、首帧、首尾帧、多图参考、图+音频、视频+音频。
- 普通生成页回归：确认 provider 仍为旧链路。
- `(IP) 生成页`回归：确认 provider 为 `volcengine_ark`，授权确认未勾选不能提交。
- 后台列表对账：确认能按 task id/status/model 调火山列表接口。
- 取消/删除：确认只影响 `volcengine_ark` 任务，旧 provider 任务不会误调用火山。
- 回调 fixture：确认重复回调不会重复扣点或重复释放。

### 外部 API 验证

- 无 API Key dry-run：确认不会冻结点数后卡死；若已冻结必须释放。
- 有 API Key 真实烟测：用最小参数创建 1 个任务，记录官方 task id。
- 轮询到终态：确认 `queued/running/succeeded/failed/expired` 映射正确。
- 成功任务：确认视频 URL、尾帧 URL、缩略图、本地化缓存、生成记录都写入。
- 失败任务：确认错误信息可见，点数按旧链路释放。
- 官方列表接口：确认能查到本次真实烟测 task id。
- 官方 DELETE 接口：只对明确可取消的排队任务做真实测试；如果任务已 running 或终态，只做后台权限和安全路径验证。
- 官方回调：如果火山真实回调可配置，则验证回调能更新本地任务；如果外网回调受限，保留轮询闭环作为完成标准并标注原因。

### 线上验证

如果目标是当前公开 `sd2.youdoodesign.com`，不能只停在 build 或 git：

- 在实际生产工作树 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo` 落地或同步。
- 使用 `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2` 构建。
- 使用 `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2` 重启。
- 验证本地 `/api/config`、公网 `/api/config`、公网页面 DOM 或截图。
- 至少跨过一个健康守护周期后复查 `youdoo-sites status sd2`。

---

## 10. 风险、停止条件和回滚

风险：

- 火山账号未开通 Seedance 2.0、余额不足、资源包不足或 API 调用资格未开放，会导致真实烟测失败。
- 官方视频 URL 只有 24 小时有效；本地化缓存失败会造成结果过期风险。
- 授权 IP / 肖像素材的合法性不能靠代码自动证明，只能做确认、记录、素材库白名单和审计。
- 参考视频/音频有格式、时长、大小和总请求体限制，需要前后端同时校验。
- `DELETE` 官方接口对不同状态含义不同，真实开放前必须先确认本地点数释放规则。
- 当前仓库不是记忆中 sd2 生产来源；若要上线，必须先确认目标工作树和发布链路。

停止条件：

- 需要真实火山 API Key、模型 ID 或资源包时，如果配置缺失，停止真实调用，只完成 dry-run。
- 任何点数冻结后外部请求失败但无法释放点数时，停止继续生成，先修复账务闭环。
- 成功任务无法本地化缓存时，不继续扩大测试量，先修结果保存和补偿。
- 需要修改数据库 schema 时，先补迁移规划，不直接改生产数据。
- `DELETE` 对 `running` 状态的真实行为无法确认时，先只开放管理员诊断，不开放普通用户按钮。

回滚：

- 普通生成页和旧 provider 不动；新 provider 出问题时关闭 `(IP) 生成页`提交或隐藏入口即可。
- 新增 provider 文件可独立回退。
- 已创建的 `volcengine_ark` 任务保留 `provider_task_id` 和 raw response，后续可用官方查询接口补偿。
- 点数仍走现有冻结/释放机制，回滚不需要改账务结构。

---

## 11. 推荐实施顺序

1. 新增 `volcengine_ark` provider 和 provider 路由层。
2. 让 `/api/tasks/create` 接收 provider，但默认仍保持旧 provider。
3. 让 `/generate/ip` 提交新 provider，并增加授权确认。
4. 修改 finalizer，让新旧任务都能按各自 provider 查询状态。
5. 接通结果落库和本地化缓存。
6. 接入参考视频、参考音频、`asset://` 白名单、`frames`、`priority` 等正式能力。
7. 接入官方列表对账、取消/删除和回调接收。
8. 做 mock/dry-run 验证，确保旧普通生成页不受影响。
9. 配置火山 API Key 和模型 ID 后做最小真实烟测。
10. 真实烟测通过后，验证官方列表能查到任务，验证可取消任务的 DELETE 闭环。
11. 需要上线时，切到实际 sd2 生产工作树按 `youdoo-sites` 闭环部署。

---

## 12. 正式版完成标准

- `(IP) 生成页`入口存在且文案正确。
- `(IP) 生成页`提交任务走火山方舟官方 create API。
- 普通生成页仍走旧 provider。
- 点数冻结、失败释放、成功扣点保持旧链路。
- 任务状态由火山官方 query API 更新。
- 后台能通过火山官方 list API 对账。
- 本地取消/删除入口能安全调用火山官方 DELETE API，并保护本地点数和审计记录。
- 官方 callback route 存在，能接收 fixture 回调并触发同一 finalizer；真实回调不可测时必须说明外网限制。
- 成功结果能进入现有生成记录、缩略图和本地化缓存。
- 授权确认和素材来源写入任务 metadata。
- 参考图片、参考视频、参考音频、`asset://` 授权素材按官方限制校验。
- `npm run lint` 和 `npm run build` 通过。
- 至少完成一次 dry-run；有 API Key 和资源包/余额许可时完成一次真实小任务闭环。
