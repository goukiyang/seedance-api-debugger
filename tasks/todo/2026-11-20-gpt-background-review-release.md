# GPT 验收后台 0.150.0 保护发布

任务 sd2-gpt-background-review-20261120；原发布窗口 gpt-review-20261120-efe282e。Windows 负责 0.18.0、浏览器资料及真实账号验收，公司 Mac 仅接力后台。

## 输入及范围

- 隔离源码：`/Volumes/Data/Projects/video-api-debugger-worktrees/gpt-background-review-20261120`。原提交 `efe282e5c574913887e7e06348848511add4f37d`；实际回调修复提交 `ccc0474af5e2e41c561b3e8b4e2cc0691fa35791`，分支 `codex/gpt-review-real-callback-20261120` 已推送并远端核同。版本保持0.150.0。
- 原 Mac 临时准备目录当前缺失。沿服务器原 attempt01 接续，新尝试为 `/data/video-api-debugger/release-staging/gpt-background-review-20261120/attempt02`；2603个源码 Git blob 已核同，新输入包 SHA256 `b7fe65d9547a080dfbe8ff32be5946df1b5e13e9a350bf82646f1d9a019fcf07`。
- 发布前源 `c857f7122a12c945bbf9e53d127570db50894ff5` / 0.149.0 / BUILD `8xILj89cDwDY-1HfKVpRs` 健康。原相容 guard `eacd05ecb8080166a71daccfa43fb63d8d23da60` / `0.148.23+points-pricing-guard.1` / BUILD `sQ39rb_c1TBf2KqmFxvUz` 保留。

## 修复及证据

- 精确登记真实回调 `https://chatgpt.com/connector/oauth/lrPNES-xwBHJ`，保留旧回调 `https://chatgpt.com/connector_platform_oauth_redirect`。授权确认跳转与 CSP 复用验证地址；授权码保存申请地址，换码精确匹配，保留 PKCE、账号绑定及一次性使用。没有通配符。
- 实际路由和临时 SQLite 验证通过：两个合法地址的授权确认/换码；错误地址、尾斜线、额外查询参数、通配符、重复参数及双向跨回调拒绝；错误请求不消耗合法码，成功后重放拒绝。模型为模拟实现，没有生产用户内容或付费调用。
- attempt01 的 `bridge-storage.log` 实际7类、旧断言6类，工程失败 exit1；Next 构建与切换尚未开始。只修正既有断言，原日志、输入及退出码不覆盖；新 attempt02 的 `previous-attempt-preserved.json` 登记旧失败及摘要。
- attempt02 源兼容预检通过：数据库结构与持久合同不变，未执行 SQL；变更 lint、外部隔离工程、directory/storage/review及完整 tsc 通过。

## 当前状态与保护

已部署，待Windows真实账号及原对话手动验收。实际线上0.150.0，源 `ccc0474af5e2e41c561b3e8b4e2cc0691fa35791`，BUILD `TAQR8fhGfagEQj0l6mvrk`。attempt02完整构建及构建绑定准入通过，1.1.2 seamless发布run `88b98ab7-92a5-4ced-bb5a-b1b02e94e149` 八步complete/exit0；原窗口已记部署完成。

七服务同源同BUILD，双域release与health通过；3条旧未知请求全字段摘要与价格配置核同，没有数据库恢复。两个OAuth发现地址和POST initialize/tools/list均200，清单为 `link_review`、`submit_revision`，scope `reviews.submit`。匿名合法回调均302进登录；错误地址/通配符/额外查询均400。未进行Windows真实账号换码或原对话功能验收。

技术回执：[部署结果](../../docs/materials/2026-11-20-gpt-background-review/public-deployed.json)、[OAuth与工具清单](../../docs/materials/2026-11-20-gpt-background-review/gpt-review-public-check.json)、[完整构建](../../docs/materials/2026-11-20-gpt-background-review/main-build-success.json)、[原失败历史摘要](../../docs/materials/2026-11-20-gpt-background-review/previous-attempt-preserved.json)。恢复入口沿原plan `/data/video-api-debugger/release-staging/88b98ab7-92a5-4ced-bb5a-b1b02e94e149/seamless-plan.json` 与原相容guard，仅回程序不回业务数据。

工程证据边界：隔离worktree的CodeGraph更新命令本轮index返回exit1，未当作结构查询通过；本次局部关系以实际源文件、调用入口和真实工程验证复核。构建内置既有warnings保留，未扩改无关页面。

