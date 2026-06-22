# (IP) Generate Page Volcengine Ark Implementation Plan

> **For Codex:** Use `${CODEX_HOME:-$HOME/.codex}/skills/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** 新增一个独立的 `(IP) 生成页`，入口放在普通生成页顶部“我的项目”按钮旁边，按钮名为 `IP生成`；该页面面向授权 IP / 授权肖像 / 授权品牌素材的视频生成准备工作。当前火山 API Key 尚未拿到，真实 API 生成调用先不实现；现有普通生成页、扣点、冻结、失败退款、任务记录、生成列表、缓存下载、项目预算、后台流水等链路保持不变。

**Architecture:** 当前阶段只做入口、独立页面骨架、火山配置清单、素材/授权/合规准备，不做真实生成 API 调用。`/generate/ip` 是新页面，不是在普通 `/generate` 页面里切一个模式；可以复用普通页的组件和项目选择能力，但代码边界上要拆出独立页面容器。API Key、模型 ID、资源包和授权素材配置齐备后，再接入火山方舟 Provider、任务状态、官方对账、取消/删除和回调闭环。

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Prisma, SQLite, existing credits and cost ledger, Volcengine Ark Video Generation API.

---

## 1. 官方文档来源

本规划按 2026-06-22 核对的火山官方文档整理：

- [创建视频生成任务 API](https://www.volcengine.com/docs/82379/1520757?lang=zh)
- [查询视频生成任务 API](https://www.volcengine.com/docs/82379/1521309?lang=zh)
- [查询视频生成任务列表](https://www.volcengine.com/docs/82379/1521675?lang=zh)
- [取消或删除视频生成任务](https://www.volcengine.com/docs/82379/1521720?lang=zh)
- [Seedance 2.0 系列模型资源包使用规则](https://www.volcengine.com/docs/82379/2191775?lang=zh)
- [Base URL 及鉴权](https://www.volcengine.com/docs/82379/1298459?lang=zh)
- [获取 API Key 并配置](https://www.volcengine.com/docs/82379/1541594?lang=zh)
- [环境变量配置指南](https://www.volcengine.com/docs/82379/1820161?lang=zh)
- [Doubao Seedance 2.0 系列教程](https://www.volcengine.com/docs/82379/2291680?lang=zh)
- [Doubao Seedance 2.0 系列提示词指南](https://www.volcengine.com/docs/82379/2222480?lang=zh)
- [视频生成教程](https://www.volcengine.com/docs/82379/2298881?lang=zh)
- [管理私域素材库](https://www.volcengine.com/docs/82379/2333600?lang=zh)
- [创建素材资产组合](https://www.volcengine.com/docs/82379/2318270?lang=zh)
- [创建素材资产](https://www.volcengine.com/docs/82379/2318271?lang=zh)
- [查询素材资产列表](https://www.volcengine.com/docs/82379/2318273?lang=zh)
- [查询素材资产信息](https://www.volcengine.com/docs/82379/2318274?lang=zh)
- [录入真人形象素材](https://www.volcengine.com/docs/82379/2315856?lang=zh)
- [资产功能使用规则](https://www.volcengine.com/docs/82379/2275639?lang=zh)

关键官方事实：

- 当前项目还没有火山 API Key 和模型 ID，所以真实创建视频任务、查询任务、列表对账、删除任务先只规划，不在当前阶段实现真实调用。
- 视频生成数据面 Base URL：`https://ark.cn-beijing.volces.com/api/v3`；视频生成任务接口支持 API Key 鉴权，服务端请求头使用 `Authorization: Bearer $ARK_API_KEY`。
- 管控面和素材资产管理接口使用 `https://ark.cn-beijing.volcengineapi.com/?Action=...&Version=2024-01-01` 形态；官方素材接口示例使用 Access Key 签名鉴权，和视频生成数据面 API Key 不是同一个接入形态。
- API Key 应配置在服务端环境变量中，不能硬编码；API Key 属于火山项目空间，可限制可鉴权的 Model ID / Endpoint ID 或可调用 IP，且不支持跨项目访问。
- 创建任务：`POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`。
- 查询单个任务：`GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}`。
- 查询任务列表：`GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks?page_num=...&page_size=...&filter.status=...&filter.task_ids=...&filter.model=...`。
- 取消或删除任务：`DELETE https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}`。
- 状态：`queued`、`running`、`cancelled`、`succeeded`、`failed`、`expired`。
- 只支持查询最近 7 天任务；生成视频 URL 和尾帧 URL 有效期为 24 小时，必须及时转存到现有本地化缓存链路。
- Seedance 2.0 系列开通和调用要求依赖账号余额或资源包；资源包不足后会转为按量后付费。
- Seedance 2.0 不支持直接上传含真人人脸的参考图/视频；可用平台认可的模型生成样片、预置虚拟人像、或授权真人素材资产。
- 私域素材库支持素材资产组和素材资产：创建素材资产组前需要在控制台签署授权函；素材资产可为图片、视频、音频，上传素材资产 API 是异步接口。
- 素材资产上传只支持公共可访问 URL，不支持 Base64；视频素材要求单个视频 2 到 15 秒、大小不超过 50 MB。
- 素材资产状态需要通过查询接口确认；`GetAsset` 即使返回 HTTP 200，也可能在响应中给出 `Status=Failed` 和错误原因。
- 素材资产接口返回的素材访问 URL 有效期为 12 小时；用于生成时应优先使用 `asset://<asset ID>`。
- 真人形象素材需要授权人完成真人认证和授权；授权完成后，素材进入私域素材库并获得 asset ID。
- 提示词中引用参考素材时应使用“图片1 / 视频1 / 音频1”等顺序标识；即使用 `asset://` 作为输入，也不要在提示词里直接用 Asset ID 代替素材描述。

