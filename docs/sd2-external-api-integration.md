# SD2 视频生成 API 外部接入说明

本文面向外部系统接入方，说明如何通过 SD2 后台配置的 API token 调用 Seedance 2.0 视频生成能力，并让生成任务、点数扣费、成本记录和后台审计进入同一套 SD2 管理系统。

## 1. 接入范围

当前对外 Bearer token 支持以下能力：

- 检查接口配置：`GET /api/codex/config`
- 上传参考素材：`POST /api/codex/assets/upload`
- 创建视频生成任务：`POST /api/codex/video/create`
- 兼容创建入口：`POST /api/tasks/create`

任务状态查询、下载、后台产出和成本复盘目前仍沿用站内登录态与管理员后台：

- 任务详情：`/tasks/:taskId`
- 产出留存：`/admin/outputs`
- 计费与成本：`/admin/costs`

如果外部系统需要全自动轮询状态，请在接入前确认是否已开通独立的 Bearer 状态接口；否则由 SD2 管理员在站内查看任务状态和结果。

建议接入方式是服务端到服务端调用。不要从外部前端浏览器直接调用这些接口，因为 API token 会暴露给用户，也可能受到跨域策略限制。

## 2. 管理员配置

由 SD2 管理员完成一次性配置。

1. 登录 SD2 管理后台。
2. 打开 `/admin/integrations`。
3. 在“Codex 视频接口”中启用接口。
4. 设置后台来源名称，例如 `Codex API` 或外部系统名称。
5. 绑定扣费用户，支持按邮箱、用户名或用户 ID 绑定。
6. 填入一段足够长的随机 token。
7. 保存配置。

token 只会以 SHA-256 哈希保存，页面不会回显明文。请由接入方妥善保存明文 token；如果遗失，需要管理员重新设置。

建议生成 token：

```bash
openssl rand -hex 32
```

后台保存后，所有通过该 token 创建的任务都会绑定到配置中的用户，并记录来源信息：

- `source_type = codex_api`
- `source_label = 后台配置的来源名称`
- `source_request_id = 请求头或请求体传入的外部请求 ID`

内部配置固定保存在 `PlatformSetting`，key 为：

```text
codex_video_api_v1
```

该配置只保存安全字段：

```json
{
  "enabled": true,
  "source_label": "Codex API",
  "user_selector": {
    "type": "email",
    "value": "admin@local.test"
  },
  "token_hash": "sha256:...",
  "token_preview": "abcd...wxyz"
}
```

管理员更新配置后，系统会写入操作日志：

```text
codex_api_config_update
```

## 3. 鉴权方式

推荐使用 `Authorization` 请求头：

```http
Authorization: Bearer <API_TOKEN>
```

兼容备用请求头：

```http
x-codex-api-token: <API_TOKEN>
```

不要把 token 放在 URL 查询参数中，也不要在日志、工单或截图中暴露 token。

## 4. 配置检查

接入方拿到 token 后，先调用配置检查接口。

```bash
curl -sS "$BASE_URL/api/codex/config" \
  -H "Authorization: Bearer $SD2_API_TOKEN"
```

成功响应示例：

```json
{
  "ok": true,
  "enabled": true,
  "ready": true,
  "source_type": "codex_api",
  "source_label": "Codex API",
  "config_source": "sd2_admin_backend",
  "endpoints": {
    "upload_asset": "/api/codex/assets/upload",
    "create_video": "/api/codex/video/create",
    "create_video_direct": "/api/tasks/create"
  },
  "auth": {
    "type": "bearer",
    "header": "Authorization"
  }
}
```

常见失败：

- `401 codex_api_invalid_token`：token 错误。
- `503 codex_api_disabled`：后台未启用接口。
- `503 codex_api_not_configured`：后台未设置 token。
- `503 codex_api_user_not_found`：绑定用户不存在。
- `403 codex_api_user_inactive`：绑定用户不可用。

## 5. 上传参考素材

如果外部系统有本地图片文件，建议先上传到 SD2，再用返回的 `reference_image_id` 创建视频任务。