沿原 build-controller.sh、封存1.1.2 seamless引擎、publish.sh、verify-published.py。旧请求自然排空，保账号草稿、队列、已受理/未知原号、费用配置、账本和媒体；恢复只回程序，不回业务数据库。真实ChatGPT功能待Windows用户手验。

本轮新发现的线索与问题：未新增任务外问题。

Windows原会话最终回执已单次提交；原始受理结果见 [回执记录](../../docs/materials/2026-11-20-gpt-background-review/windows-final-receipt.json)。投递受理不代表Windows功能验收完成。


## 0.150.1：原生授权表单来源修复（dispatch sd2-review-origin-form-05）

Windows真实页面点击“允许交回新稿”仍403。已确认授权HTML的no-referrer策略使原生form POST生成Origin:null，而服务端精确要求ISSUER；先前工程用手工Origin遗漏此行为。用户明确要求仅修此链路并发布0.150.1；旧0.150.0工程/发布成功记录仍保留，未代表真实账号功能通过。

方案：仅授权HTML响应改strict-origin，Referer只含来源域名；令牌与重定向响应继续no-referrer；原精确Origin、nonce/账号绑定、回调白名单、PKCE与单次码不变。使用现有Playwright和实际Google Chrome隔离上下文运行原生form，未经手工设置Origin的浏览器请求原样调用真实路由及临时SQLite；保留no-referrer负对照，并核对双回调、来源/nonce/账号拒绝。全拦截页面网络，不接触生产账号或业务数据。

新attempt03以已部署ccc0474af/0.150.0/TAQR8fhGfagEQj0l6mvrk为基线，沿原完整构建、相容guard与seamless流程；不改旧成功记录，不回生产数据。当前修复与原生验证准备中，尚未发布0.150.1。参考 https://fetch.spec.whatwg.org/#append-a-request-origin-header 。

### 同批真实判定故障（dispatch06–08）

指定测试记录保持唯一，首轮error、修改次数0；本轮只读诊断和内存判定，未手改生产任务。服务账号下模型开放与私密发出预检通过，gpt-5.5真实请求718ms返回HTTP503/musk_api_model_unavailable。原catch吞为通用note。初次root诊断触发文件所有者保护，属诊断身份不匹配，未当生产根因。

验收内部仅在该明确错误后复用resolveMuskChatModels及模型开放门，最多选择一个已批准且开放候选，候选失败不继续换模型。保留共享helper原重试上限：默认无通道一次，候选最多两次HTTP。不修改全局默认、用户参数、通道、凭据、费用或私密许可。实际返回/请求model写入结果；模型和私密/启用错误使用安全原因，诊断日志不记录上游body或用户内容。

补丁实际调用通过：唯一原测试的正文在内存判为revise，明确缺乙项，实际采用gpt-5.6-luna；3次fetch（默认503一次、目录GET一次、候选判定一次），21.446秒，生产任务写入0。SQLite工程补默认失败后单候选成功/实际model、禁用和空目录拒绝、候选失败不循环、非无通道错误不接续及错误投影通过。

原生Chrome157验证通过：旧策略Origin:null/403；strict-origin产生精确站点Origin和仅域名Referer，双回调实际处理器303且PKCE换码单用，nonce与账号错配403。正向Origin未手填。实际303和回调在内存核对，浏览器收到隔离完成页，不导航外部ChatGPT；不代Windows真实账号验收。

0.150.1修复提交c1cc25f41d7b06cbaaba3be57fcbeb6b74fc639a已推送并核同。attempt03冻结2604个Git文件、8个runtime变更，包SHA256为2c163f48278ebbc5431a3e9d81efb6a01d6b2556601b73e26c73c1f6156660d4，沿原完整构建、健康及无感回退流程，旧01失败和02成功保留。原R1–R3真实账号、退回与回稿循环仍由Windows继续，发布后仅重试唯一原测试记录。

### 目录许可与暂停派发收口（dispatch09–10）

原c1候选未上线。03在源码组装预检失败：覆盖包漏带与基线不同的docs/materials/index.md、tasks/todo.md；Next和切换均未开始。旧目录、输入、退出1与日志保留，新尝试精确登记两项nonRuntime差量，不放宽Git blob校验。

审查确认resolveMuskChatModels未传目录会裸fetch带凭据访问models，先前一次真实验证有该GET；未发现泄露证据，不把准入筛选发生在请求后当作安全。现改为显式传本地数组：有白名单只用原配置；空白名单仅从已有有效私密策略的musk目的地取模型名，再由原resolver精确私密许可和费率开放门过滤，无新增许可或目录请求。

