# COMFY03 网站隔离实现

2026-10-28。开发基线 `b9cb9a73899cada0915675026896ac21210029a3`，分支 `comfy03/isolated-api`。此基线仍是候选，未证明等于真实部署 commit。没有部署或迁移生产，生产接单与价格关闭。

## 已实现

- 复用 ImageStudioTask、User、Asset、项目权限、容量规则及 UsageAttribution；不另建业务任务队列或点数账本。
- 独立调用方/机器 Bearer Key，SHA-256 摘要、恒定时间校验、有效内部用户校验、到期/吊销、模型与项目范围。
- 原请求幂等与只读找回、离线拒绝新单、排队取消、单机器单活动尝试、会话隔离、租约、开始许可、单调事件/心跳和持久回执。
- 上传先验权、限制 30 MiB、SHA-256 校验、完整 PNG 解码、最多 4M 像素、去元数据、不可覆盖文件；完成事务同时发布 Asset/任务终态/回执。下载再次核对调用方、任务、项目和素材权限。
- 旧云端领取、超时处理、完成、取消及异步恢复入口隔离本地后端；`local_*` 状态同时防止旧版云端 Worker 误领。未知/过期尝试保持占用，不自动重新生图。
- 生产开关没有可通过配置打开的入口。本阶段只能连接本工作目录固定的 `storage/comfy03-isolated/site.db`。

## 调用接口

全部位于网站后端，调用网站只在自己的后端保存 Key。基础地址必须是已验证 HTTPS 地址；目前没有对外可用的地址或已交付生图 Key。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/local-images/models` | 模型参数、资格与在线可用性；价格为 null |
| POST | `/api/local-images/tasks` | `{requestId, executionProfileId, params, projectId?}`；202 新建、200 原回执 |
| GET | `/api/local-images/requests/{requestId}` | 未知提交只读找回原任务；404 不能证明原提交未受理 |
| GET | `/api/local-images/tasks/{taskId}` | 状态、错误码、授权下载路径 |
| POST | `/api/local-images/tasks/{taskId}/cancel` | 只取消尚未领取的排队任务 |
| GET | `/api/local-images/tasks/{taskId}/outputs/image-1` | 私有 PNG 下载，带交付 SHA-256 |

机器使用原 `/api/local-workers/hello`、`heartbeat`、`claim`、`tasks/{id}/{start,heartbeat,events,reconcile,complete}` 与 PUT `outputs/image-1`。所有机器写操作需相同的 `Idempotency-Key` 和 JSON `operationId`（PUT 绑定在头中）。调用 Key 不能使用机器路由，反之亦然。

自有网站后端适配示例：[client-example.mjs](client-example.mjs)。先持久保存 requestId，再提交；请求超时保留原号，先读 requests 接口。不要因为查询为空就换新号或启动另一次生成。

## 本地启动与检查

在此工作树中使用 Node 和 Python；依赖来自现有 lock，未升级包或修改依赖锁。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/prisma/build/index.js generate
python scripts/comfy03-setup.py
./scripts/Check-Comfy03-Isolated.ps1
./scripts/Start-Comfy03-Isolated.ps1
```

setup **只创建不存在的新隔离数据库**，已有库时拒绝替换。当前工作树已创建，无需重复 setup。启动脚本仅监听 `127.0.0.1:3313`；这是开发入口，不是给其它网站使用的外网地址。真实 Worker 坚持 HTTPS；协议测试会临时创建回环 TLS 服务，使用专用证书校验，不关闭 TLS 校验、不加入系统证书库。

当前两模型的服务器允许列表为空。`qualified-profiles.json` 位于隔离目录，只能在真实模型验证证据齐备后登记；不得把协议夹具或旧样张当成真实资格。两个模型的完整固定配置来自 COMFY03-service 注册包，新增模型按版本登记，不接受调用者自带工作流。

## 凭据管理

本地管理员在同一隔离环境变量下运行：

```powershell
$env:COMFY03_ENVIRONMENT='isolated-test'
$env:DATABASE_URL='file:' + (Join-Path (Get-Location) 'storage/comfy03-isolated/site.db').Replace('\','/')
node --require ./scripts/server-runtime.cjs --import tsx scripts/comfy03-credentials.ts issue caller INTERNAL_USER_ID qwen-int8-cu130-v1
node --require ./scripts/server-runtime.cjs --import tsx scripts/comfy03-credentials.ts issue worker MACHINE_ID qwen-int8-cu130-v1
node --require ./scripts/server-runtime.cjs --import tsx scripts/comfy03-credentials.ts revoke CREDENTIAL_ID
```

用户必须已存在于隔离库且为有效内部普通用户；可追加项目 ID 将调用 Key 固定到该项目。初期每把 Key 绑定一个明确模型，7 天过期。原文写到受限 `credentials` 目录，不打印、不进入 Git；Windows 显式移除目录继承权限并授予当前 SID。轮换为先签发新凭据，再吊销旧 ID。测试程序的临时 Key 已吊销或短期过期，没有发放为真实服务 Key。

## 验证与限制

- `Check-Comfy03-Isolated.ps1`：31 项实际 SQLite/处理器检查通过；另有真实 Python Worker + HTTPS + SQLite 全链路通过，提交次数 1，图片 95 字节，**是 8×8 协议夹具，未调用模型**。证据为 engineering-check.json / worker-protocol-check.json。
- `node node_modules/typescript/bin/tsc --noEmit --pretty false`：通过。
- 实际 Next 开发服务启动，两个新增路由对无 Key 请求返回 401；不是仅用函数测试代替路由编译。
- `npm run build`：原有 prebuild 因真实宿主 `win32` 不满足现有定价检查的 `linux` 要求而停止，没有绕过。正式候选构建须在真实 Linux 隔离环境运行。本机 WSL 未安装。
- Worker 既有 53 项测试：52 通过、1 项因当前 Windows 账号无符号链接权限跳过。
- 迁移为新增表/列，未执行生产迁移。生产恢复的授权根、管理员核对 UI、孤儿文件回收、真实模型资格和 30 项联合验收未完成；没有上线、收费或外网接单承诺。
- 此版结果通过独立授权 API 下载。现有网站图片 UI 的 `local_*` 状态呈现、素材选择器内预览及后台管理尚未接入，不能把保存 Asset 行等同于全部 UI 兼容。
- 2026-10-28 本轮 GPU 观察空闲显存约 8166 MiB，低于既有 12000 MiB 门槛；未中断现有 8188/8191 服务或降低门槛进行推理。

## 代码入口与回退

`src/lib/local-images/`：鉴权、参数、持久任务状态机、文件处理、HTTP 适配。
`src/app/api/local-images/` 与 `local-workers/`：Next 路由。
`prisma/schema.prisma` 和 `prisma/migrations/202610280001_comfy03_isolated/migration.sql`：执行元数据和增量迁移。
`scripts/comfy03-*`、两个 PowerShell 脚本：隔离准备、测试、凭据与启动。

原克隆 `COMFY03-website` 保持原 main；所有网站修改在本隔离工作树。回退只停止隔离进程、回到本分支父提交；保留隔离库、图片和回执，不做回滚数据/重发任务。上线前必须先核实真实部署指纹、在 Linux 跑完正式构建与适用检查，再依据用户决定另行启用生产。