```bash
curl -sS "$BASE_URL/api/codex/assets/upload" \
  -H "Authorization: Bearer $SD2_API_TOKEN" \
  -H "x-codex-request-id: ext-20260605-0001" \
  -H "x-tab-id: ext-session-20260605-0001" \
  -F "file=@/path/to/reference.png"
```

成功响应会包含：

```json
{
  "success": true,
  "workspaceId": "workspace_id",
  "asset": {
    "id": "asset_id",
    "originalUrl": "https://...",
    "thumbnailUrl": "https://...",
    "isPubliclyReachable": true
  },
  "referenceImageId": "reference_image_id",
  "reference_image_id": "reference_image_id",
  "workspaceAssetId": "workspace_asset_id",
  "source_type": "codex_api",
  "source_label": "Codex API",
  "source_request_id": "ext-20260605-0001"
}
```

素材会进入 SD2 的统一链路：

```text
Asset -> ReferenceImage -> WorkspaceAsset -> VideoTask.reference_image_ids
```

这样后台可以追溯、复用、重试和审计参考图。

如果上传后要把返回的 `reference_image_id` 用在创建任务里，上传请求和创建请求必须使用同一个 `x-tab-id`。这是 SD2 用来定位生成工作台的标识；不一致时，创建任务会认为参考图不在当前工作台，返回 `REFERENCE_IMAGE_NOT_IN_WORKSPACE`。

首尾帧模式还会用到上传响应里的 `asset.originalUrl`。如果本地图片要作为 `first_frame_url` 或 `last_frame_url`，必须先调用本上传接口，确认 `asset.isPubliclyReachable=true`，再把返回的 `asset.originalUrl` 填入创建任务请求。不要把 `/Users/.../frame.png`、`C:\...`、`file://...`、`localhost` 或内网地址直接填到 `first_frame_url` / `last_frame_url`，因为 Seedance Provider 无法访问调用方本地文件。

## 6. 创建视频任务

创建任务使用：

```http
POST /api/codex/video/create
```

该入口会复用 SD2 站内正常生成链路，内部等价转发到：

```http
POST /api/tasks/create
```

如果接入方直接调用 `/api/tasks/create` 并携带 Bearer token，也会按 Codex API 来源处理；对外推荐优先使用 `/api/codex/video/create`，便于接口边界清晰。

真实生成会消耗点数和供应商额度，因此自动化来源必须显式声明这是用户授权的真实扣费生成。否则接口会返回 `403 PAID_GENERATION_AUTH_REQUIRED`。

必须携带以下扣费授权头：

```http
x-paid-generation-intent: user_authorized_real_provider
x-paid-generation-reason: 用户已确认本次真实生成并允许扣费
```

推荐同时传入外部请求 ID，便于幂等和后台追踪：

```http
x-codex-request-id: ext-20260605-0001
```

如果本次任务使用上传接口返回的 `reference_image_id`，还必须传入与上传时相同的工作台 ID：

```http
x-tab-id: ext-session-20260605-0001
```

建议接入方把 `x-tab-id` 当作“一次生成会话 ID”。同一批上传素材和创建任务用同一个值；不同用户或不同生成会话使用不同值。

### 6.1 文生视频示例

```bash
curl -sS "$BASE_URL/api/codex/video/create" \
  -H "Authorization: Bearer $SD2_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-codex-request-id: ext-20260605-0001" \
  -H "x-tab-id: ext-session-20260605-0001" \
  -H "x-paid-generation-intent: user_authorized_real_provider" \
  -H "x-paid-generation-reason: 用户已确认本次真实生成并允许扣费" \
  -d '{
    "prompt": "A clean cinematic product shot of a white sneaker rotating on a glass platform, soft studio light.",
    "generation_mode": "all_in_one_reference",
    "ratio": "16:9",
    "duration": 5,
    "resolution": "720p",
    "idempotency_key": "ext-20260605-0001",
    "client_name": "external-system"
  }'
```

### 6.2 使用已上传参考图