默认请求在途允许用户暂停；候选选定后立即按owner/scope/id重读，须仍judging且等于本次claim.version才发。已暂停/换版返回当前状态，不发候选；不声称撤回已发默认请求。真实SQLite回归包含默认挂起→pause完成→503后候选0/仍paused，以及pause/resume后被新轮领取、phase仍judging但version不同→旧轮候选0，均通过。

最终实现真实小规模验证通过：仅两个chat/completions POST，gpt-5.5=503、gpt-5.6-luna=200，二者redirect:error；目录请求0。原材料内存judging副本判revise且缺乙，14.761秒；原生产任务逐字核同、写入0。调用实际runJudge和现有私密/启用门，不改全局默认、用户参数、通道、凭据或费用许可。原生Chrome相关源未变，复用已通过证据；R1–R3仍待Windows唯一原记录继续真实验收。


## 0.150.1 最终冻结、构建与保护发布（dispatch11–12）

已部署，待Windows手动验收。2026-11-20 18:32发布后检查完成：实际源码 `206e67410c9c235c0e1bcf5bdc21a5e11a218d3e`、版本0.150.1、BUILD `gcWweOyH29ArS-wghkXnE`；分支已推送并核同。只完成本批授权表单与验收内部模型接续修复，原R1–R3及唯一生产测试任务继续由Windows手验。

### 输入失败与集中预检

- attempt03在组装时发现两文档差量未入覆盖包；attempt04在输入门发现engineeringRoot仍指向attempt03。二者均exit1、未启动Next编译、未切换；目录、输入、日志及退出码原样保留。没有改应用实现或既有校验门迁就输入。
- attempt05集中修正本次输入：staging、工程临时根及其输出/日志/manifest关联统一派生为attempt05，原基线与guard历史路径保留。先用现有`release_contract.py`的`verify_config(..., require_engineering=True)`无构建预检，再核2604个已选跟踪文件、10个准确Git差量（8运行文件＋docs/materials/index.md、tasks/todo.md）及覆盖包blob；完整包SHA256 `96c64d79bcbb259819725b9ad7c3677d85f065c4715360601a29cd9b89abb1f4`，服务器收包核同。未再次修改发布工具逻辑。
- attempt05源相容预检、变更lint、定向工程、全量tsc、完整Next构建及最终相容准入全部通过，build-exit0。相关原生表单和真实判定证据字节绑定准确源，未重复发模型请求或重做已有原生浏览器验证。

### 实际发布与公网验证

发布窗口 `gpt-review-origin-20261120-206e674`；沿原1.1.2 seamless、automatic-same-plan，run `9120b04f-e87b-43fb-82a5-15878326a34f` 八步complete、publish-exit0。七个正式服务active且工作目录同源、同BUILD，双域版本0.150.1与health ok，实际静态资源字节核同。价格配置与三条旧未知请求全字段摘要不变；没有恢复数据库，没有扩大私密许可、模型开放、费用、通道或凭据。相容guard及旧页面资源保留；探针超时0，不冒称连续零中断已测量。

两个OAuth发现接口HTTP200；POST `/api/bridge/review-mcp` initialize与tools/list均200，工具仅 `link_review`、`submit_revision`，均需OAuth2 `reviews.submit`。旧/新两个精确回调匿名302登录，错误地址、通配符与额外query400。原生Chrome证明只覆盖隔离页面真实form→真实处理器/内存换码，未外跳ChatGPT；真实Connect、原任务重试、双账号隔离及完整退回改稿循环仍待Windows。

恢复入口沿 `/data/video-api-debugger/release-staging/9120b04f-e87b-43fb-82a5-15878326a34f/seamless-plan.json` 和原相容guard，仅回程序不回数据。旧0.150.0成功、attempt01失败及03/04失败历史均保留。

证据：[实际部署](../../docs/materials/2026-11-20-gpt-review-origin-patch/public-deployed.json)、[公网OAuth和工具清单](../../docs/materials/2026-11-20-gpt-review-origin-patch/gpt-review-public-check.json)、[完整构建](../../docs/materials/2026-11-20-gpt-review-origin-patch/main-build-success.json)、[集中输入预检](../../docs/materials/2026-11-20-gpt-review-origin-patch/manual-input-preflight.json)、[原生表单](../../docs/materials/2026-11-20-gpt-review-origin-patch/native-form-proof.json)、[最终真实判定](../../docs/materials/2026-11-20-gpt-review-origin-patch/judge-real-proof.json)。完整原始相容合同留服务器，仓库仅存脱敏摘要及原文件hash，不发布策略内容。

