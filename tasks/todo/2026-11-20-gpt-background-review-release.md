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


### Windows原生版本复盘后的执行端停止补修（2026-11-21）

0.151.1/9615c5已发布、0.21.2/044041b实装。新文字CID6b0169e9-3860-83ea-a2e0-a909a181dc4d已真实一次启动自动退回、改稿、工具交回、独立通过，原同条保存两轮、自动修改1次。接着原图CID6b004899-46ac-83e9-aca8-0361bc5ddbfe仅一次启动，初始单号0f5c8312-f4df-4c20-a38d-e0939be08fbc；原生GPT未交分析便直接出图，被原服务third-party content相似性规则拒绝，原生回复已结束，SD2仍等待分析且误提示需要启用连接。图像及分析均未接收，改稿/复盘0，不能冒称原图通过。Windows材料在D:/MYDR/cdoex/sd2/materials/2026-11-21-generic-flow/的text-native-page-pass.json、text-native-task-record.json、art-native-version-review.json及原始observation；Mac原参考图仍沿materials/2026-11-20-gpt-world-review/codex-clipboard-d5cca489-9430-4eb2-bfb1-d25e4477fe14.png，原SHA066a0bad574ea7087f6699c69edd7cdd2d273874d5e6e1c94d48d98f29f35899，不公开/不重传/不入发布包。

本批0.151.2/客户端0.21.3仅补公共阶段调度与执行端终态反馈：当前阶段指令不混入未来出图动作；已结束且严格匹配原命令/回复的拒绝或超时未交回，沿原账号/工作区/设备/CID/原稿/单号链及CAS版本停止，保存原因、不接受为稿、不增加次数、不自动重试。原暂停、新结果、其他账号/页面、旧版本优先；不恢复被拒绝的图像请求，不换工具或改目标绕过限制。复用既有UserPreference，无DDL、权限/默认模型/费率/许可/媒体通道变更，2MB疑点未触发故不修改。先完成全批实现和配套回归，再统一检查，L4只读审查后沿原部署链接续。当前原唯一受阻任务保持，没有手工催稿、回传或新建原图任务；测试/发布/真实停止反馈尚待。

复用Temporal SDK failure.ts的nonRetryable语义（https://github.com/temporalio/sdk-typescript/blob/main/packages/common/src/failure.ts，已读实际实现），不安装框架。0.151.1正式源与donor运行文件相同，已fast-forward到远端纯证据HEAD794dd3e8f0242b99a683e63b2cfbd638e85fd34c并保留原发布材料后补修，不以旧donor盖掉Mac记录。

首轮集中复盘：文字和18组艺术真实SQLite/Sharp/lint通过；原Windows全量tsc因已确认P1/P2逻辑修正需淘汰旧批次，精确自有进程停止，未称通过，最终正式输入仍须完整tsc/Next准入。独立复核发现历史D1可用新version停止D2；现改为current delivery精确匹配，并仅向客户端投影当前单号SHA256摘要供关联，不暴露新单号。补旧分析已交/D2新轮对两种停止报告均409回归。details在未派发准备态另外给当前builder结果，新发行票据更新当前stage指令；已发行/不确定/拒绝的原文不可变，无自动重组或重发。新增实际SQLite旧unissued/issued相容回归，图审组数由18变为20；新执行停止字段仍放既有JSON，无DDL或空间类别变化。客户端同步补真实完成栏、整块iframe和异步再检查/引用误判边界，统一batch2尚待。

最终统一batch2及无传输包装艺术Chromium已通过，产品只读审查P1/P2为0。最终源全量tsc也已exit0，证据generic-flow-stop/backend-types-final.log；20组真实临时SQLite/Sharp与文字/旧OAuth/许可、lint保留原证据。只修夹具有效回执统计，同wake核对不冒新增发送，严格native发送次数和单任务计数断言不变。下一阶段沿原Mac发布0.151.2，生产任务写0、付费图片调用0；Windows仅观察原已拒绝任务停止，不重试生成。

