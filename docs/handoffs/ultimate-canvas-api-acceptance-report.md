# Ultimate Canvas 纯 API 验收回执(2026-08-17)

日期：2026-08-17

目标分支：`teammate/ultimate-canvas-complete`

基线：本地 HEAD `147cf84`(推送后远端 `4a4740d6`)

线上域名：`https://sd2.youdooart.com`(原 `sd2.youdoodesign.com` 已迁移)

## 1. 本次目标理解

按 `docs/handoffs/ultimate-canvas-codex-api-handoff.md` 的验收要求,用**普通账号**(非 admin)对线上 sd2 后端做纯 API 验收:校验登录态、bootstrap 能力、点数与项目,再按需执行写库与真实文本生成链路,验证「项目 → 视频卡 → 画布保存/回读 → 文本生成 → 上传」契约是否与交接文档一致。线上为飞书登录,验收登录态采用浏览器 session cookie 方式;不部署任何代码,不改任何业务接口。

## 2. 实际修改了哪些文件

- `scripts/acceptance/ultimate-canvas-api-acceptance.mjs`(新增,验收脚本)
- `.gitignore`(追加 `.acceptance-cookie`,避免登录会话落库)
- `docs/handoffs/ultimate-canvas-api-acceptance-report.md`(本回执)
- 另已完成并推送:`REVIEW-seedance-api-debugger.md`、`HANDOFF-VERIFICATION.md`(均随提交 `4a4740d6` 推送)

## 3. 每个文件改了什么

- `ultimate-canvas-api-acceptance.mjs`：Node 无依赖验收脚本。默认只读(登录态/`/api/auth/me`、bootstrap、`/api/me/credits`、项目列表),写入与生成步骤全部显式开关控制:`--create-project`、`--create-card`、`--save-doc`、`--upload`、`--text`、`--image`(1K 低风险)、`--video`(重度扣费,自动携带 `x-paid-generation-intent/reason` 付费保护头)。登录态支持 `--login <账号>`(密码读 `SD2_PASSWORD` 环境变量)、`SD2_SESSION_COOKIE`、`.acceptance-cookie` 文件三种方式;视频轮询到 `succeeded/failed/cancelled` 终态;结束输出通过/失败汇总并退出码区分。会话 cookie 仅走环境变量或 600 权限文件,不写进代码。
- `.gitignore`：新增 `.acceptance-cookie`,防止验收登录态被提交。

## 4. 跑了哪些验证命令

- `node --check scripts/acceptance/ultimate-canvas-api-acceptance.mjs`：PASS。
- 只读验收:`SD2_BASE_URL=https://sd2.youdooart.com SD2_SESSION_COOKIE=... node scripts/acceptance/ultimate-canvas-api-acceptance.mjs --list-projects`。
- 写库 + 文本:`... node scripts/acceptance/ultimate-canvas-api-acceptance.mjs --create-project --create-card --save-doc --upload --text`。
- 过程中用 `curl` 直连线上创建了一张「探测返回结构」视频卡,用于确认建卡接口返回结构(已计入清理清单)。

## 5. 验证结果是否通过

通过。

只读验收 `7/7`：

- 登录态:郑琦 / `role=user` / `status=active`(普通账号,非 admin)。
- bootstrap:能力上下文正常返回。
- `capabilities.text` = `gpt-5.4` enabled=true。
- `capabilities.image` = `gemini-3.1-flash-image-preview` enabled=true。
- `capabilities.video` = `dreamina-seedance-2-0-260128` enabled=true。
- 点数:余额 193、可用 193、冻结 0。
- 项目:1 个(默认项目)。

写库 + 文本 `13/13`：

- 新建项目:`type=team` 真实创建成功 → `cmswt9jsv00bdgn1yubwt2b01`。
- 新建视频卡:→ `cmswt9jtw00bmgn1ynjiqf86d`。
- 保存画布:→ `cmswt9juh00bqgn1yo767x7ld`。
- 回读画布:`document_json.context.video_card_id` 命中。
- 文本生成:真实调用 `gpt-5.4` 成功,返回改写文本「这段话其实就是一条专门拿来做 API 验收测试的文本…」。
- 图片上传:落库为 asset,ID `590e8ed0-3353-4612-ad9a-69ed80bab97b`。
- 生成后点数仍为 193(文本与上传不扣点)。

过程中发现并修正两个脚本侧问题(均非后端 bug)：