---

## 2. 本项目现状结论

当前普通生成链路已经有一套可复用闭环：

- 页面入口：`src/app/generate/page.tsx` 已承载普通生成工作台；`src/app/generate/ip/page.tsx` 当前只是复用普通页面。用户已明确要求它必须是新的生成页面，不是在普通生成页里切一个模式。
- 导航入口：`src/components/ComposerTopbar.tsx` 当前已有 `(IP) 生成页` 顶部导航项，但位置在“生成视频”后面；正式方案应改为普通生成页顶部“我的项目”按钮旁新增 `IP生成` 按钮。`src/lib/navigation.ts` 中也已有 `(IP) 生成页` 导航项，需要统一命名和入口策略。
- 任务创建：`src/app/api/tasks/create/route.ts` 负责登录校验、参数校验、点数冻结、项目预算、创建 `VideoTask`、记录 `ProviderApiRequest`、调用 provider。
- 点数估算：`src/app/api/tasks/estimate/route.ts` 和 `src/lib/pricing.ts` 已有估算逻辑。
- Provider 适配：`src/lib/provider/jimeng.ts` 当前封装原有外部 create/status 调用，并且已经能构造 `text`、`image_url`、`video_url`、`audio_url`、`first_frame`、`last_frame`、`reference_image` 等内容结构。
- 状态终结：`src/lib/video/task-finalizer.ts` 负责拉 provider 状态、写回任务结果、触发本地化缓存、结算点数。
- 状态接口：`src/app/api/video/status/[id]/route.ts` 已通过 finalizer 统一返回任务状态。
- 数据模型：`prisma/schema.prisma` 的 `VideoTask` 已有 `provider`、`model`、`provider_task_id`、`provider_status`、`provider_payload_json`、`provider_raw_create_response_json`、`provider_raw_status_response_json`、`result_video_url`、`result_last_frame_url`、`params_json`、`source_metadata_json`、`reference_video_urls`、`reference_audio_urls` 等字段，正式版优先复用这些字段，不先做数据库迁移。

结论：这次先做独立页面入口和火山配置准备，不改普通生成页内部行为，不做真实 API 生成调用。API Key、模型 ID、资源包、素材资产权限到位后，再进入火山官方 Provider 和任务闭环实现。

---

## 3. 复用与新增边界

| 模块 | 处理方式 | 原因 |
| --- | --- | --- |
| `IP生成`入口 | 新增普通生成页顶部按钮，放在“我的项目”旁边 | 用户明确指定入口位置；这是最符合当前工作流的位置 |
| `(IP) 生成页`页面容器 | 新建独立页面，不在普通生成页内部切模式 | 用户明确要求这是新的生成页面，不是改普通生成页 |
| 页面基础控件 | 复用普通页可拆组件，但不要复用成同一个页面分支 | 可以复用项目选择、参考素材、提示词等能力，但页面边界要独立 |
| 登录态、用户信息、项目/视频卡归属 | 复用 | 和 provider 无关 |
| 点数估算、冻结、项目预算、失败退款、成功扣点 | 当前阶段不触发；API 到位后复用 | 当前 API Key 未拿到，不应进入真实生成和扣点；以后接入时不改原规则 |
| `VideoTask`、生成记录、后台最近生成、任务列表 | 复用 | 现有字段足够保存新 provider 的任务 ID、状态、结果 URL 和原始响应 |
| 本地化缓存、缩略图、尾帧、结果转存 | 复用，但必须接入新 provider 的结果字段 | 官方视频 URL 只有 24 小时有效，现有本地化链路正好需要继续用 |
| 原 `src/lib/provider/jimeng.ts` | 保留给普通生成页 | 避免影响旧页面 |
| 火山方舟官方 API 调用 | 后置 | API Key、模型 ID、资源包/权限未到位前不实现真实调用 |
| provider 路由 | 后置 | 生成 API 接入时再做 create/status/list/delete 路由 |
| IP 授权确认与素材来源记录 | 新增 | `(IP) 生成页`的核心差异是授权素材使用责任和可追溯 |
| 火山官方任务列表、取消/删除接口 | 后置 | 当前阶段记录方案；凭据到位后接入 |
| Seedance 2.0 资源包/余额检查 | 正式版纳入配置检查和上线验收 | 这是火山账号侧前置条件，不能用现有点数系统替代 |