```bash
curl -sS "$BASE_URL/api/codex/video/create" \
  -H "Authorization: Bearer $SD2_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-codex-request-id: ext-20260605-0002" \
  -H "x-tab-id: ext-session-20260605-0002" \
  -H "x-paid-generation-intent: user_authorized_real_provider" \
  -H "x-paid-generation-reason: 用户已确认本次真实生成并允许扣费" \
  -d '{
    "prompt": "Use the reference product image. Create a slow premium reveal shot with realistic lighting.",
    "generation_mode": "all_in_one_reference",
    "reference_image_ids": ["reference_image_id"],
    "ratio": "16:9",
    "duration": 5,
    "resolution": "720p",
    "idempotency_key": "ext-20260605-0002",
    "client_name": "external-system"
  }'
```

### 6.3 使用公网 HTTPS 图片

也可以直接传 `reference_image_urls`。URL 必须是公网可访问的 HTTPS 地址，不能是 localhost、内网 IP 或临时本地地址。

```json
{
  "prompt": "Create a fashion campaign video based on the reference image.",
  "generation_mode": "all_in_one_reference",
  "reference_image_urls": ["https://example.com/reference.jpg"],
  "ratio": "9:16",
  "duration": 5,
  "resolution": "720p",
  "idempotency_key": "ext-20260605-0003",
  "client_name": "external-system"
}
```

Codex API 来源的 `reference_image_urls` 会被导入为站内素材和参考图，再进入生成链路。

### 6.4 首尾帧转场：本地首尾帧先上传再创建

`first_last_frame` 可以不传普通 `reference_image_ids` / `reference_image_urls`，只依赖 `first_frame_url` 和 `last_frame_url`。这两个字段必须是 Provider 可访问的公开 HTTPS URL；本地文件需要先上传。

第一步，上传首帧，记录响应里的 `asset.originalUrl`：

```bash
curl -sS "$BASE_URL/api/codex/assets/upload" \
  -H "Authorization: Bearer $SD2_API_TOKEN" \
  -H "x-codex-request-id: ext-ppt-fpv-0001-first" \
  -H "x-tab-id: ext-session-ppt-fpv-0001" \
  -F "file=@/path/to/slide-01-bg.png"
```

第二步，上传尾帧，使用同一个 `x-tab-id`：

```bash
curl -sS "$BASE_URL/api/codex/assets/upload" \
  -H "Authorization: Bearer $SD2_API_TOKEN" \
  -H "x-codex-request-id: ext-ppt-fpv-0001-last" \
  -H "x-tab-id: ext-session-ppt-fpv-0001" \
  -F "file=@/path/to/slide-02-bg.png"
```

两个上传响应都必须确认：

```json
{
  "asset": {
    "originalUrl": "https://public-object-url.example/asset.png",
    "isPubliclyReachable": true
  }
}
```

第三步，用两个公开 URL 创建首尾帧任务：

```bash
curl -sS "$BASE_URL/api/codex/video/create" \
  -H "Authorization: Bearer $SD2_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-codex-request-id: ext-ppt-fpv-0001" \
  -H "x-tab-id: ext-session-ppt-fpv-0001" \
  -H "x-paid-generation-intent: user_authorized_real_provider" \
  -H "x-paid-generation-reason: 用户已确认本次 PPT 首尾帧转场真实生成并允许扣费" \
  -d '{
    "prompt": "Create a 5-second FPV camera transition from the first slide background to the second slide background. No text, no logo, no UI, no watermark. Use an ease-in-out motion curve: slow start, faster middle movement, slow settle into the final frame.",
    "generation_mode": "first_last_frame",
    "first_frame_url": "https://public-object-url.example/slide-01-bg.png",
    "last_frame_url": "https://public-object-url.example/slide-02-bg.png",
    "ratio": "16:9",
    "duration": 5,
    "resolution": "720p",
    "idempotency_key": "ext-ppt-fpv-0001",
    "client_name": "external-system"
  }'
```

如果接入方封装本地 CLI 或 helper，建议提供 `--first-frame-file` 和 `--last-frame-file` 参数，在 helper 内部完成上传、检查 `isPubliclyReachable`、取出 `asset.originalUrl`、再创建任务。首尾帧模式必须覆盖“没有 `--reference-file`”的调用路径；在 Bash 3.2 + `set -u` 环境下，空参考图数组应按空数组处理，不能因为缺少普通 reference file 出现 unbound variable 后直接退出。