### I1 原创输入：原页面异步确认与提交竞态（0.151.3候选，2026-11-21）

沿原I1继续，原被拒任务保留且不重试；本次另用原创河畔小屋。新CID6b01d7f7-72e0-83ea-9a79-9fad8a1f82a8，任务b9e19e80-b3cf-424c-bc09-934fb671284f，分析单号7e7d9621-65ed-4c79-8f1a-94549ac3cfe4。ChatGPT真实分析已完成，先调用link_review，再交分析时收到未连接409并停止；随后本机真实扩展上下文读到verified=true，任务仍awaiting/analysis，实际改稿0、复盘0。这证明组件确认与模型提交的异步竞态，不是nonce/CID校验失败，不能以此放宽来源核对。源证据见同目录资料索引的source-confirmation-race.json；Windows私有原件.cache/qa/original-art-flow-20261121/的bsk-assistant-after-reconnect-13.json及native-scoped-task-state-30.json，无人工提交稿件。

本批从实际线上3871458/0.151.2及远端纯记录8ffa4414安全接续，补已有MCP提交入口：同owner/delivery/connection且已有未过期配对记录、当前仍等待确认时，最多等2秒再返回pending和原单号。未确认前不读图片、不接稿、不调用模型、不增加计数；确认后再走原revisionForTool严格核对与CAS。无配对/错账号/绑定别的连接/过期/暂停或换单仍拒绝；确认仍只能由原页面的nonce/CID/device证明完成。复用已有pending重试语义，不安装新框架。核读MCP官方schema/2025-06-18/schema.ts的CallToolResult/structuredContent/isError，来源https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.ts；pending是本项目业务状态，不冒协议原生异步任务。

整批实现与配套测试完成后统一检查：8组真实临时SQLite专项、旧文字/OAuth/PKCE/许可、20组SQLite/Sharp美术、全量tsc和变更lint均exit0；模型/传输仍隔离夹具，生产写0、付费图片0。专项首批2组失败为新增夹具problem不足原有8字符要求，原日志保留，整批修夹具及错误断言后8组全过，未改业务门槛。Windows证据根D:/MYDR/cdoex/sd2/.cache/qa/source-pending-01513-20261121/，不能当Mac已读的附件。独立只读审查和保护部署待接续；Windows客户端仍0.21.4，正式0.6.32/R1 HOLD，真实图片退回→修改→复验仍未通过。部署后仅经产品已有技术恢复入口继续原新任务，不手工交分析/图片或逐轮提示；不恢复原被拒任务，不改许可、费用、默认模型、数据库或旧未知请求。

独立只读审查未发现P1，发现1项P2：确认前pending回执不应透出stage/changes，避免同账号其他对话拿到单号后读到任务进展。本批已去除这两个字段，新增精确公开键集合断言；原稿接收/计数规则未改，专项与类型/lint复核待接续，同交付不再次抬版本。真实原生模型对pending的自动重试仍须实测，不能用工程测试替代。

最终复核：8组专项再次全过，P2经独立只读审查关闭，无新增P1/P2；全量tsc、变更lint最终exit0。旧文字/OAuth/20组艺术未受去除未确认元信息影响，复用同批通过证据。线上仍0.151.2，0.151.3尚未发布，当前客户端任务继续awaiting/analysis，原稿和计数未变。发布原Mac线程01a1c73b-3458-77b1-9c6b-81cf82439d06、cwd/Volumes/Data/Projects/video-api-debugger身份可回读，但最新control.available/loadedInApp为false；先保留准确候选与原发布记录，不冒部署完成或绕过未连接状态。


### 0.151.2 Mac保护发布窗口与准确输入

接续dispatch sd2-gpt-executor-stop-backend-3871458-20261121-01。原origin已fetch并核对准确对象387145889ca78892cba4b86a545212b43f5b6f3a及父794dd3e8f0242b99a683e63b2cfbd638e85fd34c，原隔离发布分支fast-forward至该源，六个文件逐blob核同；正式根和其他工作区脏改保持。唯一运行实现为gpt-review.ts，原OAuth、模型/费用/许可、数据库DDL不改。原Windows报告文字真实自动退回/改稿/同条复验通过；原图原生服务明确拒绝，成品未通过，不重试该生成。