2026-11-20 18:34已通过原CX路由单次回执到Windows原会话；实际desktop-native steer、confirmed/received，未等待ACK，不把投递受理当Windows功能完成。见[回执受理结果](../../docs/materials/2026-11-20-gpt-review-origin-patch/windows-final-receipt.json)。

本轮新发现的线索与问题：未新增任务外问题。


## I1 美术自动流 0.151.0候选（Windows续接，2026-11-20）

用户已确认：原图和目标一次启动，原GPT先看图分析，再自动真实改图和独立图审。首张真图不算修改，每组最多3次修改，最多两次复盘后重试，共9次修改；任意一组通过即结束，仍不成仅提报未决方向，不把失败稿当成品交付。制作和判定分开；方案文字、示意图、原图副本不能当改好成品。保持原目标、保留项、原账号/工作区/设备/对话归属与旧文字三次验收；不新增计费图片通道、私密许可、模型默认、费率或权限。已授权保护部署、自动安装与真实实测，待独立通过后才给用户看。

当前候选从线上0.150.1/206e67410c9c235c0e1bcf5bdc21a5e11a218d3e继承，分支codex/art-autoflow-20261120，SemVer新增兼容能力0.151.0。同create接口kind=art，analysis/image/recap/done持久状态；初始round0仅原提问基线，不伪造图审。实际Sharp解码及像素重复检查；主成品单张，多参考与旧文字多图保留。actualImage:true才计实际改图或选最好版，示意图另有累计3次停止预算。确定超限/格式错误与未知传输分开，重复回执幂等；分析/复盘要求具体问题、原因、方向、核验四项实值。summary/status轻投影不读全图，详情才提供参考/审稿预览与记录，2MiB限制及原始文件留原对话不冒称高清副本。

显式暂停/重试保存wakeVersion，旧动作版本重复仅复用同wakeId；recover在原绑定device/CID/sourceId与当前wakeId下给新票据，不沿旧票据复活。未pair仅初始analysis零receipt的已签初始票据允许恢复，新单必须再经可信组件/原消息/nonce双证。判图在途新暂停/CAS更新优先，确定暂停给MCP结构化stop；原文字无delivery首稿失败重试不误写art。配对私有proof加入真实expires，组件只在该截止前低频重播；服务端所有Origin/nonce/账号和原URI精确核验不放宽。

Windows统一工程验证结果：scripts/gpt-art-review-engineering.mjs 17组真实临时SQLite+Sharp全部exit0，涵盖完整初图+9改/两复盘、首版通过、真文件工具路径、原图/示意/坏图/超限/格式/重复预算、账号/工作区/session、暂停晚到、recover幂等、首派发未pair与丢resume/retry响应。scripts/gpt-review-engineering.mjs旧文字/OAuth/PKCE/回调/许可模型回退及无票据retry全过；npx tsc --noEmit --incremental false最终exit0。最初Prisma客户端未生成导致的类型环境问题与Set旧编译目标错误均留原失败日志，未抬候选版本；模型与传输为隔离夹具，生产写入0、付费图片调用0。Windows完整原队列/账号/对话文字闭环亦通过。工程记录：D:/MYDR/cdoex/sd2/.cache/qa/gpt-art-autoflow-20261120/r3-*.log；这些是Windows本机路径，不冒Mac可读附件。

原图资料：codex-clipboard-d5cca489-9430-4eb2-bfb1-d25e4477fe14.png，用户本次马里奥式开放世界案例，1280×915、1617194字节，SHA256=066a0bad574ea7087f6699c69edd7cdd2d273874d5e6e1c94d48d98f29f35899；Windows固定归档D:/MYDR/cdoex/sd2/materials/2026-11-20-gpt-world-review/同名文件。已通过本人正式桥传交Mac mini，job=3ecb381a-f617-4493-b278-989c81e50663（状态与接收路径需Mac查询该原job，勿重发），供理解/后续查证，不公开上传图片，不加入公开源码包。真实出图/同会话工具交回/退回改图/复验及Windows效果仍在I1原单继续，不用本工程验证代替。原方案评审任务f57a98d6-ecd0-4dcc-8a27-b6ca26f8425f仅历史诊断方案；原文字任务743b2b34-199f-41b9-8f97-1eb6f6d5e23a及原R1–R3记录保留，不覆盖结论、不重发原未知任务。