## 7. 请求字段

必填字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `prompt` | string | 视频提示词，不能为空 |
| `generation_mode` | string | 生成模式，默认可用 `all_in_one_reference` |
| `ratio` | string | 画幅比例 |
| `duration` | number | 视频时长，单位秒 |
| `resolution` | string | 分辨率 |

支持的枚举：

| 字段 | 可选值 |
|---|---|
| `generation_mode` | `all_in_one_reference`, `first_last_frame`, `smart_multi_frame` |
| `ratio` | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| `duration` | `4` 到 `15` |
| `resolution` | `480p`, `720p`, `1080p` |

常用可选字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `reference_image_ids` | string[] | 站内参考图 ID，推荐使用上传接口返回值；`first_last_frame` 直接传 `first_frame_url` 时不要求提供 |
| `reference_image_urls` | string[] | 公网 HTTPS 参考图 URL，最多 9 张；`first_last_frame` 直接传 `first_frame_url` 时不要求提供 |
| `first_frame_url` | string | Provider 可访问的首帧公开 HTTPS URL；本地文件必须先上传并使用 `asset.originalUrl` |
| `last_frame_url` | string | Provider 可访问的尾帧公开 HTTPS URL；首尾帧转场强烈建议提供 |
| `frame_image_urls` | string[] | 智能多帧图片 URL，至少 2 张 |
| `reference_video_urls` | string[] | 参考视频 URL，最多 3 个 |
| `reference_audio_urls` | string[] | 参考音频 URL，最多 3 个 |
| `seed` | number | 随机种子，默认 `-1` |
| `generate_audio` | boolean | 是否生成音频 |
| `return_last_frame` | boolean | 是否返回尾帧 |
| `watermark` | boolean | 是否带水印 |
| `idempotency_key` | string | 幂等键，强烈建议每次外部请求都传 |
| `source_request_id` | string | 外部请求 ID，也可用 `x-codex-request-id` |
| `client_name` | string | 外部系统名称 |
| `project_id` | string | 指定项目归属，不传则使用绑定用户的默认生成项目 |

常用请求头：

| 请求头 | 是否必需 | 说明 |
|---|---|---|
| `Authorization` | 是 | `Bearer <API_TOKEN>` |
| `x-codex-request-id` | 推荐 | 外部请求 ID，用于后台追踪 |
| `x-tab-id` | 使用上传参考图时必需 | 同一批上传素材和创建任务必须一致 |
| `x-paid-generation-intent` | 真实生成必需 | 固定为 `user_authorized_real_provider` |
| `x-paid-generation-reason` | 真实生成必需 | 用户授权真实扣费的原因，至少写清楚业务来源 |

## 8. 创建响应

成功响应示例：

```json
{
  "id": "internal_task_id",
  "provider_task_id": "seedance_task_id",
  "status": "submitted",
  "estimated_cost": 32,
  "frozen_cost": 32,
  "workspace_id": "workspace_id",
  "project_id": "project_id",
  "snapshot_id": "snapshot_id",
  "reference_image_ids": ["reference_image_id"],
  "source_type": "codex_api",
  "source_label": "Codex API",
  "source_request_id": "ext-20260605-0002",
  "created_at": "2026-06-05T00:00:00.000Z"
}
```

字段说明：

- `id`：SD2 内部任务 ID，用于后台查询和审计。
- `provider_task_id`：Seedance 官方任务 ID。
- `estimated_cost`：本次任务预估点数。
- `frozen_cost`：创建时冻结的点数。
- `source_*`：外部来源追踪字段，会显示在后台产出和成本页面。

系统还会把来源信息写入任务内部参数和元数据，供管理员排查：

- `VideoTask.source_type`
- `VideoTask.source_label`
- `VideoTask.source_request_id`
- `VideoTask.source_metadata_json`
- `VideoTask.params_json.source`

如果同一个绑定用户重复提交相同 `idempotency_key`，接口会返回已存在任务，并带上 `deduplicated: true`。

## 9. 任务状态与结果