attempt08从同一根派生staging、工程临时根、日志、输出与manifest，基线0.151.1/9615c566315e9c5aecc057970df0a2871348a8df/BUILD S5apHEsgkwm2yI0I3mizD；2676个选定Git文件、2794个完整跟踪库存和118个继承排除项分别核对。35项差量含5运行/工程文件和30项既有记录，准确源保留全部历史。31份冻结输入集中离线预检通过，557927字节输入包SHA256 0def72b8960680f1bb557ce2213681772a8c22571a88f09bc7283dca3e09c8fb，服务器收包核同后开始无构建预检；当前尚未切流。艺术封装按本源20组、storage7类核验，未沿用旧17组断言。

原01–07输入、失败日志、退出码和成功证据保留；本次候选不依赖私有原图。原参考图仍按既有私有索引保存，不公开、不入包。原R1–R3/I1及未完成项继续：按最新用户指令，正式桌面latest维持0.6.32，0.21.1五包保留候选，不切正式清单；客户端0.21.3保护安装和原唯一任务终态反馈由Windows负责。服务器工程部署不代真实功能验收。


### 0.151.2 最终保护发布与公网核对

已部署，待Windows观察原唯一任务终态反馈。准确应用源`387145889ca78892cba4b86a545212b43f5b6f3a`，版本`0.151.2`，BUILD `HXp7sptwsqY7VINWiKUKI`。原origin donor和父794dd3e均核同，未用散文件覆盖；原隔离发布分支保留全部0.151.1成功记录。attempt08输入预检、完整构建和发布各只执行一次，均exit0；无覆盖旧尝试或重跑未知切换。

本源文字真实临时SQLite、20组实际SQLite/Sharp艺术、7类storage、旧文字/OAuth/PKCE/Origin/许可模型回退、变更lint、全量tsc与完整Next均通过；lint只有既有非本批警告。GPT_DIRECTORY_QA明确使用attempt08自己的服务器工程目录。原生form相关字节未变，原浏览器证据hash绑定复用。模型/ChatGPT传输为隔离夹具，工程生产写0、付费图片调用0，不当作真实原生账号闭环。最终准入确认sameSchema/unchangedPersistedContracts、sqlExecuted=false、coldFallbackAllowed=false；原guard及封存引擎逻辑保持，仅登记准确新旧实现hash。

窗口`gpt-executor-stop-20261121-3871458`，run `66b91905-4cf4-4a8e-b583-864637b4bc28`，沿seamless1.1.2/automatic-same-plan八步complete，publish-exit0，无活动controller。七服务sd2-gray/image-studio/hd-derivatives/multiview-works/role-coordinator/template-prompts/periodic-credits全部active、WorkingDirectory同源，实际BUILD核同。双域sd2.youdooart.com、sd2-server.youdoodesign.com release=0.151.2、health=true，实际CSS/JS完整字节摘要核同；旧页面静态资源保留，候选自然退出forcedKill=false。探针超时0，不冒称测量了连续零中断。

两个OAuth发现接口HTTP200：`/.well-known/oauth-authorization-server`和`/.well-known/oauth-protected-resource/api/bridge/review-mcp`。POST `/api/bridge/review-mcp` initialize与tools/list均200，工具仅`link_review`、`submit_revision`，scope `reviews.submit`。旧回调及实际`https://chatgpt.com/connector/oauth/lrPNES-xwBHJ`匿名302到登录，错误域/通配/额外query400；Origin/nonce/账号、PKCE、精确回调和私密模型许可均未放宽。

