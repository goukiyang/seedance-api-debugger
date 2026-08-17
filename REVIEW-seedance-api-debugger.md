# seedance-api-debugger — 专项审查报告

> 审查日期:2026-08-17 ｜ 审查对象:`E:\Ultimate-canvas\seedance-api-debugger`(后端 + 前端运行版)
> 审查方式:代码逐读 + 全量 API 路由鉴权扫描 + 双副本对照 + 依赖漏洞核对

---

## 一、项目概览

| 项 | 说明 |
|---|---|
| 定位 | 视频生成 API 调试/管理后台(sd2):项目、视频卡片、生成任务、积分计费、审核、成本台账、集成多个 provider |
| 规模 | `src/app/api` 127 个 route.ts ｜ 40+ Prisma 模型 ｜ ~60 个冒烟脚本 ｜ `node_modules` 609MB / `.next` 234MB |
| 技术栈 | Next.js **14.2.5** + Prisma + SQLite;前端为原生 JS 画布(`public/tools/ultimate-canvas/`) |
| 前端运行版 | `public/tools/ultimate-canvas/` — 已接线 bootstrap/document/generate/upload、/api/tasks、/api/assets、/api/video-cards |

**总体评价:业务工程质量很高**(权限矩阵、计费闭环、日志脱敏、契约白名单、测试体系),但**安全面存在硬伤**:多个 `/api` 路由完全没有自鉴权(见 P0/P1),且 `/api` 不在 middleware 覆盖范围内,等于裸奔。优先修安全,再谈增量功能。

---

## 二、安全问题(本报告重点)

### P0 — 必须立即修复

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| 1 | **未鉴权 + 无归属校验的不可逆删除接口** | `src/app/api/assets/[id]/provider-delete/route.ts` | `DELETE` 无任何会话检查、无所有权校验。任意匿名请求携带资产 ID 即可**永久删除官方 Seedance 资产**(代码注释自认"不可逆")。资产 ID 可通过下面 #2 枚举 |

### P1 — 重要,尽快修复

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| 2 | **未鉴权的全量资产列表** | `src/app/api/assets/list/route.ts` | 无会话校验、无 owner 过滤,直接返回**全库资产记录**(URL/名称/provider ID)。与 #1 组合 = 枚举 → 删除任意数据 |
| 3 | **缓存视频静态直链,零鉴权** | `src/lib/video/thumbnail.ts:7,49-52` + `public/videos/` | 本地缓存视频写入 `public/videos/<taskId>.mp4`,Next.js 静态托管**任何人可直接下载**(磁盘上已存在实际 mp4);`/api/video/play/[id]` **无鉴权**,`/api/video/download` 虽有鉴权但可绕过静态路径。建议缓存移出 `public/`(如 `/data/videos`)并由鉴权路由统一输出 |
| 4 | **会话密钥硬编码兜底** | `src/lib/auth/session.ts:24`、`registration/challenge.ts:12` | `SESSION_SECRET`/`REGISTRATION_SECRET` 缺省回落到 `'dev-secret-change-in-production'`,而本机**无 .env**(已核实)→ 兜底实际生效。未设置环境变量的部署中,知道兜底值即可伪造任意用户会话/注册挑战码。建议启动时强校验"必须显式配置且非兜底值" |
| 5 | **Next.js 14.2.5 存在 CVE-2025-29927** | `package.json` / `package-lock.json` | middleware 授权绕过漏洞(14.2.x < 14.2.25 均受影响)。本项目 middleware 只保护页面、不覆盖 `/api`,实际影响有限,但仍建议升级 14.2.25+ 并顺手把页面级保护从"仅查 cookie 存在"改为路由内鉴权 |
| 6 | **匿名上传,存储滥用** | `src/app/api/feedback/upload/route.ts` | 无会话、无频控,任意人可无限上传 5MB 图片刷爆本地/公网存储。建议至少登录 + 每用户配额 |

