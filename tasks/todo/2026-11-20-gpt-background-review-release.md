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