当前 Bearer token 创建任务后，外部响应会立即返回 `id` 和 `provider_task_id`。创建响应只代表任务已提交，不代表生成完成。SD2 会在后台自动轮询 Provider 状态；任务成功后，系统会优先把视频下载到服务器本地并写入 `local_video_path`，站内页面和后台预览优先使用这个本地地址。

管理员可在以下位置查看：

- `/tasks/:taskId`：任务详情和结果。
- `/admin/outputs`：产出留存、来源请求、官方任务 ID、实际扣除。
- `/admin/costs`：点数、供应商成本、Provider 请求异常、总账导出。

站内状态刷新接口为：

```http
GET /api/video/status/:taskId?refresh=true
```

该接口目前要求站内登录态，不接受外部 Bearer token。外部系统如果必须自动轮询，请在接入前确认是否已新增或开放专用状态接口。

无论由 SD2 后台自动刷新、站内登录态轮询，还是由后续专用 Bearer 状态接口轮询，都应持续查询到终态再处理结果。判断终态时看 `local_status` 或 `status` 是否为 `succeeded`、`failed`、`cancelled`。如果创建后短时间内接口仍显示 `running`，可能只是状态刷新滞后；继续用同一个 `taskId` 轮询，不要因为状态暂未刷新就重新创建任务或更换新的 `idempotency_key`。

结果地址语义：

- `result_video_url`：Provider 返回的源视频地址，可能是临时签名 URL，不保证长期可预览或可下载。
- `local_video_path`：SD2 成功落盘后的站内本地视频路径，例如 `/videos/<taskId>.mp4`，长期预览和下载优先使用它。
- `/api/video/thumbnail/:taskId`：站内截图接口。任务成功并落盘后，SD2 会尽量自动生成缩略图；如果自动生成失败，接口仍会按需尝试抽帧。

管理员做真实生成验收时，需要闭环到结果文件和账本：

1. 用站内登录态刷新 `/api/video/status/:taskId?refresh=true`，直到状态为 `succeeded`、`failed` 或 `cancelled`。
2. 成功后优先通过 `local_video_path`、站内任务详情或下载接口获取视频。
3. 等视频下载完整结束后，再对下载文件运行 `ffprobe`，确认视频可播放、时长和分辨率正常。
4. 在 `/admin/outputs` 检查任务来源、外部请求 ID、Provider 任务 ID 和实际扣除。
5. 在 `/admin/costs` 检查点数结算、Provider 请求记录和官方扣费记录。

## 10. 扣费与成本记录

任务创建成功后，SD2 会立即冻结绑定用户点数，并记录：

- `VideoTask`：任务主体、来源、参数、项目归属。
- `CreditLedger task_freeze`：点数冻结。
- `CostLedger estimate`：规则预估成本。
- `ProviderApiRequest`：供应商请求记录。
- `CostLedger provider_request_submitted`：供应商已接受请求记录。
- `OperationLog generation_create_codex_api`：Codex API 来源的创建操作。

任务进入终态后：

- 成功：写入 `task_success_deduct`，更新 `actual_cost`，写入临时规则结算。
- 失败或取消：释放冻结点数，写入 `task_failed_refund`。
- 如果 Seedance 返回实际扣费字段，会写入 `official_charge` 成本账，并更新官方扣费金额和币种。

Provider 请求记录也会带上来源摘要，供应商创建失败时仍保留任务和来源归因，并通过失败处理释放冻结点数。

外部系统不需要直接操作点数或成本账；只需要保证请求里带上稳定的 `idempotency_key` 和 `x-codex-request-id`，方便后台追踪。

成本导出 `/api/admin/costs/export` 会包含：

- `task_source_type`
- `task_source_label`
- `task_source_request_id`
- `provider_task_id`
- `provider_request_id`
- `official_charge_id`

## 11. 常见错误