价格及三条旧unknown请求全字段摘要核同，原业务DB/队列/原号/guard保持，无新DDL、数据库恢复或默认模型/费率/许可改动。回退入口`/data/video-api-debugger/release-staging/66b91905-4cf4-4a8e-b583-864637b4bc28/seamless-plan.json`，沿原固定相容guard只回程序，不回业务数据库。旧attempt01–07全部输入、成功/失败日志、退出码保留，完整新原始日志和私密合同仍在服务器attempt08；仓库只留脱敏证据与原文件hash。

最新桌面协调边界维持：正式latest仍0.6.32、SHA d6d8dd898fb0ce7bbe23f6a932ec7934830daa9a67d20b3f3763d20b8c9888ad不变；0.21.1五包现在已完整构建同源、原钥签名并上传私有候选目录，服务器五包摘要全通过。按本dispatch要求hold，未移动公开版本目录或原子切latest。R1正式下载/新版登录页/签名自动更新仍未完成，不用本次后台部署代替R1。客户端0.21.3由Windows保护安装；原图服务明确拒绝不重试，Mac不写原任务、不人工回传，真实终态反馈与成品仍待Windows，本批停止修复不冒成品通过。原R1–R3/I1未完成项保留。

原参考图继续沿既有job3ecb381a-f617-4493-b278-989c81e50663私有归档`/Volumes/Data/Projects/video-api-debugger/materials/2026-11-20-gpt-world-review/codex-clipboard-d5cca489-9430-4eb2-bfb1-d25e4477fe14.png`；1617194字节、1280×915、SHA066a0bad574ea7087f6699c69edd7cdd2d273874d5e6e1c94d48d98f29f35899沿原已核证据，不重传/公开/入包，不是成品。

证据：[实际部署](../../docs/materials/2026-11-21-gpt-executor-stop/public-deployed.json)、[窗口和回退](../../docs/materials/2026-11-21-gpt-executor-stop/publication-closure.json)、[OAuth/MCP](../../docs/materials/2026-11-21-gpt-executor-stop/gpt-review-public-check.json)、[完整构建](../../docs/materials/2026-11-21-gpt-executor-stop/main-build-success.json)、[统一工程](../../docs/materials/2026-11-21-gpt-executor-stop/main-focused-engineering.json)、[相容安全摘要](../../docs/materials/2026-11-21-gpt-executor-stop/source-pair-public-summary.json)、[证据清单](../../docs/materials/2026-11-21-gpt-executor-stop/evidence-manifest.json)。

本轮新发现的线索与问题：未新增任务外问题。

0.151.2最终回执已向Windows「GPT验收设计」原会话win:01a1f724-18ef-77f0-945e-a92f765cf2fc通过原CX answer单次提交，HTTP200、submitted/confirmed、delivery_state=received、input_mode=steer，原turn_id见[最终回执](../../docs/materials/2026-11-21-gpt-executor-stop/windows-final-receipt.json)。无ACK、未重发；回执受理不代表Windows功能验收。R1新增五包签名/完整私有上传且继续hold的事实已另向其原会话单次更新，未复发旧final。


### 0.151.3 Mac保护发布：准确源与构建窗口

接续source-pending-01513-01，原origin准确源90e6d9a1daa1e8958007aaf1510f3c000f0e72f3已取得，父8ffa4414与原隔离发布分支核同后fast-forward，无覆盖正式根脏改。服务器现网仍3871458/0.151.2/BUILD HXp7sptwsqY7VINWiKUKI，未见活动发布controller。仅MCP提交入口与来源配对等待实现变化，原nonce/CID/device确认、OAuth/PKCE/Origin/许可/默认模型/费用不改；未确认不接稿/下载/判定/增加次数。独立审查结果沿Windows原证，本Mac工程部署不代真实原生自动重试验收。

attempt09所有staging、工程临时根、输出、日志与manifest由同一根派生。完整2824项Git库存、2706个选定源、118项继承排除、38项差量（6运行/工程与32既有记录）核同；31份冻结输入本地集中预检、服务器包SHA及无构建预检均通过，输入包SHA256 5c64e4838b9f932a8f6f606f1b0b9bee02785377c2bcca464724192f5d53bd09。source-only准入确认sameSchema/unchangedPersistedContracts、sqlExecuted=false、coldFallbackAllowed=false。只登记两个实际server contract的新旧hash，未改封存引擎逻辑。原01–08输入/日志/退出码保持。

