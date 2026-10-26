# 客户 IP 视频 API v1

工程候选，默认关闭。部署、商业许可、客户售价、额度、媒体保留条款及实际开放需另行确认。本文不承诺特定第三方软件兼容，也不代表收费、隔离或并发手验已通过。

## 接入

- 地址由管理员提供，必须使用 HTTPS。所有 `/api/v1` 请求使用 `Authorization: Bearer <Key>`，不需要 Cookie，不支持 URL Key 或远程素材 URL 导入，不开放通配 CORS。
- Key 明文只在发放时显示一次。不要写入源码、聊天、日志或共享脚本；示例从 `SD2_API_KEY` 环境变量读取。轮换先发新 Key，再吊销旧 Key；吊销不取消已受理任务或退款。
- 型号、时长、分辨率及素材上限以 `GET /api/v1/models` 为准。首版稳定型号名为 `seedance-2.5-ip`，不接受站内用户、项目、视频卡或供应商归属字段。
- 价格由客户合同明确设置，报价单位为点。成功按冻结合同扣点，明确失败按原账本退款；提交未知不承诺免费。客户多 Key 共用预算、并发、余额和存储额度。
- 当前上传硬上限：图片 30 MiB、视频 200 MiB、音频 15 MiB，同时受客户配置的更小上限约束。文件必须与申报 SHA-256、字节数及 MIME 一致，通过完整解码检查。大参考图可能超过生成线路像素上限，报价时会明确拒绝，不自动缩放或替换。
- 媒体保留时间以管理员与客户约定为准。本实现不自动删除文件；存储额度不足时拒绝新增。单任务成品预留上限由管理员配置，最多 200 MiB，超过上限不会提供不完整下载。

机器协议：[openapi.json](openapi.json)。完整可恢复示例：[client.py](client.py)，仅 Python 标准库；运行即可能产生真实费用，请在客户实际开通且确认费用后使用。此候选交付未运行真实调用。

```bash
export SD2_API_BASE='https://管理员提供的域名'
# 在终端安全设置 SD2_API_KEY，不把真实值写入示例。
python3 client.py --state ./request.json --file ./reference.png --mime image/png \
  --prompt '镜头缓慢推进' --duration 5 --resolution 720p --max-cost-points 50 --output ./result.mp4
```

`50` 仅演示调用者愿意支付的上限，不是售价。示例必须显式提供费用上限；管理员未设置价格不会接受生成。中断后使用相同参数和同一个状态文件继续；状态文件不保存 Key，但含本客户请求、素材和提示词，应自行妥善保存。

## 原号与恢复

上传先保存自己的 `request_id`，再调用开始接口。取得上传票据后，仅 `prepared` 可带原 `Upload-Nonce` 传输；`receiving` / `writing` 不因超时重新发送。`recover` 只核对原票据，只有系统能证明旧写入已停止且未写入时才重新开放同一票据；否则等待人工核对。`complete` 是查询原上传结果，不重复写文件。

生成提交前持久保存 `input`、`quote_id` 与 `Idempotency-Key`。同客户同号同内容返回原任务，不同内容返回 409。不同 Key 可查询同客户原任务，不能借轮换 Key 重新扣款。报价有效期 10 分钟；报价后改输入、改售价或改客户规则须重新报价，已受理订单不重算。

创建真实视频还须显式传入 `X-Paid-Generation-Intent: user_authorized_real_provider` 和 `X-Paid-Generation-Reason: customer_authorized_video_generation`。仅在客户已授权实际扣费时发送；未声明会返回 `PAID_GENERATION_AUTH_REQUIRED`。查询、上传和报价不收费，也无需此声明。

提交超时先 `GET /api/v1/video/requests/:requestId`，只查原号。404 仅表示当前未找到，不证明请求不会迟到，不允许据此换号重发。`submission_unconfirmed` 表示可能已受理，保留原号及冻结费用，不自动退款或重发。原提交未明确结束时，不更换报价或请求号。

任务 `status`、`delivery_status`、`fee_status` 是三个独立事实。上游生成成功不等于本站文件已保存；仅 `delivery_status=ready` 才有下载地址、字节数及 SHA-256。查询返回 `retry_after_seconds`，未完成通常 10 秒；429 响应同时带 `Retry-After: 60`，应遵守较长等待时间。

下载需有效同客户 Key 及 `content:read`，支持 HEAD 和单段 Range。没有公开永久成品 URL。下载可校验 `content_sha256`；接收完文件才算下载完成。首次 API 不承诺取消或 Webhook。

## curl 全流程

需 `curl` 和 `jq`。这些命令展示协议，不是自动重试脚本。替换域名、文件及费用上限，不填真实 Key 到文档。关闭 shell 跟踪，授权头通过标准输入给 curl，避免进入命令参数。