---

## 4. 官方接口清单与项目映射

| 官方接口/配置 | 项目内入口 | 当前定位 | 说明 |
| --- | --- | --- | --- |
| `IP生成`入口按钮 | 普通生成页顶部“我的项目”旁 | 当前必做 | 按用户指定位置新增入口，跳转 `/generate/ip` |
| 独立 `/generate/ip` 页面 | 新页面容器 | 当前必做 | 不再把普通 `/generate` 当作同一个页面分支来改 |
| Base URL / 鉴权配置 | 后台配置检查或只读提示 | 当前必做 | 记录数据面和管控面的不同 Base URL、鉴权方式、环境变量要求 |
| API Key 配置 | 服务端环境变量和后台只读状态 | 当前只规划/检查 | API Key 未拿到，不实现真实生成调用 |
| Model ID / Endpoint ID | 后台只读状态 | 当前只规划/检查 | 需要火山控制台确认 |
| 资源包/余额 | 上线检查项 | 当前只规划/人工确认 | 官方文档没有给本应用可直接查余额的生成 API |
| 私域素材库/Asset Group | 授权素材配置清单 | 当前规划 | 涉及管控面接口和签名鉴权，凭据到位后再接 |
| `asset://<asset ID>` | 授权素材白名单 | 当前规划 | 当前先定义管理方式，不做真实素材 API 调用 |
| `POST /api/v3/contents/generations/tasks` 创建视频任务 | 未来复用 `POST /api/tasks/create` 并按 `provider=volcengine_ark` 路由 | API 到位后做 | 当前阶段忽略真实生成调用 |
| `GET /api/v3/contents/generations/tasks/{id}` 查询单个任务 | 未来复用 `GET /api/video/status/[id]` | API 到位后做 | 当前阶段不实现 |
| `GET /api/v3/contents/generations/tasks` 查询任务列表 | 未来后台诊断 API | API 到位后做 | 当前阶段只记录接口 |
| `DELETE /api/v3/contents/generations/tasks/{id}` 取消或删除任务 | 未来本地取消/删除 API | API 到位后做 | 当前阶段只记录状态和点数策略 |
| `callback_url` 回调 | 未来 provider callback route | API 到位后做 | 当前不搭公网回调 |

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

## 6. `(IP) 生成页`功能清单

### 6.1 当前阶段必须有

- 普通生成页顶部“我的项目”按钮旁新增 `IP生成` 按钮，点击进入 `/generate/ip`。
- `IP生成`入口在顶部导航和普通生成页头部操作区保持一致，不再使用 `(IP) 生成页` 作为按钮名。
- `/generate/ip` 是独立新页面，不在普通 `/generate` 页面里用 `isIpSurface` 改文案。
- 独立页面可以复用普通生成页的项目选择、参考素材、提示词、基础参数组件，但页面容器和提交逻辑独立。
- 当前 API Key 未到位，提交生成按钮不能触发火山真实生成，也不能冻结点数。
- 当前页面应展示“火山配置未完成 / 生成暂未开启”的明确状态。
- 当前可以先整理配置面板：Base URL、API Key 状态、Model ID / Endpoint ID、资源包/余额人工检查、素材库/授权状态。
- IP 授权确认和素材来源记录可以先做本地 metadata 设计，不发火山请求。
- 普通生成页继续走旧 provider，不被新页面影响。

### 6.2 API Key / 模型 / 资源包到位后再做

- 页面提交时传 `provider=volcengine_ark`。
- 服务端创建任务时保留原有点数冻结、项目预算、`VideoTask` 创建、`ProviderApiRequest` 记录和失败回滚。
- 新 provider 用火山官方 `POST /contents/generations/tasks` 创建任务。
- 状态查询用火山官方 `GET /contents/generations/tasks/{id}`。
- 成功后保存 `content.video_url`、`content.last_frame_url`、`usage`、`error` 等原始字段。
- 成功后立即进入现有本地化缓存，避免 24 小时 URL 过期。
- IP 授权确认：提交前必须让用户确认参考素材已授权，确认结果写入 `params_json` 或现有 metadata 字段。
- 素材来源记录：至少记录素材类型、来源说明、授权确认时间、提交用户。
- 缺少火山 API Key 或模型配置时，前端/服务端给出明确错误，不冻结点数。
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

### 6.3 仍不做

- 不改现有点数价格公式。
- 不新增数据库迁移，除非实现时发现现有 `params_json`、`source_metadata_json`、资产 metadata 无法承载授权素材审计。
- 不把火山 API Key 放到前端。
- 不把普通生成页切到新 provider。
- 不自动判断用户是否真的拥有 IP 法律授权；系统只做确认、记录和审计提示。

---

## 7. 功能决策总表