本地准备出现Python3.9不支持安全解包filter参数、生成器精确非运行差量替换未命中两项错误，均在服务器构建前保留原件并修正；后者被原输入验证器挡住，未放宽门、未改应用、未另开attempt。当前仅在attempt09启动一次构建，含新增8组确认竞态、原文字/20组艺术/7类storage、类型lint/Next和最终准入，尚未切流。GPT_DIRECTORY_QA明确使用本次服务器工程根。原R1–R3/I1、任务、数据/费用、原guard及程序回退保留；正式桌面latest继续hold，Mac不代跑业务，不重试原拒绝图像请求。


### 0.151.3 最终保护发布与公网核对

已部署，待Windows真实原流程验收。准确应用源`90e6d9a1daa1e8958007aaf1510f3c000f0e72f3`，版本`0.151.3`，BUILD `FvZqDYtrsby-4Dfcz6k6K`。attempt09输入预检、完整构建和发布均只运行一次、exit0，沿原seamless1.1.2/automatic-same-plan八步complete，run `abc95d24-d01d-4bce-856c-ed5155c0dd58`。所有旧成功/失败与本地准备错误原件保留，未改应用字节迁就发布门或重跑未知切换。

服务器新增8组真实SQLite来源确认竞态、旧文字/OAuth/PKCE/许可回退、20组实际SQLite/Sharp美术、7类storage、变更lint、全量类型与完整Next均通过；原生form依赖字节未改，旧原生表单证据绑定hash复用。新统一工程保留原七项并加确认专项，共八项结果，日志摘要核同；模型/ChatGPT传输为隔离夹具，工程生产写0、付费调用0。实际pending自动重试、原生图片退回→修改→复验不冒工程通过，仍由Windows独立观察。

七服务全部active，逐个MainPID实际/proc cwd核同本源，.deployed-commit与实际BUILD一致。双域sd2.youdooart.com和sd2-server.youdoodesign.com的release=0.151.3、health=true，服务器与Mac独立公网读取核同；两份目标CSS/JS在双域完整字节摘要匹配，匿名私有资源入口401。两OAuth发现、MCP initialize和tools/list均200，工具仅link_review、submit_revision，scope reviews.submit；旧及真实精确回调302到登录，错误域/通配/额外query400。Origin/nonce/CID/device、PKCE、原账号与许可边界不变。

价格配置和三条旧unknown请求全字段摘要保持，sameSchema/unchangedPersistedContracts通过，sqlExecuted=false、coldFallbackAllowed=false；无业务DB恢复、新DDL、默认模型/费率/许可变更，不代写原任务或重试被拒图像。回退入口`/data/video-api-debugger/release-staging/abc95d24-d01d-4bce-856c-ed5155c0dd58/seamless-plan.json`，沿原相容guard仅回程序，不回业务数据。原控制器已退出，探针超时0不冒称实测连续零中断。

正式生产桥latest仍0.6.32，原SHA d6d8dd898fb0ce7bbe23f6a932ec7934830daa9a67d20b3f3763d20b8c9888ad保持；0.21.1五候选和R1自动同步修订保留，本次后台发布不代桌面发布，也不解除最终准确源/同源五包与R1/I1验收条件。原R1–R3/I1全部有效未完项、原创新任务与原被拒任务、私有原图及账号/CID隔离继续。