发布沿原seamless1.1.2流程，冻结准确提交，核现网源/BUILD及共享发布占用后，完整Next/类型/lint/准入再切换，保留原数据库、价格/旧未知请求与相容guard，不回业务库。候选构建失败保留旧站，旧尝试不覆盖；上线后回执只说明工程部署，不代Windows真实美术验收。对应发起Windows原会话01a1f724-18ef-77f0-945e-a92f765cf2fc。


### I1 Mac发布接力：准确源已冻结，构建中

准确应用提交71ea8e565ddb1da559aeaec1d2e1b49e88f003a5已fetch并核同完整12文件，新增gpt-art-image.ts和艺术工程脚本均在；现网仍206e67410/0.150.1/BUILD gcWweOyH29ArS-wghkXnE。复用隔离worktree，正式根其它任务脏改保持。

attempt06为本次首个服务器构建尝试。集中离线预检与服务器无构建预检已通过：2607个Git blob、11运行文件＋原工单差量、目录映射及完整覆盖包核同，包SHA256 22e19cb40089a1fdc6c99a794e3800d370b886060b4e819e50f47f26fc448b80。沿封存1.1.2实际引擎，仅为六个已审服务端文件登记准确旧/新hash，不改71ea8e5应用字节或引擎逻辑，不取消相容门；SQL未执行，guard仍原artifact。先完成source-only，再接原构建剩余步骤，避免覆盖已生成预检。

本地输入生成两次失败均是把带注释的JS登记表当JSON读取；保留两份部分输入和失败记录，集中复盘后沿原预检的Node模块加载方式手工接完输入，未改正在运行的发布器。服务器未因此重开attempt，旧01–05成功/失败输入与日志不动。服务器17组真实SQLite/Sharp美术工程、旧文字/OAuth/许可回退、改动lint和全量tsc已通过；模型为隔离夹具，生产写入0、付费图片调用0。完整Next和最终准入仍在进行，未切换。

桥传原job3ecb381a-f617-4493-b278-989c81e50663已在正式运行的Mac mini原服务查到saved/received/receiptSent，实际文件1617194字节、PNG1280×915与SHA256全部核同。私有原图归档materials/2026-11-20-gpt-world-review/，该目录PNG已由自身.gitignore排除，未入Git/发布包。仅是用户参考原图，不是成品。收件凭据留本机；索引只登记不含凭据的接收证据。


### I1 0.151.0最终保护发布与公网核对

已部署，待Windows手动验收。实际应用源`71ea8e565ddb1da559aeaec1d2e1b49e88f003a5`，版本0.151.0，BUILD `d_gTKdW48NfIpvCQgxAA9`。沿原seamless1.1.2/automatic-same-plan，窗口`gpt-art-autoflow-20261120-71ea8e5`，实际run `cfbf8fd5-ca91-4c02-8bf4-034348bae014`，八步complete、publish-exit0。发布前确认基线仍206e67410/0.150.1/gcWweOyH29ArS-wghkXnE、无活动controller或其它发布占用，没有覆盖并行新源。

准确12文件全部冻结，含新增`src/lib/bridge/gpt-art-image.ts`；2607个选定跟踪文件与覆盖包逐blob核同。服务器执行本源17组真实临时SQLite/Sharp美术工程、旧文字/OAuth/PKCE/模型准入与有限回退，变更lint、全量tsc、完整Next与原生/计价/相容准入均通过。原生form相关源字节未改，绑定原隔离Chrome证据复用；没有声称本次已经浏览器真实Connect。所有模型为隔离夹具，Mac本批付费图片调用0、验证生产任务写入0；新原图未进编译输入。

attempt06完整编译成功后，旧`finalize-pair.py`仍要求上一批`reference-compatible-guard`检查名，实际原policy按本次差量返回参考媒体检查空集，runner新增`gpt-art-review`，故最终封装断言exit1。保留原脚本、controller.log、build-exit1及全部已生成构建，未覆盖旧attempt或重跑Next。只追加本次`finalize-art-pair.py`和封装接续：精确核七项实际检查的成功/日志hash、17组原结构化美术结果、真实SQLite/Sharp及零生产写入/付费图片调用，原源/BUILD/依赖/schema/相容guard核验不删；随后原独立准入再次通过，接续exit0。应用71源和封存引擎逻辑未改，仅六个已审server contract的准确新旧hash登记随新封存表使用。原01–05输入/日志/退出码、本地两次JS-as-JSON输入生成失败、此次封装失败完整保留，未把失败改成成功。