| HTTP 状态 | 错误 | 处理方式 |
|---|---|---|
| 400 | `ratio 无效` | 使用支持的比例 |
| 400 | `duration 必须是 4-15` | 调整时长 |
| 400 | `resolution 无效` | 使用 `480p`, `720p`, `1080p` |
| 400 | `REFERENCE_IMAGE_NOT_IN_WORKSPACE` | 先用上传接口导入参考图，再传 `reference_image_ids` |
| 401 | `codex_api_invalid_token` | 检查 token 是否正确 |
| 403 | `PAID_GENERATION_AUTH_REQUIRED` | 增加真实扣费授权请求头 |
| 403 | 绑定用户不可用 | 联系管理员检查绑定用户状态 |
| 503 | 接口未启用或未配置 | 联系管理员在 `/admin/integrations` 开启并保存配置 |
| 502 | `PROVIDER_CREATE_FAILED` | Seedance 创建失败，SD2 会返还冻结点数，管理员可在后台查看失败原因 |

管理员排查时，如果出现以下现象，说明链路未闭环：

- 坏 token 调用 `/api/codex/config` 仍返回 200：鉴权有安全问题。
- Codex 创建的任务 `source_type` 变成 `web`：来源归因断了。
- 成功任务没有 `task_success_deduct`：点数结算断了。
- Provider 返回实际扣费，但没有 `CostLedger official_charge`：成本对账断了。
- 参考图只停留在 URL，没有形成 `Asset -> ReferenceImage -> WorkspaceAsset`：后续复用、重试和后台检查会丢来源。

## 12. 接入限制与上线前验收

这一节是上线前必须确认的边界，避免外部系统按“完整开放平台 API”理解当前接口。

### 12.1 当前能力边界

- 当前 Bearer token 能完成配置检查、素材上传和创建任务，但不能直接完成外部状态轮询、结果下载和后台成本查询。
- `/api/codex/config` 返回 `ready: true` 只代表后台 token、开关和绑定用户可用，不代表 Seedance API key、公网对象存储、供应商余额或 Provider 服务一定可用。
- `/api/codex/video/create` 返回 `submitted` 只代表 SD2 已创建内部任务并把请求提交给 Provider，不代表视频已经生成完成。
- SD2 会对新任务执行后台状态刷新、点数结算和本地视频落盘；站内状态刷新接口和补偿脚本仍会作为兜底。外部不要把创建响应当作完成信号。
- `callback_url` 会透传给 Seedance Provider，但它不是 SD2 后台结算回调。即使外部收到 Provider 回调，SD2 后台也仍需要通过站内状态刷新或后续专用接口更新任务和账本。

### 12.2 调用方安全边界

- 只能服务端到服务端调用，不要从浏览器前端、移动端直连或公开脚本里调用。
- API token 不要写入 URL、客户端配置、前端包、公开日志、工单截图或报错文本。
- 当前是单 token 绑定一个扣费用户的模式。如果多个外部合作方共用同一 token，就会共用同一个来源标签、扣费用户和撤销开关。
- 如果需要按合作方分别限额、分别撤销、分别审计，应该为后续版本增加多 token 或多来源配置，而不是把同一个 token 分发给所有人。

### 12.3 请求与幂等细节

- `idempotency_key` 是真正的去重键，按绑定用户和 key 去重；同一个 key 即使换 prompt 或参数，也会返回旧任务。
- `source_request_id` 和 `x-codex-request-id` 只用于追踪，不负责去重。
- 建议外部每个业务订单、每次用户确认生成都生成唯一 `idempotency_key`，并把同一个值或可关联值写入 `x-codex-request-id`。
- 使用上传参考图时，同一批上传和创建必须使用同一个 `x-tab-id`；不同生成会话不要长期复用同一个 `x-tab-id`。
- 如果创建任务时不显式传 `reference_image_ids`，接口可能会使用该 `x-tab-id` 工作台里的已有参考图。外部接入方应显式传本次要用的参考图 ID。
- 例外：`generation_mode=first_last_frame` 且已显式传 `first_frame_url` / `last_frame_url` 时，可以不传普通 `reference_image_ids` / `reference_image_urls`。

### 12.4 素材与公网访问