自动审批拒绝批量下载原日志/计划，理由是可能带敏感内部数据；未执行该传输，也未换工具下载相同原件。改用明确固定字段断言及不可逆摘要的安全替代，已获准完成。仓库只归档脱敏核验摘要，详细原件仍在服务器attempt09；没有把未复制原件说成已归档。证据：[服务器限定字段实际回执](../../docs/materials/2026-11-21-gpt-source-pending/server-safe-receipt.json)、[Mac独立公网核对](../../docs/materials/2026-11-21-gpt-source-pending/mac-public-verification.json)、[准确输入预检](../../docs/materials/2026-11-21-gpt-source-pending/manual-input-preflight.json)、[输入库存摘要](../../docs/materials/2026-11-21-gpt-source-pending/input-inventory.json)、[原准备失败](../../docs/materials/2026-11-21-gpt-source-pending/input-preparation-failures.json)、[资料边界](../../docs/materials/2026-11-21-gpt-source-pending/evidence-handling.json)。

本轮新发现的线索与问题：未新增任务外问题。

0.151.3最终回执已按本轮短消息规则向原Windows“GPT验收设计”会话单次普通发送，HTTP200、submitted/confirmed、delivery_state=queued。目标正在运行，因此按最新规则排队，未引导或打断；无ACK、未重发，queueId未返回不编造。准确源、BUILD、工程/公网与回退细节链接到已推送的固定发布记录98210457fa10b5ecc8df606f54764175f9411b29；221字正文只含自然语言、版本和可读链接，没有任务号/会话号/哈希正文。见[实际回执](../../docs/materials/2026-11-21-gpt-source-pending/windows-final-receipt.json)。入队不等于对端已读取或业务验收完成；原R1–R3/I1继续保留，Mac本次保护部署已完成。

### I1 原生分析已交回，集中修复步骤交接（2026-11-21）

实际0.151.3已保护上线，Windows0.21.4原生新任务技术恢复一次后，GPT真实link_review与submit_revision成功交回分析，服务进入image/修改0/复盘0。GPT随后把“本轮只分析”理解为本次回复必须结束，虽然返回continue仍未出图；这是执行器交接责任不清，不能人工补发每一步。证据D:/MYDR/cdoex/sd2/.cache/qa/original-art-flow-20261121/bsk-native-analysis-recovery-50.json；原创输入仍为同固定资料索引中的河畔小屋原件，不是成品。

本批计划集中完成：兼容旧工具连续模式，为新客户端增加队列逐步执行能力；后台每次接受本步后持久登记下一步，客户端只在原账号、原对话、原命令确认完成后，经原recover/队列单次发送下一步。复用已有有界恢复、同号防重和实际产物审查；不人工交稿/判定，不重试原被拒任务，不改模型、费用或权限。新任务自动启用；同一旧任务仅在正常显式继续并核原设备来源后升级，不重置阶段/轮次。全部代码和配套场景写完再统一验证，独立只读审查后再发布/安装及真实原任务闭环。I1仍进行中，R1–R3与所有保护保持。

核读MCP官方Tools说明：https://modelcontextprotocol.io/specification/2025-06-18/server/tools。协议仅定义模型调用及结果，不保证模型完成多步；本次以现有持久状态和队列接续，不安装工作流框架，不把提示词当执行保证。

2026-11-21 集中复核：首批全量类型/lint、20组旧艺术、8组确认等待、旧文字/OAuth及客户端8场景通过；新队列工程发现同号重交被误停。独立只读审查另发现非实际成图漏接续、暂停后重审覆盖恢复标记，以及客户端新单未发送时恢复、等待中回复变更、纯图片及清空已发队列边界。现统一修正并补齐专项；下一批在同一候选统一复测，原失败日志保留，尚不发布或宣称业务通过。新增执行方式仅本人正常创建/原设备原对话显式恢复时启用；保旧工具连续模式、原任务/计数、拒绝停止、账号及回退边界。

