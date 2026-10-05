# SD2现有抠图全功能升级交接

project: SD2视频创作平台（video-api-debugger）
target_path: /Volumes/Data/Projects/video-api-debugger
version: 1.0.0（本工单；不升级应用）
version_source: AI Cutout Web frontend/package.json；SDK sdk/pyproject.toml
relock_before_execution: true
status: 事实性交接已完成；接入尚未实施
risk: 本轮L0文档；后续按项目agents判断
updated_at: 2026-10-06 Asia/Shanghai

**用户要求**：SD2原本已有抠图，只是功能原始、没更新。现在升级原入口，接上 AI Cutout Web 的完整能力。本工单只说明功能和运作事实，具体页面、适配、分工及实现由 SD2 项目 agents 解决，不另造平行工具。

## 现有什么功能

| 能力 | AI Cutout Web 已有内容 |
|---|---|
| 普通抠图 | 文件上传/粘贴、模型选择、透明PNG及mask；背景移除、边缘平滑、残留清理、孔洞修复、细节保护、阴影保留六项调整，以及高级透明度/边缘参数与预设 |
| 角色图拆切 | 完整角色框→每个角色单独抠图→按透明范围裁剪；支持自动/手工框与提示点，输出逐角色PNG/mask、总览、清单及ZIP；手工辅助与自动效果需区分 |
| 结果继续处理 | 裁剪、拆分预览、框选拆分、合并、导出；参数可提交任务；画笔细修、角色编辑撤销/重做属于网页前端能力，不能当成已有服务端接口 |
| 任务与记录 | 提交、排队/执行状态、分页历史、结果下载、幂等防重复；可取消排队任务，运行中的取消会冲突，不能承诺立即停止计算 |
| 接入方式 | 版本化 `/api/v1` 任务接口、旧 `/api/integration` 兼容接口、Python SDK 0.1.0；SDK有上传/提交/等待/取消/历史/下载，角色和拆分使用通用任务类型 |

SD2已有 `/cutout` 和 `/api/cutout`：能力查询、抠图、角色拆图及原有三项调整仍是升级基础。项目AGENTS记录的部署源是 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，其相关文件与本资料根不同；该源导航标管理员入口。本轮未核线上配置/角色可见性，不把旧源码观察当线上证明。

## 怎么运作

入口：**https://cutout.youdooart.com/**，当前已登记网站v0.3.0、运行源29824dd；正式源码 `/Users/gouki-youdoo/work/ai-cutout-web`。

**网站/调用方上传文件→服务器校验并保存原图、建立任务→队列把任务交给Mac→Mac下载原图并计算→结果回传服务器→查询状态、预览或下载。** 服务器保存任务、输入和结果，Mac负责计算；Mac不在线时不能把任务描述成已完成。结果与历史按所属身份隔离。

新版接口事实：`POST /api/v1/assets` 用 multipart `file` 上传文件本体；`POST /api/v1/jobs` 传 `asset_id/kind/parameters`，可带 `Idempotency-Key`；`GET /api/v1/jobs/{job_id}` 查询，`GET /api/v1/jobs/history` 分页历史，`DELETE /api/v1/jobs/{job_id}` 取消排队任务，`GET /api/v1/results/{job_id}/{filename}` 下载。kind 包括 `cutout/characters/crop/split_preview/split_export/split_merge/split_region`。没有直接接收 `fileURL` 的新版上传接口，嵌套参数以源码/SDK为准。

外部业务凭据、管理员凭据和Mac执行器凭据是不同身份；SD2实际使用哪种身份及用户归属尚未确定。凭据不能交给浏览器，不用管理员/Mac凭据代替业务身份，也不能靠放开跨站权限解决。后续需要新的凭据、权限或付费时按项目授权处理，本轮没有创建。

## 已验证与仍有缺口

- **已验证记录**：新域名HTTPS、真实页面及只读身份边界通过；公网SDK曾完成普通抠图、16角色、透明裁剪、拆分→合并→导出、排队取消与身份矩阵。普通任务真实使用MPS，16角色SAM真实使用CPU。以上是已有证据，本轮不重跑。
- **不能称“全功能质量通过”**：整体仍为部分验收。网页上传曾被调试工具权限拒绝；fileURL相关工具授权待答（也不代表API支持URL上传）；注销登录/整机重启、有图刷新恢复未验；拆分预览完成回执超时及异常队列消息未核清；角色质量C2及完整能力C3仍未关闭。原图、真实结果和手工辅助参数随工单保留。

## 原文与附件

正式附件目录：[docs/materials/2026-10-06-ai-cutout-upgrade](../../docs/materials/2026-10-06-ai-cutout-upgrade/)，[来源及校验清单](../../docs/materials/2026-10-06-ai-cutout-upgrade/附件来源与校验.json)。原件仍保留在 AI Cutout Web；媒体仅本地归档，不推公开仓。

- [16角色原图](../../docs/materials/2026-10-06-ai-cutout-upgrade/原图/355d707027284cdeb3d9c84b229a82d7.jpg)及机械/三视图两张原图：识别质量与复杂边缘参考；原角色用户文件名与失效缓存来源见清单。
- [v0.3.0真实16角色总览](../../docs/materials/2026-10-06-ai-cutout-upgrade/真实结果-v0.3.0/roles16-contact-supervisor.png)、同目录16份PNG/mask、manifest与roles.zip：真实产出参考，不当成全自动质量PASS；[历史辅助参数](../../docs/materials/2026-10-06-ai-cutout-upgrade/历史辅助参数/角色验收参数_v0.2.0.json)保留版本区别。
- [新版API源码](../../docs/materials/2026-10-06-ai-cutout-upgrade/接口参考/routes_v1.py)、[任务结构](../../docs/materials/2026-10-06-ai-cutout-upgrade/接口参考/server_api.py)、[参数](../../docs/materials/2026-10-06-ai-cutout-upgrade/接口参考/cutout_settings.py)、[SDK及示例](../../docs/materials/2026-10-06-ai-cutout-upgrade/接口参考/sdk/client.py)。[旧API文档](../../docs/materials/2026-10-06-ai-cutout-upgrade/接口参考/第三方API接入文档_v1.md)只解释兼容接口，旧鉴权/域名说明不能代替新版事实。
- 当前状态原文：`/Users/gouki-youdoo/work/ai-cutout-web/docs/todo/2026-10-03-mac-api-migration.md` 文末A1及M1–M7；背景原文已复制到附件接口参考目录。

## 本轮收口

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| S1 | 编写 SD2 全功能接入工单 | 依据真实接口，列清接入项、缺口、验收及附件，并归档登记 | 已完成；只文档交接 |

验证限于正文、链接、关键附件可读及复制一致、聚焦Git差异；不实施应用、测试业务、重跑模型、部署、收费或跨聊天发送。SD2远端实核为公开仓，本轮仅本地聚焦提交；原脏改保留。具体接入由项目agents自主调查并决定，仍须区分已有能力、实际接通和真实效果。