| 功能/模块 | 正式版是否做 | 处理方式 | 解决方案状态 | 说明 |
| --- | --- | --- | --- | --- |
| `IP生成`入口按钮 | 当前做 | 改造当前入口 | 已有方案 | 放在普通生成页顶部“我的项目”按钮旁边，按钮名固定为 `IP生成` |
| 普通生成页原链路 | 做保护 | 用当前 | 已有方案 | 不切 provider，不改扣点，不改 UI 主行为 |
| 独立 `/generate/ip` 页面 | 当前做 | 新增页面容器，可复用组件 | 已有方案 | 不再把普通 `/generate` 页面当同一个页面分支改 |
| 页面基础布局、提示词、参考图、比例、时长、分辨率、seed、水印、声音、尾帧 | 当前做页面准备 | 复用组件，不触发生成 | 已有方案 | 从普通页抽可复用组件，避免两页互相污染 |
| IP 授权确认 | 当前做 | 新增 | 已有方案 | 提交前强制确认，写入 `params_json` 或 `source_metadata_json`；当前不发火山请求 |
| 授权素材来源记录 | 当前做 | 新增 | 已有方案 | 记录素材类型、来源说明、授权确认时间、提交用户、关联资产 |
| 火山 `asset://<ASSET_ID>` 授权素材 | 当前做配置设计，API 后置 | 新增 | 需要配置/白名单方案 | 不允许普通用户任意输入；先做后台白名单或受控配置 |
| 创建视频任务 | API 到位后做 | 当前 `/api/tasks/create` + 新 provider | 已有方案 | 当前 API Key 未到位，先不冻结点数、不发外部请求 |
| 火山官方 create API | API 到位后做 | 新增 | 已有方案 | `POST /api/v3/contents/generations/tasks` |
| 查询单个任务 | API 到位后做 | 当前 status API + 修改 finalizer | 已有方案 | `GET /api/v3/contents/generations/tasks/{id}` |
| 火山官方任务列表 | API 到位后做 | 新增后台诊断 API | 已有方案 | `GET /api/v3/contents/generations/tasks`，用于最近 7 天对账 |
| 火山官方取消/删除 | API 到位后做 | 新增本地取消/删除 API | 需要细化状态规则 | `DELETE /api/v3/contents/generations/tasks/{id}`；排队任务释放冻结，终态删除保留本地审计 |
| 官方回调接收 | API 到位后做 | 新增 | 需要 live 验证回调格式 | 创建任务传 `callback_url`，回调只加速状态更新，轮询兜底 |
| Provider 适配 | API 到位后做 | 新增 | 已有方案 | 新建 `src/lib/provider/volcengine-ark.ts`，旧 `jimeng.ts` 保留 |
| Provider 路由 | API 到位后做 | 新增/重写调用点 | 已有方案 | `tasks/create` 和 `task-finalizer` 不能再直接绑定旧 provider |
| 扣点估算 | 做保护 | 用当前 | 已有方案 | `src/lib/pricing.ts` 不改公式 |
| 点数冻结、失败释放、成功扣点 | 当前不触发，API 到位后复用 | 用当前 | 已有方案 | 当前无 API Key 时不能冻结点数；以后 `allocateTaskCredits`、`settleTaskCredits` 保持原事务链路 |
| 项目预算 | 做保护 | 用当前 | 已有方案 | 不绕过项目预算账户和 ledger |
| ProviderApiRequest 记录 | API 到位后做 | 用当前，补 endpoint 名称 | 已有方案 | endpoint 从旧 `seedance.createVideoTask` 扩展出 `volcengine_ark.createVideoTask` 等 |
| 结果落库 | API 到位后做 | 用当前字段 | 已有方案 | 写 `result_video_url`、`result_last_frame_url`、raw response、usage |
| 本地化缓存 | API 到位后做保护 | 用当前 | 已有方案 | 官方 URL 24 小时有效，必须沿用 `startTaskLocalization` |
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

- `src/app/generate/page.tsx`：普通生成页主体和“我的项目”附近入口位置参考；不继续用它承载 IP 页面逻辑。
- `src/app/generate/ip/page.tsx`：IP 页面路由入口，需要改成独立页面容器。
- `src/components/ComposerTopbar.tsx`：顶部导航入口位置，需要把现有 `(IP) 生成页` 统一为 `IP生成` 并放到“我的项目”旁边。
- `src/lib/navigation.ts`：全局导航入口配置，需要统一按钮名和位置策略。
- `src/app/api/tasks/create/route.ts`：登录、校验、点数冻结、任务创建、ProviderApiRequest、失败回滚主链路。
- `src/app/api/video/status/[id]/route.ts`：任务状态入口。
- `src/lib/video/task-finalizer.ts`：状态终结、结果写回、扣点结算、本地化触发框架。
- `src/lib/video/task-localization-runner.ts`：结果本地化缓存。
- `src/lib/pricing.ts`：点数估算规则。
- `src/lib/credits/policy.ts`：冻结、释放、结算。
- `src/lib/costs/ledger.ts`：Provider 请求流水。
- `prisma/schema.prisma` 当前字段：`provider`、`model`、`provider_task_id`、`provider_status`、`params_json`、`source_metadata_json`、`provider_payload_json`、raw response、参考视频/音频 URL、结果 URL。

### 7.2 必须新增