### P2 — 建议加固

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| 7 | 登录/注册无速率限制 | `auth/login`、`auth/register/*` | 暴力破解面;验证码注册挑战也应限频 |
| 8 | `/api/config` 未鉴权信息泄露 | `src/app/api/config/route.ts` | 公开返回 provider base_url/model/配置布尔(不含密钥,危害低,建议收敛) |
| 9 | `create-from-url` 无 SSRF 加固 | `src/lib/assets/normalizeAssetUrl.ts` | 仅校验 URL 可解析、协议强制 http→https,无 scheme 白名单/私网 IP(169.254.169.254 等)拦截;若回源由本服务发起即为 SSRF 入口,建议纵深防御 |
| 10 | cutout 代理透传内网服务 | `src/app/api/cutout/[[...path]]/route.ts` | 仅凭会话即可把请求转发至内网 `127.0.0.1:8098`,路径段直拼 `api/integration/<path>`;建议加内部服务鉴权头 + 路径白名单 |
| 11 | middleware 不覆盖 `/api` | `src/middleware.ts` | 页面保护也只查 cookie 存在性,纵深防御不足;建议全量路由统一走"无显式白名单即拒"模式 |

> 说明:以上基于代码层结论。若生产部署在网关层(如 youdoo-sites / Nginx)有额外 ACL,风险会降低,但不应依赖——接口层鉴权是底线。

---

## 三、工程质量亮点(值得保持)

- **鉴权基建**:`getAdminUser`(角色校验)、`getSession`(HMAC-SHA256 + `timingSafeEqual`,签名/过期校验完整)、`getProjectAccess`/`assertCanGenerateInVideoCard` 权限矩阵贯穿生成链路。
- **计费闭环**:`tasks/create` 一次性串起额度分配、项目预算、审批消耗、成本台账、provider 快照与结算,参数白名单(模式/比例/时长/分辨率)严格。
- **安全细节**:provider 响应日志脱敏(密钥/URL 字段 `[redacted]`)、上传白名单 + 50MB 限制 + SHA-256 hash 文件名(防路径穿越)、参考图权限校验、任务 ID 格式校验。
- **前端契约层**:`backend-contract.js` 对后端端点做**来源+路径白名单校验**,是前端侧防篡改/防内网穿透的优秀实践;自动保存用 900ms 防抖 + 修订号队列协调器防竞态。
- **测试**:~60 个冒烟脚本覆盖权限矩阵/上传去重/模板/画布等;`tasks/lessons.md`、`tasks/todo.md` 沉淀经验与未闭环项。

## 四、前端运行版复现结论

上轮审查的 4 个问题在运行版**全部复现**,另增 1 项:

| # | 问题 | 状态 |
|---|---|---|
| 1 | 右键拖拽弹菜单(`hasPannedDuringRightClick` 仍为死代码) | ✅ 复现 |
| 2 | 导演台滚轮与画布缩放双重触发(container + document 三层 wheel 并存) | ✅ 复现 |
| 3 | 每个导演节点独立 WebGLRenderer + 60fps 常驻 RAF,无可见性暂停 | ✅ 复现 |
| 4 | `director-3d.js` 依赖 esm.sh CDN + 本地 ESM,离线/内网不可用 | ✅ 复现 |
| 5 | **自动保存无 pagehide 刷新**:关页/刷新丢失最后 900ms 内编辑(仅 `pagehide` 用于清理视频预估) | 🆕 新增 |
| 6 | 无 undo/redo;框选多删不一致;`input→input` 连线未拦截 | ✅ 复现 |

XSS 卫生总体良好:175 处 `escapeHtml` 调用,仅 8 处模板注入且多为内部数据源(如工具箱 `item.name`),风险可控。

## 五、建议路线图

1. **立即(安全止血)**:① `provider-delete` 补鉴权+归属校验;② `assets/list` 按 owner 过滤;③ 缓存视频移出 `public/` 或给 `/videos/*` 加鉴权;④ `feedback/upload` 要求登录。
2. **尽快**:强制配置非兜底 `SESSION_SECRET`(启动校验)、升级 Next.js ≥14.2.25。
3. **中期**:登录/注册限流、`create-from-url` SSRF 加固、provider 密钥加密存储、SQLite→PostgreSQL(数据量与并发上来后)。
4. **工程**:消除前端双副本(以 `public/tools/ultimate-canvas/` 为唯一事实源)、WebGL 资源治理、undo/redo、自动保存加 `pagehide` 刷新。

---

*报告完 — 需要的话,我可以从 P0 的「provider-delete 补鉴权 + assets/list 归属过滤」开始直接动手修。*