2026-11-21 首条恢复边界补充：原任务在首次领单前暂停时，原账号/设备/CID/source、初始分析且零收稿/单轮的显式恢复现在可取得首条新单；仍未视为已确认页面连接。此前已有票据的同样守卫保留。新增真实临时SQLite专项覆盖错误source拒绝及同号重复恢复。客户端只对原生点击前明确拦截保存“确定未点击”状态；等待核对后可继续同单，未知发送和服务拒绝不重试。全批修正完成后统一复测，不人工业务接力。
第七批复盘：队列专项9组、确认等待8组、文字/OAuth与类型/lint通过；旧艺术首条恢复兼容场景失败。已将尚未领单的恢复严格限定 queue-v1，旧连续工具模式仍必须走原首次连接证明；既有已领有效单号分支保持。客户端审查集中修复同单命令重复追加、未真正清空输入及测试短暂提示竞态。整批修改后统一第八批验证，不弱化原测试、不改生产业务任务。源与部署候选仍0.151.4，尚未发布。
2026-11-21 队列接续候选最终工程核对：后台第八批新增队列9组、旧艺术20组、确认等待8组、文字/OAuth及全量类型/lint全部通过。客户端第十一批完整15场景和既有3组测试文件全部通过，包含一次启动自动分析→首稿→真实夹具判退→自动修改→通过、清空已发队列、纯图完成、回复迟到拒绝、原账号/原对话/原图与新提问保护、首单及已领未发暂停恢复、响应丢失、旧票据和明确未点击恢复。独立只读审查通过发送边界、账号/原对话及空段修正，未以源码审查替代真实出图。证据位于主仓 .cache/qa/queued-art-01514-0215-20261121/attempt08 与 attempt11；旧attempt保留。本次后台仅package版本、MCP描述、原流程库与新增隔离工程脚本，不改费用/模型/权限/DDL/业务数据，正式桌面latest 0.6.32继续HOLD。
部署输入为本次Git完整源与工程夹具；原图不属发布包。Windows新原创测试图沿主仓 materials/2026-11-21-original-art-flow/exec-87d2fd2f-5c42-41c4-9cf4-0dc80b17e187.png 私有保存；原拒绝任务与Mac原素材归档保留。真实新测试对话混入无关NAS命令，已停止业务写入，禁止以人工拼接或改稿冒充闭环。安装与重新选择独立测试页面仍待Windows接续，不宣称成图通过。


### 0.151.4 Mac保护发布：准确队列接续源与唯一构建

用户授权仅发布后台，原origin准确b31e0ca70a69d9bf0ff0f073e35a54662c29ee77已取回，父9863fbc与原隔离分支核同后安全快进，保留全部0.151.3发布记录。仅MCP说明/原流程库、九组隔离工程及package版本变化；queue-v1为可选执行方式，旧模式和文字继续，旧任务只在原设备/CID/source显式恢复升级，原来源确认、nonce/OAuth/PKCE/Origin、模型/费率/许可与暂停CAS不变。无DDL，不写生产任务，原图不入包，原R1–R3/I1和正式桌面hold保持。

attempt10统一派生staging、工程根、日志/输出和manifest，完整2836个Git库存、2718个选定文件、118项不变继承排除核同；19项差量含5运行/工程与14项既有记录。31份冻结输入、本地语法与原验证器集中预检、服务器包hash及无构建预检均一次通过，输入包SHA256 a6dd3d077f3b9c30a3510f6eabc2c6fa69e5b4081d81d902a05835a65d71fc64。仅登记两个实际server contract准确旧新hash，封存1.1.2逻辑不变，源级准入sameSchema/unchangedPersistedContracts、sqlExecuted=false、coldFallbackAllowed=false。全部旧attempt01–09输入/日志/退出码保留。

服务器基线仍90e6d9a/0.151.3/BUILD FvZqDYtrsby-4Dfcz6k6K，无活动发布占用；本次仅启动attempt10一次构建，新增九组队列与旧二十组艺术、八组确认等待、文字/OAuth/许可、类型lint/Next和最终准入统一接续。GPT_DIRECTORY_QA使用本次服务器工程目录；原生表单相关依赖字节未改，沿原证据hash复用。Windows客户端15场景及独立审查为来源方证据，本Mac不冒称客户端真实出图已验。


### 0.151.4 最终保护发布与公网核对