- 当前阶段新增 `/generate/ip` 独立页面容器，必要时拆出 `src/components/ip-generate/*` 或同等组件目录。
- 当前阶段新增 `IP生成` 入口按钮，放在普通生成页“我的项目”旁边。
- 当前阶段新增火山配置状态 UI：API Key、Model ID / Endpoint ID、资源包/余额、素材库/授权状态。
- API 到位后新增 `src/lib/provider/volcengine-ark.ts`：官方 create/status/list/delete 调用。
- API 到位后新增 `src/lib/provider/video-provider.ts`：按 provider 选择 create/status/list/delete。
- API 到位后新增 `src/app/api/admin/provider/volcengine-ark/tasks/route.ts`：官方任务列表对账。
- API 到位后新增 `src/app/api/provider-callbacks/volcengine-ark/video/route.ts`：官方任务回调接收。
- API 到位后新增 `src/app/api/video/cancel/[id]/route.ts` 或复用现有任务操作入口：取消/删除任务。
- IP 授权确认 UI 和授权 metadata 写入。
- 参考视频/音频输入 UI、校验和官方 payload 映射。
- 火山配置检查：API Key、Base URL、Model ID、资源包/余额上线提示。

### 7.3 必须重写或改造

- `src/app/generate/page.tsx`：移除或停止扩展 `isIpSurface` 这类同页分支，普通页只负责普通生成和入口按钮。
- `src/components/ComposerTopbar.tsx`：入口名改为 `IP生成`，位置调整到“我的项目”旁边。
- `src/lib/navigation.ts`：入口名改为 `IP生成`，保持路由 `/generate/ip`。
- API 到位后改造 `src/app/api/tasks/create/route.ts`：不能固定调用旧 `createVideoTask`；要按 provider 路由，同时保持原扣点事务。
- API 到位后改造 `src/lib/video/task-finalizer.ts`：不能固定调用旧 `getVideoTaskStatus`；要按 `VideoTask.provider` 查询。
- `src/lib/provider/jimeng.ts` 的内容构造不能直接覆盖为火山官方实现；旧 provider 要保留，新 provider 单独实现。
- API 到位后任务取消逻辑要新增本地规则：排队取消释放冻结，运行中/终态删除不破坏本地审计。
- API 到位后生成页提交 payload 要区分 `/generate` 和 `/generate/ip`，避免普通生成页误走火山。

### 7.4 当前未有完整解决方案，进入实现前要确认

- 火山控制台实际可用的模型 ID 或 Endpoint ID。
- 火山 API Key 和线上环境变量配置位置。
- 火山资源包/余额是否足够，以及是否允许真实烟测消耗。
- 官方 callback 的真实 payload 是否和文档示例完全一致，需要 live 验证。
- 授权素材 `asset://` 的来源管理：先用受控配置还是做后台素材白名单。
- 参考视频/音频的服务端时长和大小检测方式：是否已有可复用媒体探测能力，还是先用上传阶段 metadata。
- `DELETE` 对 `running` 状态的真实表现和本地点数策略，需要用官方接口或文档进一步确认。

### 7.5 当前阶段要先整理的火山配置项

| 配置项 | 来源文档 | 当前处理 | 说明 |
| --- | --- | --- | --- |
| 视频生成 Base URL | Base URL 及鉴权 | 写入只读配置说明 | `https://ark.cn-beijing.volces.com/api/v3` |
| 素材/管控面 Base URL | 管理私域素材库、素材 API | 写入只读配置说明 | `https://ark.cn-beijing.volcengineapi.com/?Action=...&Version=2024-01-01` |
| 视频生成 API Key | 获取 API Key 并配置 | 暂无，先显示未配置 | 只能服务端环境变量；可限制 Model ID / Endpoint ID / 调用 IP |
| Access Key / 签名鉴权 | Base URL 及鉴权、素材 API | 暂无，先列为未解决 | 素材资产管理接口示例使用 HMAC-SHA256 签名 |
| Model ID / Endpoint ID | Base URL 及鉴权、Seedance 教程 | 暂无，先显示待配置 | 需要火山控制台确认可用模型 |
| 资源包/余额 | 资源包使用规则、Seedance 教程 | 人工检查项 | Seedance 2.0 开通需要余额或资源包余量 |
| 素材资产组 | CreateAssetGroup/ListAssetGroups | 先设计白名单和展示字段 | 首次创建素材组前需在控制台签署授权函 |
| 素材资产 | CreateAsset/ListAssets/GetAsset | 先设计状态字段 | 素材上传异步处理；状态可能 Processing / Available / Failed |
| 素材 URL | CreateAsset/GetAsset | 先设计限制提示 | 上传素材资产只支持公共 URL；视频素材 2 到 15 秒、不超过 50 MB |
| 真人形象素材 | 录入真人形象素材 | 先设计授权状态 | 需要授权人完成真人认证和授权；成功后使用 `asset://<asset ID>` |
| 资产合规 | 资产功能使用规则、合规承诺函 | 先设计确认文案 | 用户需确认素材权属、肖像权、声音权、商标/IP 授权 |
| 提示词素材引用 | Seedance 2.0 提示词指南 | 写入页面提示 | 提示词里使用“图片1 / 视频1 / 音频1”，不要直接用 Asset ID 代替素材描述 |
| 输出规格 | 视频生成教程 | 当前可配置但不请求 | 分辨率、比例、时长、水印等先做配置准备；真实请求后置 |