- 上传接口最大支持 50MB 文件。
- 上传接口允许图片、视频和音频 MIME，但 `reference_image_ids` 生成链路应使用图片素材。
- 上传响应里的 `isPubliclyReachable` 必须重点检查。若为 `false`，说明公网对象存储失败并回退到本地存储，Seedance 可能无法读取该素材。
- 直接传 `reference_image_urls` 时必须是公网 HTTPS URL，不支持 localhost、内网 IP、短期本地地址或需要鉴权的私有 URL。
- 对 `first_frame_url`、`last_frame_url`、`frame_image_urls` 这类直接 URL 字段，也应使用公网 HTTPS URL。
- 首尾帧本地图片不要直接传本地路径；先上传，确认 `asset.isPubliclyReachable=true`，再使用上传响应里的 `asset.originalUrl`。

### 12.5 状态轮询与结果下载

- 创建任务后必须轮询 `/api/video/status/:taskId?refresh=true` 或已开通的等价状态接口，直到 `local_status` / `status` 进入 `succeeded`、`failed`、`cancelled`。
- 不要只看创建接口返回的 `submitted`，也不要因为短暂 `running` 就重新创建任务；继续轮询原 `taskId`。
- 成功任务优先使用 `local_video_path`。如果暂时没有该字段，说明本地落盘可能仍在进行或补偿任务尚未完成；继续轮询或联系管理员检查任务本地化状态。
- 不要把 Provider 的 `result_video_url` 当作长期保存地址。它可能过期，接入方也不要在日志、工单或文档里记录完整签名 URL。
- 下载结果视频时，等待 `curl -L --fail --output output.mp4 "<video-url>"` 完整退出，再进入验收步骤。
- 下载后建议先确认文件大小稳定，再运行 `ffprobe`、抽帧或生成 contact sheet。
- 如果提前 `ffprobe` 报 `moov atom not found`，通常是 MP4 仍是部分下载文件，不一定是 Provider 返回了坏视频。先重新完整下载并确认文件大小，再判断是否失败。

### 12.6 生成参数与业务预期

- `generate_audio` 默认是 `false`。如果业务需要音频，必须显式传 `generate_audio: true`。
- `duration` 只能是 4 到 15 秒，`resolution` 只能是 `480p`、`720p`、`1080p`。
- `project_id` 不是任意字符串。绑定用户必须有该项目的生成权限，否则会返回权限错误。
- `client_name` 建议固定为外部系统名称，方便管理员在 `source_metadata_json` 和审计日志里排查来源。

### 12.7 PPT / 演示首尾帧转场建议

- 首帧和尾帧优先使用无文字背景图，不要把 PPT 页面上的文字、logo、UI 控件或水印直接放进首尾帧。
- prompt 明确写出 `No text, no logo, no UI, no watermark`，避免模型在转场过程中生成额外文字或界面元素。
- 运动描述要具体，例如 FPV、从首帧空间穿行到尾帧空间、慢到快再到慢、`ease-in-out`。
- 验收时不要只看最终视频是否存在；需要抽取首帧、尾帧和中间 contact sheet，确认开头贴合首帧、结尾贴合尾帧、中间运动自然且没有额外文字。
- 记录验收结果时只记录任务 ID、Provider 任务 ID、时长、分辨率、帧率和本地验收结论；不要记录临时签名下载地址。

### 12.8 并发、重试与超时

- 当前接口文档不承诺外部限流额度。接入方应自行做限流、排队和重试退避。
- 不要在网络超时后盲目重新提交新 `idempotency_key`，否则可能创建多个真实扣费任务。
- 网络超时后的首选处理是用原 `idempotency_key` 重试创建请求；如果返回 `deduplicated: true`，说明已有任务。
- Provider 创建失败时，SD2 会尝试释放冻结点数并保留失败任务；外部应记录返回的 `task_id`，交给管理员在后台追查。

### 12.9 上线前验收

上线前至少跑一条真实授权生成，并确认以下证据都存在：