已部署，待Windows真实队列自动流验收。准确应用源`b31e0ca70a69d9bf0ff0f073e35a54662c29ee77`，版本`0.151.4`，BUILD `2KpVPgX99TaRY9QDkA97z`。原隔离分支安全快进，全部旧发布记录保留。attempt10输入预检、完整构建和切换各一次、均exit0，窗口gpt-queue-continuation-20261121-b31e0ca，run `8a77c842-dc6a-4646-9ba7-977e06a2ec85`；原seamless1.1.2/automatic-same-plan八步complete。未重开/覆盖旧attempt，也未回业务数据。

本源九组实际SQLite/Sharp队列专项、二十组旧艺术、八组确认等待、旧文字/OAuth/PKCE/许可回退、七类storage、变更lint、全量类型及完整Next全部通过，九项统一工程结果和原日志摘要核同。原生form依赖字节未变，旧原生表单证据按hash复用。所有模型/ChatGPT传输均隔离夹具，工程生产写0、付费调用0；Windows客户端15场景及独立审查是来源方工程证据，不冒Mac实装或原生出图通过。真实原对话自动分析→出图→退回修改→复验仍待Windows，Mac未写生产任务或人工交稿/判定。

七服务全部active，每个MainPID实际/proc cwd与准确应用源核同，.deployed-commit及实际BUILD一致。双域sd2.youdooart.com和sd2-server.youdoodesign.com的release=0.151.4、health=true；服务器与Mac独立公网读取均通过。两份目标CSS/JS在双域全文摘要相同，匿名私有资源入口401。两OAuth发现、MCP initialize与tools/list均200，工具仍仅link_review、submit_revision、reviews.submit；实际线上submit_revision说明已含handoff=queue及旧模式接续语义，未以仅版本号冒已加载。两个合法精确回调302到登录，错误域/通配/额外query400。

价格及三条旧unknown请求全字段摘要保持，sameSchema/unchangedPersistedContracts通过，sqlExecuted=false、coldFallbackAllowed=false；无新DDL、数据库恢复、默认模型/费率/许可变化。原任务/计数、账号/设备/CID/source绑定、nonce/Origin/PKCE、一次性原单和暂停CAS均沿准确源保持。回退沿`/data/video-api-debugger/release-staging/8a77c842-dc6a-4646-9ba7-977e06a2ec85/seamless-plan.json`及原固定相容guard，仅回程序，不回业务数据。原控制器已结束，探针超时0不冒称已测量连续零中断。

正式桌面latest仍0.6.32，SHA d6d8dd898fb0ce7bbe23f6a932ec7934830daa9a67d20b3f3763d20b8c9888ad核同；0.21.1五候选、自动同步工具和R1–R3/I1未完成项均保留，本批后台发布不替代桌面正式交付或解除hold。原被拒请求不重试；所有原图沿既有私有归档及Windows固定素材索引保存，未公开、重传或加入本次Git构建包，新原创原件也未冒称已复制到Mac。

自动审批拒绝了原验证日志stdout/stderr回传，理由是可能含敏感内部数据，原调用未执行。已改为原验证器输出和异常全留服务器私有日志，仅返回严格白名单状态和不可逆摘要，安全替代获准并完成；没有换工具下载被拒原件。完整日志/计划/私密合同/业务快照留原服务器attempt10，仓库只含脱敏摘要。证据：[服务器实际回执](../../docs/materials/2026-11-21-gpt-queue-continuation/server-safe-receipt.json)、[Mac独立公网检查](../../docs/materials/2026-11-21-gpt-queue-continuation/mac-public-verification.json)、[准确输入预检](../../docs/materials/2026-11-21-gpt-queue-continuation/manual-input-preflight.json)、[冻结输入库存](../../docs/materials/2026-11-21-gpt-queue-continuation/input-inventory.json)、[核验安全边界](../../docs/materials/2026-11-21-gpt-queue-continuation/evidence-handling.json)。

本轮新发现的线索与问题：未新增任务外问题。