---

## 8. 推荐文件改造清单

### 当前阶段 Task 1: `IP生成`入口位置

Files:

- `src/app/generate/page.tsx`
- `src/components/ComposerTopbar.tsx`
- `src/lib/navigation.ts`

Steps:

1. 在普通生成页顶部“我的项目”按钮旁增加 `IP生成` 按钮，链接到 `/generate/ip`。
2. 把当前顶部导航里的 `(IP) 生成页` 命名统一为 `IP生成`。
3. 保持普通生成页原有“我的项目”按钮、项目选择和生成流程不变。
4. 检查移动端宽度下 `IP生成` 和“我的项目”不会挤压或换行异常。

Validation:

- 打开 `/generate`，能在“我的项目”旁看到 `IP生成`。
- 点击 `IP生成` 进入 `/generate/ip`。
- 普通生成页原提交流程不变。

### 当前阶段 Task 2: 独立 `/generate/ip` 页面

Files:

- `src/app/generate/ip/page.tsx`
- 可选新增 `src/components/ip-generate/IpGeneratePage.tsx`
- 可选新增 `src/components/ip-generate/IpGenerateConfigPanel.tsx`

Steps:

1. `/generate/ip` 不再直接导入普通 `../page` 作为同一个页面。
2. 新页面使用独立容器和标题，入口名保持 `IP生成`。
3. 可复用项目选择、参考素材、提示词和基础参数组件，但提交逻辑先禁用真实生成。
4. 页面显示火山配置状态：API Key 未配置、模型未配置、资源包/余额待人工确认、素材库待配置。
5. 生成按钮在配置未完成时展示不可用状态，不能触发 `/api/tasks/create`，不能冻结点数。

Validation:

- `/generate/ip` 是独立页面，不依赖 `isIpSurface` 修改普通页文案。
- 配置未完成时提交按钮不可用。
- `/generate` 页面不出现 IP 专属配置面板。

### 当前阶段 Task 3: 火山配置与素材准备面板

Files:

- `src/components/ip-generate/IpGenerateConfigPanel.tsx`
- 可选 `src/lib/provider/volcengine-ark-config.ts`

Steps:

1. 展示数据面 Base URL：`https://ark.cn-beijing.volces.com/api/v3`。
2. 展示管控面 Base URL：`https://ark.cn-beijing.volcengineapi.com/?Action=...&Version=2024-01-01`。
3. 展示 API Key、Model ID / Endpoint ID、资源包/余额、素材资产组、真人素材授权的状态。
4. 明确 API Key 只能服务端环境变量配置，不能前端输入或展示明文。
5. 明确素材资产上传只支持公共 URL，视频素材 2 到 15 秒、不超过 50 MB。
6. 明确真人素材必须走真人认证和授权，成功后使用 `asset://<asset ID>`。
7. 明确提示词中用“图片1 / 视频1 / 音频1”引用素材，不直接写 Asset ID。

Validation:

- 配置面板只展示状态和说明，不泄露任何 secret。
- 没有 API Key 时不发任何火山请求。

### API 到位后 Task 1: Provider 类型和常量

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

### API 到位后 Task 2: 新增火山方舟官方 Provider

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

### API 到位后 Task 3: Provider 路由层

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

### API 到位后 Task 4: `(IP) 生成页`提交参数

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

### API 到位后 Task 5: 参数构造和校验

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

### API 到位后 Task 6: 结果落库和本地化

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

### API 到位后 Task 7: 官方列表和取消/删除能力

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

### API 到位后 Task 8: 官方回调接收

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

### 当前阶段 Task 4 / API 到位后复查: 配置和上线检查

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
- 普通生成页回归：确认普通页原提交流程不变。
- 入口回归：确认 `/generate` 的“我的项目”旁出现 `IP生成`。
- 路由回归：点击 `IP生成` 进入独立 `/generate/ip` 页面。
- 禁用回归：API Key 未配置时，`/generate/ip` 不能触发真实生成、不能调用 `/api/tasks/create`、不能冻结点数。
- 配置面板回归：确认 Base URL、API Key 状态、Model ID / Endpoint ID、资源包/余额、素材库/授权状态展示正确且不泄露 secret。
- API 到位后再补 payload 构造测试：覆盖文本、首帧、首尾帧、多图参考、图+音频、视频+音频。
- API 到位后再补后台列表对账、取消/删除、回调 fixture 验证。

### 外部 API 验证

- 当前无 API Key，不做真实外部 API 验证。
- API 到位后做无 API Key dry-run：确认不会冻结点数后卡死；若已冻结必须释放。
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