1. `POST /api/projects` 传 `type=personal` 不会新建项目,后端按设计返回默认项目并标记 `deduplicated:true`;只有 `type=team` 才真正创建。已修正脚本。
2. 建视频卡返回结构是 `{ video_card: {...} }`,首次解析字段名错误导致下游步骤缺上下文;已修正并补「缺视频卡即跳过依赖步骤」的防护。

另确认的后端行为:同项目同名视频卡触发重复卡保护(`409 SIMILAR_VIDEO_CARD_EXISTS`);同用户同 hash 上传复用同一 asset(与 `tasks/lessons.md` 的去重设计一致)。

## 6. 是否真实调用了文字/图片/视频生成

部分。**文本生成真实调用了一次 `gpt-5.4`**(用户授权的「写库+文本」验收范围)。图片与视频生成均未调用,避免未授权扣费。

## 7. 是否消耗了点数

文本生成与图片上传未扣点数,余额 193 → 193,消耗为 0。未触发图片/视频真实扣费链路。

## 8. 是否碰过后台设置、密钥、点数核心逻辑

没有。未读取或修改生产 `.env`、后台 API 设置、provider 密钥配置、点数冻结/扣减/退款核心逻辑或数据库 schema;未绕成 admin(全程 `role=user`);session cookie 仅经环境变量/本地 600 权限文件使用,未写入代码或仓库。

## 9. 还没做完的内容

- 图片生成(`--image`,1K 低风险)与视频生成(`--video`,重度扣费)尚未验收,需用户明确授权后执行。
- 线上测试数据待清理:默认项目下 3 张测试卡(含「探测返回结构」卡)建议废弃/归档;team 测试项目 `cmswt9jsv00bdgn1yubwt2b01` 有内容,只能归档。
- 本地环境已搭建(`localhost:3000` 可跑,`admin@local.dev` 密码登录;飞书 CLI 登录需本机安装 `lark-cli` 并授权)。
- git 已推送 `4a4740d6` 到 `origin/teammate/ultimate-canvas-complete`;本地分支引用在本机工具沙箱内会在命令间被清理,git 操作建议在用户终端执行(`git fetch origin && git checkout -f teammate/ultimate-canvas-complete` 即可恢复)。

## 10. 风险和建议下一步

- 线上能力(模型、启用状态、点数规则)由后端配置决定,验收脚本只读能力元数据;后端若更换模型或字段,应同步更新脚本断言与 `backend-contract.js` 白名单。
- session cookie 有有效期,脚本复用 `.acceptance-cookie` 前需确认未过期;过期后重新在浏览器飞书登录并更新。
- 建议下一步按授权依次验收图片(1K)与视频(真实扣费前先核对点数余额与付费保护头),并清理线上测试数据;同时把专项安全审查的 P0/P1(`assets/list`、`provider-delete` 鉴权)排期修复。

---

# 追加:本地环境搭建回执(2026-08-17)

- 已建本地 `.env`(仅 `DATABASE_URL`/`ADMIN_*`/`NEXT_PUBLIC_BASE_URL`,gitignore 已忽略)+ `npx prisma db push` 建 `prisma/dev.db` + `npm run seed:admin`(管理员 `admin@local.dev`,初始 1000 点)。
- `localhost:3000` dev 服务可跑(密码登录链路验证通过;`/tools/ultimate-canvas` 未登录正确 307 到登录页)。
- 已知环境问题:`package.json` 的 dev 脚本 `NEXT_DIST_DIR=.next-dev next dev` 是 Unix 语法,Windows 下 npm 直跑报错,需 `export NEXT_DIST_DIR=.next-dev && npx next dev`(package.json 属禁止改清单,未改动);飞书 CLI 登录需本机安装 `lark-cli`。

# 追加:git 推送回执(2026-08-17)

- 提交 `4a4740d6`(parent `147cf84`)已推送到 `origin/teammate/ultimate-canvas-complete`,`git ls-remote` 确认远端指向一致。
- 环境注意:本工具 Bash 沙箱会在命令之间清掉 `refs/heads/teammate/*` 的松散引用(命令内写入验证 3 秒存活、跨命令即被删),导致本地分支短暂显示「无提交/孤儿状态」;已通过重建 ref 文件恢复,并建议后续 git 操作在用户自己的终端执行。
- PortableGit 存在 `gitconfig.lock` 报错,本机 git 操作改用系统 Git(`C:\Program Files\Git\bin\git.exe`,凭据 manager)。
