# 0.41.1 P3补齐证据

结论：0.41.1已部署到https://sd2.youdooart.com，待用户手动验收。本记录接续已经真实发布的0.41.0，原成功证据保留在上层目录，不重复验收未影响功能。工程发布检查不能冒充功能验收。

## 固定对账

| 编号 | 原任务 | 完成标准 | 当前状态 |
| --- | --- | --- | --- |
| P1 | 人物生成工具 | 方案D、受控随机、人物/配置/不可变历史及真实出图接通 | 0.41.0实现并部署，复用原证据，待用户手动验收 |
| P2 | 现有系统嫁接 | 工具及各独立导航入口、情境单图安全回填、不重复生成 | 0.41.0实现并部署，完整restore snapshot与handoff ack/CAS已保留，待手动验收 |
| P3 | 导入窗口素材下方删除 | 本人资源私有隐藏、确认及撤销，不影响原引用/分享/文件 | 三类资源补齐实现并部署0.41.1，候选构建/发布检查完成，待手动验收 |
| P4 | 提交上线 | 候选内置检查、聚焦Git、回退与公网版本/静态资源一致 | 0.41.0成功证据保留，0.41.1发布完成；远端发布及回退标签可见 |
| P5 | 生成图片恢复设置交互 | 单击仅边框、整卡hover/keyboard显示图下按钮、按钮才完整恢复且不出图 | 0.41.0实现并部署，原行为代码未改，待手动验收 |

A1-A7完整首批覆盖、33个文件说明及未验事项见上层`report.md`。本补丁只修正A6/P3资源覆盖及A7/P4版本发布，不重写其他包。完整DNA逐字段编辑和自动收费图像语义验收仍留V1.1。

## P3归属与兼容

- Asset稳定identity为`asset:<Asset.id>`；严格核对`owner_id`，隐藏沿用0.41.0的`asset-library-removal:v1:<账号>:<id>`键和原JSON结构。
- video_task使用`video_task:<VideoTask.id>`。本人为`owner_user_id=账号`，仅在该字段为null时回退到`user_id=账号`；不能因创建者相同越过明确的新归属。
- 无Asset reference_image使用`reference_image:<ReferenceImage.id>`。本人必须是该图片自身的`owner_user_id`，不是图集可编辑者、项目成员、管理员或分享接收者。隐藏时还校验active、active图集和`asset_id=null`。
- 两种新资源使用独立的`resource-library-removal:v1:<账号>:<类型>:<id>`键。旧0.41.0 helper只读写Asset前缀，无法改写新键；无记录迁移、清空或同JSON混写。回退到0.41.0可暂不显示新类型隐藏效果，标记保留，重新升级后恢复读取。
- removal接口兼容仅传`assetId`的旧请求。客户端保留原账号撤销缓存键/Asset字段，并兼容新identity；缓存不授予服务端权限，每次隐藏和撤销重新核对本人归属。撤销只取消标记，不能复活失效资源或恢复其旧状态。
- 删除仍在素材下方常显Trash2和文案。确认明确“从我的素材库删除”，可撤销，底层文件、任务/图集引用和共享内容保留；不是彻底删除，也不是隐私擦除。
- 本人无Asset参考图进入“我的素材”仍要求原图集view/use权限；预览走原有受保护content路由，其他用途导入走原original/download权限，不伪造Asset或下载资格。
- picker在排序/分页前过滤稳定identity，library的findMany/count及生成素材SQL同口径过滤。项目、共享、公共列表和管理员指定账号/隐藏审计视图不受该私人标记改变。
- 没有调用旧DELETE/restore API，没有更改Asset/VideoTask/ReferenceImage状态、保留状态、引用、分享、文件或schema。开发未实际隐藏/删除任何生产资源。

## 七个补丁文件

相对工作区`/Volumes/Data/Projects/video-api-debugger/worktrees/avatar-generator-20261005`：

| 文件 | 具体改动 |
| --- | --- |
| package.json | 正式发布0.41.0后的PATCH到0.41.1；无依赖或锁文件变化 |
| src/lib/release.ts | 同源短摘要覆盖补齐删除撤销、保留人物入口与图片恢复交互；版本仍读package.json |
| src/lib/assets/library-removal.ts | 分类型稳定identity、本人校验、隔离新键与兼容旧Asset标记 |
| src/app/api/assets/library/removal/route.ts | 新identity请求及旧assetId请求兼容；确认隐藏/撤销，私有无缓存响应 |
| src/app/api/assets/picker/route.ts | 本人视频删除能力、无Asset参考图投影和权限复用、分页前隐藏 |
| src/app/api/assets/library/route.ts | 三类私有隐藏及计数同步、保持项目共享和审计视图 |
| src/components/ResourceLibraryPicker.tsx | 不再要求资源必须有assetId；按identity删除选中项和撤销；原Asset缓存兼容 |

## 发布保护