七个正式服务active且工作目录同源，实际`.next-prod/BUILD_ID`核同；双域`sd2.youdooart.com`、`sd2-server.youdoodesign.com`的release=0.151.0、health ok，目标静态CSS/JS字节核同。价格配置与三条旧未知请求全字段摘要不变，无DB恢复、新DDL、默认模型/费率/许可变更；原相容guard与旧页面资源保留，候选自然退出forcedKill=false。恢复入口沿本run的`/data/video-api-debugger/release-staging/cfbf8fd5-ca91-4c02-8bf4-034348bae014/seamless-plan.json`及原guard，仅回程序，不回业务数据库。探针超时0，不冒称已测量连续零中断。

两OAuth发现HTTP200：`/.well-known/oauth-authorization-server`、`/.well-known/oauth-protected-resource/api/bridge/review-mcp`；POST `/api/bridge/review-mcp` initialize与tools/list均200，工具仅`link_review`、`submit_revision`，OAuth2 scope `reviews.submit`。旧`https://chatgpt.com/connector_platform_oauth_redirect`与本次`https://chatgpt.com/connector/oauth/lrPNES-xwBHJ`均匿名302到登录；错误域、通配与额外query400。Origin/nonce/账号、PKCE、精确码绑定、私密准入与暂停CAS保护沿准确源，不放宽。

用户参考原图在Mac正式桥传原job的saved/received/receiptSent、实际字节/PNG尺寸/SHA已核同，私有归档与索引已完成；PNG排除Git且未公开、未入发布包。只保存安全接收metadata，参考原图不是成品。Windows客户端0.21.0实装、原生ChatGPT真实出图→MCP交回→独立看图→退回修改→复验及最终成品，原R1–R3和唯一文字生产记录均由Windows继续，不以工程与部署通过冒真实成图验收。

本批已通过原CX `/api/answer`、原Windows会话`win:01a1f724-18ef-77f0-945e-a92f765cf2fc`单次提交final，稳定intent `sd2-art-autoflow-release-71ea8e5-final`。原会话在现有列表核同GPT验收设计、Windows项目与codex来源，状态running且未静音/忽略；详情与turn_status读取超时，发送亦超时，最小原队列查询503，故送达保持unknown。未重复发、未换会话或路线重投、未等待ACK；后台发布成功与回执送达未确认分开记录。

证据：[实际部署](../../docs/materials/2026-11-20-gpt-art-autoflow/public-deployed.json)、[OAuth与工具](../../docs/materials/2026-11-20-gpt-art-autoflow/gpt-review-public-check.json)、[完整构建](../../docs/materials/2026-11-20-gpt-art-autoflow/main-build-success.json)、[准确输入预检](../../docs/materials/2026-11-20-gpt-art-autoflow/manual-input-preflight.json)、[美术与旧流程工程](../../docs/materials/2026-11-20-gpt-art-autoflow/main-focused-engineering.json)、[源相容摘要](../../docs/materials/2026-11-20-gpt-art-autoflow/source-pair-public-summary.json)、[封装失败与接续](../../docs/materials/2026-11-20-gpt-art-autoflow/finalization-continuation.json)、[回执尝试](../../docs/materials/2026-11-20-gpt-art-autoflow/windows-final-receipt.json)。原始私密策略、准入完整合同与失败日志留服务器，仓库仅存脱敏摘要和hash。

本轮新发现的线索与问题：未新增任务外问题。

## 通用自动闭环补修0.151.1（2026-11-21 Windows）

用户明确本项目是通用服务工具，先跑通文字自动退回/修改/复验，再用原图验证；Codex只修公共链路断点，不人工逐轮催、转发或补结果，改完自动安装，独立验收通过才交结果，Computer Use/CUA及间接调用禁止。旧R1–R3、743b2b34文字任务和f57a98d6旧方案任务保留。原图仍沿既有私有归档及桥传job3ecb381a-f617-4493-b278-989c81e50663，不重传、不入发布包。