1. 在普通生成页“我的项目”旁增加 `IP生成` 入口。
2. 把现有 `(IP) 生成页` 导航命名统一为 `IP生成`。
3. 把 `/generate/ip` 改成独立页面容器，不再直接复用普通页面分支。
4. 做火山配置状态面板和授权素材准备面板。
5. 保证 API Key 未配置时不会触发真实生成和扣点。
6. 验证普通生成页不受影响。
7. API Key、模型 ID、资源包/余额、素材权限到位后，再新增 `volcengine_ark` provider 和 provider 路由层。
8. API 到位后让 `/generate/ip` 提交新 provider，并增加授权确认。
9. API 到位后接通 finalizer、结果落库、本地化缓存、官方列表、取消/删除、回调接收。
10. API 到位后做 dry-run、真实烟测和公网回调/部署闭环。
11. 需要上线时，切到实际 sd2 生产工作树按 `youdoo-sites` 闭环部署。

---

## 12. 完成标准

### 12.1 当前阶段完成标准

- 普通生成页“我的项目”旁出现 `IP生成`。
- 点击 `IP生成` 进入独立 `/generate/ip` 页面。
- `/generate/ip` 不再依赖普通 `/generate` 的 `isIpSurface` 文案分支。
- API Key 未配置时不触发真实火山生成、不调用 `/api/tasks/create`、不冻结点数。
- 页面能展示火山配置状态和素材/授权准备状态。
- 普通生成页原流程不变。
- `npm run lint` 和 `npm run build` 通过。

### 12.2 API 到位后完成标准

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

---

## 13. 正式版执行清单

这一节作为后续落地的任务入口。当前结论是：除了真实火山 API Key、模型 ID、资源包和素材权限未到位导致不能直接生成外，入口、独立页面、配置状态、素材授权、复用边界、后续 provider 接入路径都已经明确。

### 13.1 当前阶段先做

- [ ] Batch IP-0：锁定范围和停止条件。
  - 只做入口、独立 `/generate/ip` 页面、火山配置状态、素材授权准备。
  - 不调用火山创建任务接口。
  - 不调用本地 `/api/tasks/create`。
  - 不冻结点数，不写入真实 `VideoTask`。
  - 不修改普通生成页的生成链路、扣点链路和旧 provider 行为。

- [ ] Batch IP-1：入口归位。
  - 在普通生成页顶部“我的项目”按钮旁增加 `IP生成` 入口。
  - 把已有 `(IP) 生成页` 命名统一为 `IP生成`。
  - 保持路由为 `/generate/ip`。
  - 检查桌面和移动端入口不挤压、不异常换行。

- [ ] Batch IP-2：独立页面拆分。
  - `src/app/generate/ip/page.tsx` 不再直接导入普通 `../page`。
  - 新建独立页面容器，例如 `src/components/ip-generate/IpGeneratePage.tsx`。
  - 普通 `/generate` 停止继续扩展 `isIpSurface`。
  - 可复用普通生成页的项目选择、提示词、参考素材和基础参数组件，但提交逻辑独立。

- [ ] Batch IP-3：火山配置状态面板。
  - 展示视频生成数据面 Base URL：`https://ark.cn-beijing.volces.com/api/v3`。
  - 展示素材/管控面 Base URL：`https://ark.cn-beijing.volcengineapi.com/?Action=...&Version=2024-01-01`。
  - 展示 API Key 是否已配置，只显示状态，不显示明文。
  - 展示 Model ID / Endpoint ID 待配置状态。
  - 展示资源包/余额人工检查项。
  - 展示素材资产组、素材资产、真人素材授权的待配置状态。

- [ ] Batch IP-4：素材授权和合规准备。
  - 增加 IP 授权确认控件。
  - 设计并记录 metadata 结构：`authorization_confirmed`、`source_type`、`source_note`、`asset_ids`、`confirmed_at`、`confirmed_by`。
  - 设计 `asset://<asset ID>` 白名单或受控配置入口，当前阶段不开放用户随意输入。
  - 页面提示素材资产上传限制：公共 URL、视频 2 到 15 秒、不超过 50 MB。
  - 页面提示真人素材必须完成真人认证和授权。
  - 页面提示提示词里用“图片1 / 视频1 / 音频1”引用素材，不直接写 Asset ID。

- [ ] Batch IP-5：生成禁用和安全边界。
  - API Key / Model ID 未配置时，生成按钮不可用。
  - 不出现“会扣点”或类似误导状态。
  - 不发火山请求。
  - 不创建本地任务。
  - 普通 `/generate` 仍能按原链路生成。

- [ ] Batch IP-6：当前阶段验证。
  - `npm run lint`。
  - `npm run build`。
  - 浏览器验证 `/generate`：`IP生成` 在“我的项目”旁，普通生成不受影响。
  - 浏览器验证 `/generate/ip`：独立页面、配置状态、授权准备、生成禁用状态可见。
  - 网络验证：`/generate/ip` 当前阶段不会请求 `/api/tasks/create`。

### 13.2 API 到位后再开