- 运行来源重核：3e55c6609920e6e81253f087f59307eca9327293 / 0.41.0 / HCmFzUDsnr43fQC62KZlg，双服务active。
- 产品候选commit：2b1c4cfea7d0eeb9e99e0cf0b712056742c59536；分支已推送。
- PATCH只升一次，候选失败重试不会再升版本。
- 已推送回退标签`rollback/2026-10-05-before-library-hide-0.41.1`，peeled commit为3e55c6609920e6e81253f087f59307eca9327293。
- 新归档SHA256：ddfacf389825eada7e18735af85291bcc71a0cc046caf8311381165d284f2458；954个受跟踪文件。密钥、DB、运行数据、public/uploads/videos、storage、node_modules、dist和.next*未上传。
- 实际release-window预约及重读确认，server deploy.lock隔离候选和切换；候选源码与dist不在live目录构建。上线前仍核对current源码漂移。
- 补丁仅修改上述6个web源码与package版本；服务器切换脚本比对候选与回退源的整个src/scripts/prisma并执行白名单保护，不改图片任务worker代码，不排空/重启图片worker。
- 沿用原更新提醒：标题<=8字、加粗放大、版本另列；0.41.1按SemVer严格高于0.41.0，稍后按项目/渠道/目标版本去重，保留手动重查与草稿保护。未运行旧客户端功能验收。

## 守门与未验

等价守门start/finish检查：已核目标工作区、真实运行来源、现有脏改保护、授权及资源归属；收尾核对发布版本、构建、远端源码/标签、私有标记兼容与回退点、服务和持久软链接。此次是私有可逆显示标记与受保护发布，不扩权限、不接入新账本；证据层为源码/编译/Git/runtime/static，不将它们当成真实功能验收。

P3原范围误判已纠正并记录`/Users/gouki-youdoo/.codex/classification-misjudgment-log.md`。未做浏览器、截图、业务API验收、自动回归、收费调用或审核线程。首次发布保护实际触发源码与构建回退，非人为功能演练。非阻塞img/Hook/CSS警告保留，没有禁用lint/type检查或无关巡改。

## 实际检查与运行结果

1. `git diff 3e55c66 HEAD --check`及提交前检查成功；范围恰为7文件。静态自复核输入编号、本人归属、旧缓存/键、计数/分页、引用及共享保护，不派审核线程。
2. 精确2b1c4cf归档与原3e55c66归档SHA校验成功；候选前源码776文件匹配，切换前778文件匹配。没有current来源漂移或覆盖其他有效发布。
3. 服务器独立release目录执行`NEXT_DIST_DIR=.next-prod-candidate npm run build` exit0。Next14.2.5内置lint/type通过，86页生成完成；复用已有node_modules/Prisma Client，无安装、迁移或.env复制读取。本PATCH只构建一次。
4. BUILD为`TVyNICHldwYntu2SSA7Po`。首次切换后的静态检查错误地要求既有服务端跳转页`/image-studio`直接含picker UI；安全脚本自动恢复0.41.0源和`HCmFzUDsnr43fQC62KZlg`构建，已实核恢复。定位真实共享`/template-studio`清单后修正检查，复用原候选再次切换成功，未重编译、改产品代码或重复升号。
5. 公网`/api/release`、`/api/health`、`/api/config`、`/login`均200，来源为`server-42-193`。服务器和本机独立路径确认0.41.1；共享picker包`static/chunks/3482-c33222a36047e2d4.js`公网200，与候选SHA256一致：`fcaf9a5e0fc0d3b7f8f6d0a31f0205210feea2d50aa86402481cb7ae21538734`。
6. `.deployed-commit`为`2b1c4cfea7d0eeb9e99e0cf0b712056742c59536`，live BUILD与候选一致。web PID4071644、图片worker PID4043738，均active/running、ExecMainStatus0、NRestarts0；图片worker整个PATCH过程未中断。
7. storage/uploads/videos仍是原/data软链接，drain未设置且仍为空。发布源码和构建回退到0.41.0：`/srv/video-api-debugger/releases/3e55c6609920e6e81253f087f59307eca9327293-avatar-rollback`及`/srv/video-api-debugger/app/.next-prod-prev-avatar-2b1c4cf`，BUILD `HCmFzUDsnr43fQC62KZlg`。原0.40回退也保留，没有清理任何运行或备份目录。
8. 分支及新发布标签`release/0.41.1-library-hide-20261005`均远端可见，peeled为2b1c4cf；新回退标签peeled为3e55c66。不forcepush。最终status无产品脏改，仅本lead候选缓存和交接证据未跟踪。
9. 发布预约和完成记录已写入`/Volumes/Data/Projects/project-version-registry.md`。正式根todo/索引由supervisor归档维护，本lead未修改或暂存。

## 交接入口

此目录内`delivery.json`含33个完整绝对changedfiles、7个补丁changedfiles、Git/运行信息及关键证据摘要；`source.diff`为0.41.0至0.41.1，`full-source.diff`为116ee2a至最终产物。构建日志、两条公网证明、runtime证明、实际候选/切换脚本同目录可访问。上层保留0.41.0成功证据及原33文件用途/A1-A7覆盖。

功能未验与产品风险：实际删除/撤销、刷新/换账号、完整恢复、回填幂等、报价/付费生成、多人差异和同脸效果均留用户主动手动验收。私有隐藏不擦除文件或分享；撤销不复活已失效资源。未通过生产数据变更取证，旧版本回退兼容仅用源码与键隔离核对。