现网2026-11-21 UTC Windows公共HTTP核对双域0.151.0/health=true。已用当前71ea8e5真实临时SQLite＋实际MCP处理器确定复现：文字改稿正在judging时，同单号/同正文重试收到stop，原请求随后revise；外部fetch禁用，生产写0，付费调用0。当前补修只改普通文字回执与并发收口：ready/judging返回pending和原单号；同号并发首交只在相同owner/connection/requestKey已受理时读回；领取下一单CAS冲突复用权威单号并重新核连接。暂停/恢复后旧判定写入继续由CAS拒绝，不能假报结束；不同账号/稿件/原生会话继续拒绝。美术原指令/次数/图片准入和OAuth/PKCE/Origin/许可/默认模型/费率均未变。package/lock为0.151.1，同一补修测试重试不再抬版本。

scripts/gpt-review-engineering.mjs新增judging重复、pause/pass/revise、pause→resume旧结果晚到、同时首交和同时公布下一单检查均通过；17组真实临时SQLite/Sharp美术回归、全量tsc及lint也通过，lint仅已有非本批警告。配套客户端0.21.2文字/美术隔离浏览器链路、worker账号/窗口/暂停/晚到回执、共享结果页忙状态检查通过。独立只读复核本批产品P1/P2已关闭。全部模型/ChatGPT传输仍为隔离夹具，不能当成原生真实闭环通过。

发布请求沿原Mac线程及seamless1.1.2，执行前必须重核当前有效源与共享发布窗口，保护正在推进的0.21.1五包/R1静态资产及其他已上线变更。此分支是从71ea8e5导出的聚焦补修，不允许整树覆盖更高现网；必要时把本批准确差异合入当前安全源，重新冻结统一构建/准入，保留原数据库/价格/三旧未知请求/旧guard与回退，不恢复DB。原始失败日志均保留。上线回执给本原Windows任务，仅声明工程部署；真实文字任务与原图验证由Windows按一次启动、后续只观察的规则继续。

### 0.151.1 Mac保护发布窗口

窗口`gpt-generic-flow-20261121-9615c56`沿原任务执行。donor27552066101fc72da4c167503d3739e8664d854d已从原origin核同；保留既有纯记录0e3c705后，合并应用源9615c566315e9c5aecc057970df0a2871348a8df已推原origin的codex/gpt-generic-flow-release-20261121。四个运行文件blob严格等于donor，其余旧发布历史保留，美术/OAuth/许可未变。

attempt07全部目录由同一新尝试派生，输入包SHA256 2c434e451620e61900962ee0c52450cf434f7e8406aedae2b1205210227555bf。完整Git库存、2649个选定源逐blob、本地与服务器无构建预检通过；继承118个不变历史媒体/证据/.env示例排除项。49项差量中4运行文件，45项为旧发布记录及原单。版本只改package/lock，release.ts继续从package读取，未为迁就输入改应用或放宽门。

本地一次Git库存断言失败如实保留：原选定归档不等于所有历史Git文件，修正为完整库存与原选定源分别核对，未因此启动服务器构建/切换。旧attempt01–06、06封装exit1与接续exit0均保留。attempt07完整工程与Next构建exit0，BUILD S5apHEsgkwm2yI0I3mizD；文字新回归、旧文字/OAuth/PKCE/许可回退、17组实际SQLite/Sharp美术、改动lint与全量tsc/lint通过。GPT_DIRECTORY_QA显式使用本次服务器工程根，模型均为隔离夹具，生产写0、付费调用0。原生form源字节未改、既有原生浏览器证据核hash复用；工程不代真实账号闭环。封存1.1.2只登记gpt-review.ts准确新旧hash，原引擎逻辑与guard保持，最终准入通过。切换前核当前七服务、双域与共享占用，实际结果随后追加。

### 0.151.1 最终发布与公网核对

已部署，待Windows手动验收。准确应用源`9615c566315e9c5aecc057970df0a2871348a8df`，版本`0.151.1`，BUILD `S5apHEsgkwm2yI0I3mizD`。donor2755206的四个运行文件逐blob保持，其余源继承线上71ea8e5，只额外保留旧发布记录。窗口`gpt-generic-flow-20261121-9615c56`，实际run `79676cb8-a8ea-4fb6-ba13-00d320ae047f`，原seamless1.1.2/automatic-same-plan八步complete，构建与publish均exit0。全批只构建、发布一次，没有覆盖或重跑旧尝试。

七服务active且WorkingDirectory同源，实际BUILD核同；双域sd2.youdooart.com和sd2-server.youdoodesign.com的release=0.151.1、health=true，相关静态CSS/JS全文摘要核同。价格配置与三条旧未知请求全字段摘要保持。原DB/队列/原号、默认模型/费率/许可和相容guard保留，未执行DDL或业务数据恢复，验证生产写0、付费调用0。候选及原writer交接沿原引擎完成，当前无活动发布controller；探针超时0不冒称测量了连续零中断。