1. `GET /api/codex/config` 使用正确 token 返回 200，坏 token 返回 401。
2. 如使用参考图，上传响应中 `isPubliclyReachable=true`，且创建任务使用同一个 `x-tab-id`。
3. 创建响应包含 `id`、`provider_task_id`、`source_type=codex_api`、`source_request_id`。
4. `/admin/outputs` 能看到该任务，来源显示为后台配置的 `source_label`。
5. `/admin/costs` 能看到对应任务的成本状态、Provider 请求记录和官方扣费记录。
6. `CreditLedger` 至少有 `task_freeze`；成功后有 `task_success_deduct`，失败后有 `task_failed_refund`。
7. `CostLedger` 至少有 `estimate`、`provider_request_submitted`，成功并获取官方扣费后有 `official_charge`。
8. 成功视频能完整下载，文件大小稳定，并通过 `ffprobe` 检查。
9. 外部系统保存了 `idempotency_key`、`x-codex-request-id`、SD2 `id` 和 `provider_task_id`。
10. 首尾帧转场类任务额外检查 contact sheet、首帧抽取和尾帧抽取，确认首尾贴合。

非付费自测只能证明接口和参数保护基本可用，不等于真实生成、扣费、结果下载和成本账本已经闭环。

## 13. 接入前检查清单

接入方：

- 已获得 `BASE_URL`。
- 已获得 API token。
- 已完成 `GET /api/codex/config` 检查。
- 每次真实生成都传 `x-paid-generation-intent` 和 `x-paid-generation-reason`。
- 每次请求都传稳定的 `idempotency_key`。
- 每次请求都传 `x-codex-request-id` 或 `source_request_id`。
- 使用上传参考图时，上传和创建任务传同一个 `x-tab-id`。
- 参考图使用上传接口或公网 HTTPS URL。
- 首尾帧本地文件已先上传，并把公开 `asset.originalUrl` 用作 `first_frame_url` / `last_frame_url`。
- 首尾帧模式已覆盖无普通 `reference_image_ids` / `reference_image_urls` 的调用路径。
- 通过后端服务调用接口，不把 API token 暴露给浏览器前端。

SD2 管理员：

- `/admin/integrations` 中接口已启用。
- token 已配置，且绑定用户为 active。
- 绑定用户有足够点数。
- `/admin/outputs` 能看到 `Codex API` 来源任务。
- `/admin/costs` 能看到点数结算和供应商成本记录。
- 状态刷新、完整下载、`ffprobe`、contact sheet 和首尾帧抽取验收链路已跑通。

## 14. 管理员自测

非真实生成的连接检查：

```bash
BASE_URL="https://your-sd2-domain.example" \
TEST_CODEX_API_TOKEN="$SD2_API_TOKEN" \
bash scripts/self-test-video-api.sh
```

坏 token 检查：

```bash
curl -s -o /tmp/sd2-bad-token.json -w "%{http_code}\n" \
  "$BASE_URL/api/codex/config" \
  -H "Authorization: Bearer bad-token"
```

期望返回 `401`。

真实生成测试会消耗点数和供应商额度，只能在用户明确授权后执行。

管理员只读检查后台配置，不要打印 token 明文：

```bash
sqlite3 prisma/dev.db \
  "select json_extract(value_json,'$.enabled'), json_extract(value_json,'$.token_hash') is not null, json_extract(value_json,'$.source_label') from PlatformSetting where key='codex_video_api_v1';"
```

检查某个真实任务的来源、点数和成本账：

```bash
sqlite3 prisma/dev.db \
  "select id,source_type,source_label,source_request_id,local_status,provider_status,estimated_cost,actual_cost,frozen_cost,refund_amount,provider_cost_status from VideoTask where id='<task-id>';"

sqlite3 prisma/dev.db \
  "select type,amount,reason from CreditLedger where related_task_id='<task-id>' order by created_at;"

sqlite3 prisma/dev.db \
  "select event_type,cost_source,confidence,amount_minor,amount_micros,currency from CostLedger where task_id='<task-id>' order by created_at;"
```

如果需要跑 skill 中的本地闭环检查脚本：

```bash
/Users/gouki-youdoo/.codex/skills/sd2-codex-video-api/scripts/check_sd2_codex_backend.sh \
  --project /Volumes/Data/Projects/video-api-debugger \
  --base-url "$BASE_URL" \
  --task-id "<optional-task-id>"
```

可选环境变量：

- `TEST_CODEX_API_TOKEN`：后台当前保存的 Codex API token。
- `TEST_AUTH_COOKIE`：管理员登录态 cookie，仅用于检查管理员配置 API。

不要 echo 这些值，也不要写入日志。