```bash
set +x
: "${SD2_API_BASE:?}" "${SD2_API_KEY:?}"
api() { printf 'header = "Authorization: Bearer %s"\n' "$SD2_API_KEY" | curl --silent --show-error --fail-with-body --config - "$@"; }
api "$SD2_API_BASE/api/v1/models"

# sha256、size_bytes 必须来自当前文件；不要照抄下面占位值。
jq -n --arg id 'upload-client-0001' --arg hash '<文件SHA256>' \
  '{request_id:$id,sha256:$hash,size_bytes:12345,mime_type:"image/png",file_name:"reference.png"}' > upload-input.json
api -H 'Content-Type: application/json' --data-binary @upload-input.json "$SD2_API_BASE/api/v1/assets/uploads" > upload.json
UPLOAD_ID=$(jq -r .id upload.json)
# 仅 upload.json.status=prepared 时执行。
api -X PUT -H "Upload-Nonce: $(jq -r .transfer_nonce upload.json)" -H 'Content-Type: image/png' \
  --data-binary @reference.png "$SD2_API_BASE/api/v1/assets/uploads/$UPLOAD_ID/transfer" > upload-result.json
api -X POST "$SD2_API_BASE/api/v1/assets/uploads/$UPLOAD_ID/complete" > upload-result.json
# 断线恢复：GET 查询，必要时 POST recover，不能盲目重传。
api "$SD2_API_BASE/api/v1/assets/uploads/$UPLOAD_ID"
api -X POST "$SD2_API_BASE/api/v1/assets/uploads/$UPLOAD_ID/recover" > upload-result.json

jq -n --arg asset "$(jq -r .asset.id upload-result.json)" \
  '{model:"seedance-2.5-ip",prompt:"镜头缓慢推进",duration:5,resolution:"720p",image_assets:[$asset]}' > input.json
jq -n --slurpfile input input.json '{input:$input[0],max_cost_points:50}' > quote-input.json
api -H 'Content-Type: application/json' --data-binary @quote-input.json "$SD2_API_BASE/api/v1/video/quotes" > quote.json
jq -n --slurpfile input input.json --arg quote "$(jq -r .id quote.json)" '{input:$input[0],quote_id:$quote}' > submit.json
# 先将原请求号和 submit.json 持久保存，再提交一次。
REQUEST_ID='video-client-0001'
api -H "Idempotency-Key: $REQUEST_ID" -H 'Content-Type: application/json' --data-binary @submit.json \
  -H 'X-Paid-Generation-Intent: user_authorized_real_provider' \
  -H 'X-Paid-Generation-Reason: customer_authorized_video_generation' \
  "$SD2_API_BASE/api/v1/video/tasks" > task.json
# 提交响应丢失也只查这个原请求号。
api "$SD2_API_BASE/api/v1/video/requests/$REQUEST_ID" > task.json
TASK_ID=$(jq -r .id task.json)
api "$SD2_API_BASE/api/v1/video/tasks/$TASK_ID" > task.json
# delivery_status=ready 后下载；HEAD / Range 均重新鉴权。
api -I "$SD2_API_BASE/api/v1/video/tasks/$TASK_ID/content"
api -o result.mp4 "$SD2_API_BASE/api/v1/video/tasks/$TASK_ID/content"
api "$SD2_API_BASE/api/v1/usage"
```

错误正文固定为 `{"error":{"code":"...","message":"..."}}`。400 参数无效，401 Key 无效/过期，403 范围或访问停用，402 余额不足，404 对象不可见，409 原号冲突/报价变化/交付未就绪，413 文件超限，429 频率/预算/并发/容量限制，503 服务或配置未就绪。不要把错误状态当成可以创建另一笔订单的证明。

## 管理与手验交付

管理员沿“API 设置 → 客户 API”创建独立外部客户身份和私有项目/视频卡，再沿现有账户点数入口入账。新增客户没有赠送余额、商业售价或额度。全局与单客户均需显式启用及许可确认；全局关闭或禁止新建不终止已有任务。访问封禁与禁止新建分开设置。预算时区开户固定，避免改时区重置当期预算。

停止新生成后，仍可补发仅查询、下载、查看用量的只读 Key，以找回同客户的已付款结果；`video:write` / `assets:write` 仍须通过完整开通条件。封禁读取时不能补发 Key。

W07 构建与静态检查不替代以下手验：A01 两客户交叉对象；A02 Key 过期/吊销/轮换；A03 无 Cookie 全流程；A04 原号冲突、超时和重启；A05 多 Key/多进程余额及限额竞争；A06 改价与跨周期；A07 坏媒体、失权、未就绪交付及存储配额；A08 管理权限、保存恢复与手机布局；A09 旧 Codex/站内任务兼容；A10 发布回退及数据保护。以上专项、浏览器、真实客户端及收费样本本批未自动执行。

W08 未开始。发布前必须增量应用新表，备份现有数据库和私有媒体目录，核查磁盘与 ffmpeg、HTTPS 签名地址、足够强的服务端 SESSION_SECRET，以及全部在途消费者。新任务持久保存独立的原上游配置/凭据引用；凭据存于服务端数据库，不对客户返回，数据库备份必须按秘密管理。私有媒体位于既有受保护上传存储下的 `api-clients` 子目录，须作为永久媒体一同备份，不纳入临时上传清理。

回退先关闭新受理，保留新表、原请求、账本、凭据引用和私有原件，并保留本版可完成 API 在途任务的查询/结算/媒体消费者。旧消费者不识别客户私有媒体及冻结上游配置，不能直接回旧程序继续处理新 API 任务。未取得具体生产确认、许可/售价/容量条件或隔离安全证据前不得对外开放。