两OAuth发现HTTP200：`/.well-known/oauth-authorization-server`和`/.well-known/oauth-protected-resource/api/bridge/review-mcp`；POST `/api/bridge/review-mcp` initialize和tools/list均200，只返回link_review、submit_revision，OAuth2 scope reviews.submit。旧ChatGPT回调和实际`https://chatgpt.com/connector/oauth/lrPNES-xwBHJ`均匿名302到登录，错误域/通配/额外query400；未放宽Origin、nonce、PKCE、码绑定或许可边界。原生form相关源未变，既有真实原生表单证据绑定hash复用，本批未冒称重新真实Connect。

额外发布前探针曾出现urllib HTTP403，原curl复核双域均200；另一次只读记录误读签名清单顶层version而KeyError。两次均在window写入与publish启动之前，真实失败记录保留。回到原shared/release.js核JSON.parse(envelope.payload)后修正额外记录，未改应用、冻结输入或原发布器，未绕过实际准入。另一本地文档写入编码失败及一次误猜payload编码的只读失败保留执行记录；正确按原实现写入和读取后继续，无二次构建/部署。

回退沿本run的`/data/video-api-debugger/release-staging/79676cb8-a8ea-4fb6-ba13-00d320ae047f/seamless-plan.json`及原固定相容guard，只回程序，不回业务数据库。attempt01–06原成功/失败输入、日志、退出码和06封装接续均保留；本次attempt07全部原始日志仍在服务器同名staging。新源Git库存/选定归档/输入摘要、工程日志和原生成时间均有对应证据，不将完整私密策略入仓库。

R1五包候选仍保留。正式生产桥latest仍0.6.32，原始SHA256 d6d8dd898fb0ce7bbe23f6a932ec7934830daa9a67d20b3f3763d20b8c9888ad发布前后相同；没有签名上传新桌面清单或切换R1。Windows0.21.2保护安装与真实文字自动退回→修改→复验及原图闭环由原Windows继续，工程部署不代功能通过，R1–R3/I1未完成边界不删。

备用zip原job181e9ea3-1578-46b8-af85-c7eaaf50bc8d在本轮Mac正式收件列表仍未见saved/path，未重发/重启桥传或动剪贴板；准确Git已可取，未阻断构建。原参考图沿job3ecb381a-f617-4493-b278-989c81e50663既有私有归档及receipt，Mac实际路径`/Volumes/Data/Projects/video-api-debugger/materials/2026-11-20-gpt-world-review/codex-clipboard-d5cca489-9430-4eb2-bfb1-d25e4477fe14.png`，1617194字节、1280×915、SHA066a0bad574ea7087f6699c69edd7cdd2d273874d5e6e1c94d48d98f29f35899。未重传、公开或加入发布包，不是成品。

证据：[实际部署](../../docs/materials/2026-11-21-gpt-generic-flow/public-deployed.json)、[窗口与回退](../../docs/materials/2026-11-21-gpt-generic-flow/publication-closure.json)、[OAuth/MCP](../../docs/materials/2026-11-21-gpt-generic-flow/gpt-review-public-check.json)、[完整构建](../../docs/materials/2026-11-21-gpt-generic-flow/main-build-success.json)、[统一工程](../../docs/materials/2026-11-21-gpt-generic-flow/main-focused-engineering.json)、[源相容摘要](../../docs/materials/2026-11-21-gpt-generic-flow/source-pair-public-summary.json)、[证据清单](../../docs/materials/2026-11-21-gpt-generic-flow/evidence-manifest.json)。本次单独阶段查询已原CX answer单次steer，received/confirmed，见[阶段回执](../../docs/materials/2026-11-21-gpt-generic-flow/stage-query-receipt-response.json)；最终发布回执另按原请求单次发送。

本轮新发现的线索与问题：未新增任务外问题。

0.151.1最终发布回执已通过原CX answer向Windows「GPT验收设计」原会话win:01a1f724-18ef-77f0-945e-a92f765cf2fc单次提交，HTTP200、submitted/confirmed、delivery_state=received，实际input_mode=steer，原turn_id记录在[最终回执](../../docs/materials/2026-11-21-gpt-generic-flow/windows-final-receipt.json)。没有等待ACK或重发；受理不等于Windows功能验收。阶段查询另有独立单次回执，未把其当最终发布回执。