- [ ] Batch API-1：环境和配置。
  - 配置 `VOLCENGINE_ARK_API_KEY`。
  - 配置 `VOLCENGINE_ARK_BASE_URL`。
  - 配置 `VOLCENGINE_ARK_VIDEO_MODEL` 或 Endpoint ID。
  - 确认火山账号已开通 Seedance 2.0，且资源包/余额允许真实烟测。
  - 继续保证前端不接触 API Key。

- [ ] Batch API-2：Provider 基础层。
  - 新增 `src/lib/provider/volcengine-ark.ts`。
  - 新增或改造 provider router，例如 `src/lib/provider/video-provider.ts`。
  - create/status/list/delete 都走官方接口。
  - 错误格式统一转成本地 provider failure。
  - 保存 request payload、raw create response、raw status response。

- [ ] Batch API-3：创建任务链路。
  - `/generate/ip` 提交时传 `provider=volcengine_ark`。
  - 继续复用 `/api/tasks/create` 的登录、权限、点数冻结、项目预算和失败回滚。
  - 缺火山配置时直接返回配置错误，不冻结点数。
  - 成功创建后保存官方 task id 到 `provider_task_id`。

- [ ] Batch API-4：官方 payload 映射。
  - 文本生视频：`text`。
  - 首帧：`text + image_url(first_frame)`。
  - 首尾帧：`text + image_url(first_frame) + image_url(last_frame)`。
  - 多图参考：1 到 9 张 `reference_image`。
  - 视频参考：最多 3 个 `reference_video`。
  - 音频参考：`reference_audio`，且必须搭配图片或视频。
  - 授权素材：只允许受控 `asset://<asset ID>`。
  - `resolution`、`ratio`、`duration`、`seed`、`watermark` 走官方顶层字段。
  - `frames` 和 `duration` 互斥。

- [ ] Batch API-5：状态、结算和本地化。
  - finalizer 按 `task.provider` 查询火山官方状态。
  - `queued/running/succeeded/failed/cancelled/expired` 映射到本地状态。
  - 成功后写入 `result_video_url` 和 `result_last_frame_url`。
  - 成功后立即触发现有本地化缓存，避免官方 URL 24 小时过期。
  - 失败、取消、过期都按现有点数释放/结算规则处理。

- [ ] Batch API-6：后台对账、取消和回调。
  - 新增后台官方任务列表查询，用于最近 7 天对账。
  - 新增或复用本地取消/删除入口，调用官方 DELETE。
  - 排队任务取消释放冻结。
  - 终态删除只删除外部任务或停止外部保留，不删除本地审计记录。
  - 新增火山 callback route，真实回调不可测时保留轮询兜底。

- [ ] Batch API-7：真实烟测。
  - 先 dry-run：缺配置不冻结点数、不创建任务。
  - 再真实小任务：必须确认 API Key、模型、资源包/余额和授权素材都已到位。
  - 记录官方 task id、本地 task id、点数流水、任务状态、生成记录、视频 URL、本地化结果。
  - 验证后台列表能对账到同一个官方 task id。

### 13.3 不做事项

- [ ] 不把火山 API Key 放到前端。
- [ ] 不自动判断用户是否真的拥有 IP 法律授权。
- [ ] 不绕过现有点数、项目预算、失败退款和任务记录链路。
- [ ] 不把普通生成页默认切到火山 provider。
- [ ] 不在 API 缺失时做假生成、假进度或假扣点。
- [ ] 不直接上传含真人人脸参考图/视频，除非走官方认可的授权素材资产。
- [ ] 不默认做数据库迁移，除非现有 JSON 字段无法承载授权审计。

### 13.4 未解决问题

- [ ] 火山控制台实际可用的 Model ID / Endpoint ID。
- [ ] 火山 API Key 和生产环境变量配置位置。
- [ ] 火山资源包/余额是否足够，以及是否允许真实烟测消耗。
- [ ] 素材 `asset://<asset ID>` 由后台白名单管理，还是先用配置文件管理。
- [ ] 官方 callback 真实 payload 需要 API 到位后 live 验证。
- [ ] 参考视频/音频的服务端媒体探测能力是否已有可复用实现。
- [ ] 官方 DELETE 对 `running` 状态的真实行为和本地点数策略需要再确认。

### 13.5 Git 和上线计划

- 当前规划阶段只修改本规划文档。
- 实现阶段建议新建独立任务分支或在当前分支做聚焦提交，避免混入当前工作区已有大量未提交改动。
- 提交分组建议：
  - 提交 1：入口归位和命名统一。
  - 提交 2：独立 `/generate/ip` 页面和配置面板。
  - 提交 3：授权确认和素材 metadata。
  - 提交 4：API 到位后的 `volcengine_ark` provider。
  - 提交 5：provider router、finalizer、结果本地化。
  - 提交 6：后台对账、取消/删除、回调和真实烟测修复。
- 如果要上线到 `sd2.youdoodesign.com`，必须先确认实际生产工作树，再按 `youdoo-sites build sd2`、`youdoo-sites restart sd2`、公网验证和健康守护周期复查闭环。
