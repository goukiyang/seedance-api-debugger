# SAFE-RETRY01 图片与视频安全自动重试前置

版本 v1.0.0/R01；2026-10-31（America/Los_Angeles）。项目正式根：`/Volumes/Data/Projects/video-api-debugger`。

## 1. 目标、结论与完成边界

### 2026-10-31 SR-IMPL01 当前实施授权

用户最新明确要求先实现机制，供应商回复后再针对性调整；本要求替代本单此前“等待合同补齐后才能开始机制实施”的阶段限制。现在实施并沿项目既有授权检查、提交推送及保护部署：首次失败后最多再试3次、同任务单预留单结算、持久attempt/后台调度/状态展示、可维护的供应商规则。尚未确认的错误仍不得凭HTTP状态或客户文案推断免费，原受理或费用未知继续查原号；缺合同仅限制相应新生成规则的启用，不阻断基础机制交付。不是授权历史失败批量重跑、跨项目、换Key/供应商/模型或新增收费验收。

已标系统性风险：单任务原字段只容纳一个上游身份，直接覆盖会丢回执；中间失败若先结算会造成二次预留/收费；旧worker不能读取新attempt策略时可能重复发。实施必须复用现有租约/账本幂等，保每次身份与冻结输入，增量数据/回退reader成套；不借此切库、重造队列或修改历史任务。独立业务功能手验仍由用户完成。本节为当前约束，以下前置状态保留其历史含义。

2026-10-31后续CG-STATE01：用户已确认修正事实来源职责，项目状态以固定todo/原工单记录，不再要求CodeGraph memory/docs回写；本单以下接口缺失描述保留为调查当时事实，该流程缺口已由规则修正解除，不代表新增接口。供应商安全重试/费用合同缺证仍未解除，未启用自动重试。

用户要求：查供应商接口文档，确认哪些错误码明确不会扣费且可安全重试；首次失败后再试3次，完成前置方案。本轮仅调查、设计及文档提交，不改应用、不启用策略、不生成、不查改生产账本、不联系供应商。

**结论：已完成可取得的公开文档核对和机制设计；尚不能宣布全部前置完成或交付可直接实施的自动生成工单。** 当前查到的 FluxPort 与 Musk 官方资料没有提供满足本需求的“精确错误码 + 旧执行确定终止 + 旧尝试不收费/已退款 + 可重新生成”完整合同。首批自动新生成白名单为空；不能用空白名单的空转实现冒充目标完成。责任保留在本对话，不转交下一执行者补调查。

| 编号 | 工作 | 完成标准 | 当前状态 |
|---|---|---|---|
| SR01 | 供应商文档与错误码核对 | 官方来源、具体阶段、收费与重试语义分清 | 已完成本轮可取得资料核对；可启用白名单合同缺失 |
| SR02 | 重试/费用/状态/体验设计 | 首次+3次，单任务单结算，未知不重发，历史不变 | 设计完成，条件性方案，未实施 |
| SR03 | 源码落点、依赖、检查与回退 | 真实文件和函数、保护项、实施顺序与验收 | 已定向核对；供应商合同仍是启用前置 |
| SR04 | 固定记录、Git、CodeGraph | 正式根工单与索引可找，聚焦上传，状态同步真实 | 文档归档；Git按最终回执；CodeGraph源码查询成功，状态存取接口缺失 |

## 2. 一手资料与证据范围

2026-10-31实际读取，原件保存在[本地资料目录](../../docs/materials/2026-10-31-safe-generation-retry/)，来源与SHA见[证据登记](../../docs/materials/2026-10-31-safe-generation-retry/evidence.md)。只GET公开资料，未执行远端JS、未发送API Key或私有任务号。

1. [FluxPort接口文档](https://uselg.top/docs)：从当次HTML确认实际加载 `ApiDocsView-DvghblkZ.js`，读取错误码、图片任务与重试、视频任务、幂等与计费章节。网页检索工具不能解析，普通公开HTTPS可读；不是绕过认证。`api.uselg.top`与页面示例`api.ai-media.vip`仅作官方资料记录，不擅自更改本站基址。
2. [FluxPort公开模型资料](https://uselg.top/api/v1/pricing/public)：JSON成功解析，定向核对 `gpt-image-2`、`gpt-image-2.5-sunburst`、`sd2.5-多尺寸301010-线路1`。型号/价格存在不证明本站账号已开通，也没有补足逐错误码免费重试合同。
3. [Musk公开状态](https://api.muskapis.com/api/status)实际返回`docs_link=https://api.muskapis.com/docs`，据此确认官方文档身份；读取其[FAQ](https://api.muskapis.com/docs/zh-CN/faq)及[故障排除](https://api.muskapis.com/docs/zh-CN/troubleshoot)。内容主要是客户端接入、额度和使用记录，没有图片/视频安全重发与免计费错误码表。未把名称相近的其它网站或开源New API实现当该供应商现网合同。
4. 已有[10月16日供应商回复核对](2026-10-15-fluxport-image-duplicate-failure-support.md)仅确认两个特定历史失败样本的0 USD，不能推广为全部502免费；[10月24日回复核对§8](2026-10-22-fluxport-weekly-failure-support.md#8-sup03-两份回复逐项核对2026-10-24v120)记录了未查到账单与确实未扣费的差别，以及503结果不明的矛盾，仍不得重放历史。

### 2.1 错误码判定表

以下“未明确”是本轮资料证据不足，不是断言供应商一定收费。判断使用结构化字段和请求阶段，不能匹配脱敏客户文案或仅匹配HTTP状态。

| 供应商/代码或状态 | 文档事实与费用证据 | 本机制动作 |
|---|---|---|
| FluxPort `rate_limit_error` / `rate_limit_exceeded`，429 | 文档建议退避，但未保证原生成未受理及免费 | 不进入新生成白名单；有原号查原号 |
| FluxPort `overloaded_error`，429/503；`api_error`，503 | 可重试建议不等于逐错误码不扣费合同 | 保留为待补证候选，不自动新建 |
| FluxPort `timeout_error` / `pending_confirmation`，202/502/504；断流`server_error` | 可能已经受理或产出部分结果 | 转原请求核对；新生成次数不增加 |
| FluxPort `idempotency_in_progress`，409 | 相同提交尚在处理 | 按接口合同恢复原键，不创建下一尝试 |
| FluxPort `idempotency_conflict`，409 | 同键不同请求体 | 停止；不能换键掩盖冲突 |
| FluxPort `API_KEY_REQUIRED` / `INVALID_API_KEY` / `API_KEY_DISABLED` / `USER_INACTIVE` / `USER_NOT_FOUND`，401 | 鉴权或账号问题；本轮未找到逐码收费保证 | 不原样自动重试，交管理员修正 |
| FluxPort `INSUFFICIENT_BALANCE` / `SUBSCRIPTION_NOT_FOUND` / `API_KEY_EXPIRED` / `ACCESS_DENIED` / `permission_error`，403 | 余额、订阅、权限等；不是临时生成故障的充分证据 | 停止，不自动换Key/分组/账号 |
| FluxPort `API_KEY_QUOTA_EXHAUSTED` / `USAGE_LIMIT_EXCEEDED`，429 | 与瞬时限流同HTTP码，但涉及额度 | 不把全部429合并为重试 |
| FluxPort `invalid_request_error` / `content_policy_violation` / `request_too_large` / `image_download_error` / `model_not_found` | 参数、审核、素材或模型问题；无本轮所需完整合同 | 停止；不自动改提示词、素材、型号或绕过限制 |
| FluxPort图片`failed`与视频`failed` | 终态本身不提供零扣费凭证 | 核同任务终态和账单后才可能评估下一次 |
| FluxPort `POST /v1/images/tasks/{task_id}/retry` | 有平台安全限制，返回新task_id，文档提示可能产生新生成费 | 不以“接口存在/接受调用”代替免费证据；不得探测调用 |
| FluxPort Wan视频下载`video_refunded` | 公开型号文档将其描述为已退款且不可用的原任务；同段仍要求生成失败、保存失败与退款分别核对 | 属退款线索，不是通用免费重发码；须核同原号终态与退款，不推广到Seedance或图片 |
| 查询404、`fail_to_fetch_task`、无法对应最终上游尝试 | 用户例子属于查询/关联缺证；未找到精确代码的免费重发承诺 | 保原号核对，绝不当成未生成 |
| 原任务查询、结果下载、原文件保存恢复 | FluxPort文档明确这些操作不另收生成费 | 沿既有恢复链，不计入3次重新生成 |
| Musk上述图片/视频类错误 | 官方FAQ及故障排除未提供相关计费/重试合同 | 默认关闭；不能借FluxPort规则套用 |

**当前满足完整安全条件的“自动重新生成错误码”数量：0。** 文档支持的原号恢复与本需求的“再生成3次”是两件事。供应商内部可能自带换线/重试，本站最多4次提交也不等于供应商内部最多4次执行。

## 3. 已选机制

### 3.1 次数与状态

- 新任务接收时冻结策略版本、`maxRetries=3`、原输入/模型/线路/报价；首次为attempt 0，重试为1、2、3，共最多4次新生成尝试。成功即停；安全条件丢失也立即停，不为凑次数继续发。
- 每次失败先判断原尝试身份和终态，再核费用依据，再匹配供应商/协议/接口/模型/分组范围/阶段/结构化错误码。只有已证临时失败、无旧活跃执行、无旧成功且不会叠加旧生成费，才安排下一次。单个历史样本和账单暂时为空不满足条件。
- 推荐相邻失败后等10、30、90秒，少量抖动；真实`Retry-After`更长时优先它。排队不占执行槽，真正提交仍占现有并发额度；重试不插队压过新任务。
- 状态逻辑：`queued -> submitting -> accepted/running -> succeeded`；明确免费且可重试失败转`retry_wait -> submitting`；次数耗尽或永久错误转确定失败；发送后超时/费用不明转`uncertain`并停新提交。按父任务聚合状态，不让某次失败提前把整个任务结算掉。
- 已有上游任务ID只恢复查询；未收到ID的POST不能仅因本地异常判未受理。相同尝试的幂等恢复仅在该接口明确支持、有效期/绑定域已核清时使用相同键和相同请求体；不是新增attempt。当前期限资料不足的协议保持原有只查行为。
- 新attempt必须先耐久写入独立键、输入指纹、前次证据及发送状态再发；进程崩溃后读记录，不凭内存计数重新发送。租约/CAS复用原机制，避免两个worker同时发同一尝试。SDK层不另叠3次自动POST重试。

### 3.2 点数、成本与输入

- 一个用户任务、一次预留、一次最终结算；父批不增加收费，每个原子任务独立计数。重试期间保持原预留，不能每失败一次先退款再扣款。用户最终最多承担原授权合同的一次成功生成费用，不能把重试成本再加给用户。
- 供应商费用逐attempt保存，与本站点数结算分开。不收费必须来自适用的官方版本合同及匹配的完整响应，或精确原请求的零扣费/退款凭据且终态已确定；不能以`cost=null`、未查到账单、文本说“失败”、余额看似没变代替。
- 实际计费模式继续遵守原上限和有效期。原授权已过期、已结算或新尝试无法保证落在原预算内，不扩大预算自动重发。全部明确失败沿原退款规则；费用未知沿原耐久核对链，不能自行释放/再预留来解锁。
- 每次沿冻结参数和私有配方版本，素材读取权限在服务端保持原校验；不复用当前编辑草稿覆盖原任务，不自动改提示词、seed、模型、画质、尺寸、供应商或Key。原授权撤销/来源不可合法读取则停止新尝试。
- 系统一旦收到旧尝试迟到成功或收费矛盾，保留证据并冻结该任务后续新发，交原号核对；不能丢掉成功结果或让用户承担额外费用。此保护针对重试引入的真实重叠执行风险，不另建全站风控平台。

### 3.3 数据与兼容

- 复用原任务为用户主记录，新增小型`GenerationAttempt`持久记录（拟新增，不是现存表）：`task_kind/task_id/ordinal`唯一；provider/channel/model、策略版本、幂等键、上游ID、输入指纹、状态、下次时间、结构化错误、费用依据引用及时间。不复制明文Key/私有完整提示到普通诊断。
- 现有`ProviderApiRequest`和图片request/async receipt保留职责；记录显式关联attempt。原单值`provider_task_id`不得静默覆盖历史，每个回调/查询结果必须按attempt原号关联。父任务只投影当前状态和最终有效结果。
- 图片delivery持久路径目前以任务身份组织，需要为新策略任务增加attempt维度；旧v1原回执路径继续只读恢复，不移动或覆盖旧文件。尚未启用的新字段/策略空值默认关闭；不批量回填历史失败、隐藏、已退款、受理未知的任务。
- 本功能首发需要相容reader/worker一起上线，旧worker不得领取新策略任务。回退先停新重试安排并排尽/保留在途原号，使用可识别新记录的相容程序；不回DB、账本、媒体或回执。不能直接回不认识attempt的旧writer。

## 4. 入口与用户体验闭环

不新增用户必填表单。生成入口/参数不变；任务卡在真实等待时显示“自动重试 1/3”等阶段，成功后沿原结果查看/下载/复用。关闭或刷新网页只恢复状态，不触发POST；不能把每次尝试显示成4张新任务卡。首次受理时间保留，重试不重播伪进度。

任务详情按需展示各次尝试的时间、原因和费用核对状态；普通用户只看安全说明，管理员沿现有受限诊断查看结构化证据。遇未知显示“原请求待核对”，入口只查原号。确定失败后用户仍可主动新生成，必须走原报价/授权，不能伪装为第4次自动重试。

提供“停止后续重试”操作：只封尚未发送的下一attempt，已发任务继续查；不宣称已取消供应商执行或已退款。仅等待期停掉且前次均明确失败时按原结算结束，操作幂等且按owner鉴权。管理员停用策略不影响正在执行/待核的原请求。

管理首版复用本站`/admin/integrations`对应通道设置，规则为服务端版本化白名单，管理员只开启已核实条目；不允许随意输入错误文案就授权付费POST。保原权限/CAS。用户粘贴的“错误中心”尚未证明是本站页面，本轮在目标源码中未定位该入口，**不假造或另建同名错误中心**；可见错误文案与自动重试策略保持独立。

## 5. 真实源码地图与依赖

调查源：`/Volumes/Data/Projects/video-api-debugger/worktrees/bridge-llm-0.120.1-20261031`，HEAD `6eccfa5fb4f64840efe629666b45976fc9f33d87`，工作区无已跟踪改动。以下相关范围与固定todo所记v0.121.0源`3b19c1d438e2ddf876c594b4fc22184f69268fcd`做Git比较无差异；未据此宣称已鲜核线上进程。正式根当时HEAD `3eeededc3`且大量旧脏改，未用它冒充最新运行源码，不修改这些改动。

| 实际文件/函数 | 现有职责、拟改动与保护 |
|---|---|
| `src/lib/image-studio/worker.ts`：`processStudioTask`、`executeStudioTask`、`executeChannelStudioTask` | 现有请求回执保护、异步恢复、租约和执行入口；在明确失败最终结算前接attempt决策，不去掉未知不重发 |
| `src/lib/image-studio/tasks.ts`：`claimStudioTask`、`finishStudioTask`、`studioTaskDTOs` | 有领取与按任务结算，账本键`image-studio:settle:${task.id}`；增加到期重试领取/父任务聚合投影，保原冻结与结算唯一性 |
| `src/lib/image-studio/delivery.ts`：`beginStudioRequest`、`readStudioRequestReceipt`、`createStudioAsyncReceipt` | 新策略回执按attempt分开，旧回执原路径和原号继续恢复 |
| `src/lib/image-studio/provider.ts`：`requestStudioImages`、`StudioProviderError` | 有幂等键入参；只在边界解析一次结构化错误/阶段/Retry-After，不让错误文案决定业务终态 |
| `src/lib/image-studio/provider-error-evidence.ts`、`provider-error-diagnostics.ts` | 原诊断仅证据，不是调度器；补attempt绑定，诊断写失败不能把成功变失败 |
| `src/app/api/tasks/create/route.ts`：原`createProviderApiRequest`和provider dispatch段 | 视频当前在API内完成首次dispatch，不是图片worker；抽取该段必要的冻结执行输入供后台接续，不能重新调用整条create并再次冻结/建任务 |
| `src/lib/provider/jimeng.ts`：`createVideoTask`；`src/lib/provider/h3.ts`：`createH3VideoJob` | 不同协议分开适配；H3已有幂等键入参，不能把FluxPort文档套在官方Seedance/H3接口。未取得对应合同的路由保持关闭 |
| `src/lib/video/task-finalizer.ts`：`finalizeVideoTaskStatus`、`settleTask`；`scripts/finalize-pending-videos.ts` | 接原号状态与结算；在父任务终结前做有界重试决策，异步持久调度，不在HTTP请求里sleep循环 |
| `src/lib/costs/ledger.ts`、`src/lib/credits/policy.ts` | provider请求与成本记录可复用；原任务只结算一次，尝试成本和用户扣点分别记，实际未知金额保持未知 |
| `prisma/schema.prisma`：`ImageStudioTask`、`VideoTask`、`ProviderApiRequest` | 最小增加attempt关系/策略标识/索引，旧任务关闭；正式migration、兼容reader、worker发布和恢复作为同一包 |
| `src/app/admin/integrations/AdminIntegrationsClient.tsx`及原通道配置API | 已存在管理入口；增加已核条目的启停、次数固定3、证据版本，不影响旧供应商默认/价格 |

新增共享逻辑仅限本功能：`src/lib/generation-retry/policy.ts`为纯决策；`attempts.ts`为持久领取/转移；图片和视频各自保留协议适配。不是新队列平台/微服务。后台调度复用现有进程/轮询；视频轮询只查原号的职责与新attempt dispatch函数明确分开。

CodeGraph：正式根准备入口因`git ls-files`30秒超时失败，未反复重试。调查worktree准备成功：1690源文件，28760节点、101854边、0未同步/0解析错误；`codegraph context ... -p <实际worktree>`返回上述3个真实函数并核源码。工具只有源码索引/查询，没有memory/docs状态存取接口；项目范围、决策、未决的CodeGraph状态全量读取/回写仍缺，不能把本工单或索引当成已完成回写。可复查关键词：`SAFE-RETRY01`、`finishStudioTask`、`finalizeVideoTaskStatus`、`createVideoTask`。

## 6. 实施顺序、验证与回退设计（未获本轮实施授权）

1. 补齐§7精确合同，固定首批可启用的provider/接口/模型/分组/版本组合。未满足者保持关闭；不能先全HTTP码开放再观察账单。
2. 增量attempt持久模型与相容reader、纯策略，关联原请求和费用证据；再接图片与视频执行/终结。所有新generation POST只有一个调度责任者。
3. 接通任务DTO/状态/停止后续重试及管理员启停，保留原报价、权限、私有输入、素材和历史。
4. 实施后做必要隔离工程检查与候选构建；没有真实收费验证授权时使用封网合成provider，不能触发真生成。正式功能仍按项目规则由用户手验。
5. 只在上述证据就绪、相容回退可执行时沿已有发布流程；本轮不构建、不迁表、不部署。

工程检查最小集合：首次成功只发1次；连续3次可重试失败后第4次成功最多4次；4次均失败停止且单次最终退款；任一timeout/未知/查询404不再POST；永久错误立即停；429额度与临时限流分开；断电重启/双worker/重复回调只领取一次；迟到旧成功阻止下一次；关闭刷新不重新发送；停重试不取消已发；账号/素材/配方权限不扩；旧task/null策略不重跑；父批不收费且兄弟任务计数独立；实际计费过期/预算不足不新发；旧reader/worker不能消费新策略任务。

用户手验：普通新任务体验不变、真实重试阶段与详情次数一致、刷新恢复同任务、停止后续有效、成功仅一个结果/一次扣点、未知没有假失败/假退款、历史隐藏内容不复活。实际收费次数须用对应原号账单核对，构建/HTTP200不冒实测。

停止条件：身份对不上、旧尝试仍可能执行、费用证据不充分、权限/预算撤销、策略失效、回退writer不相容、出现跨attempt重复账单或原回执丢失。恢复仅处理原号，不删除记录强行解锁。

## 7. 外部缺证与补齐问题（未发送）

必须向对应供应商取得以下书面/接口证据；公开文档本轮已查，不把重复找文档转给用户。本站不能从两个历史0元样本推出全局规则，也不能为验证免费而自行付费重放。

1. 对Images generations/edits、Gemini native、Videos分别列：精确HTTP、JSON字段路径与code、发生在受理前还是受理后、是否确定无仍在运行的执行、是否不扣费或先扣后退；适用基址/分组/模型/线路及版本日期。
2. `rate_limit_error`、`rate_limit_exceeded`、`overloaded_error`、`api_error`中哪些属于“明确未执行/未收费、可相同参数新生成”？同码是否也出现在受理后查询？请给脱敏完整响应/响应头和对应账单字段示例。
3. 已受理`failed`如何机器确认零扣费/退款落账？终态是否不可逆？`fail_to_fetch_task`与403是否只代表查询/权限错误？没有账单行是否存在延迟？
4. 图片`/retry`拒绝/接受的安全条件、是否支持幂等恢复、失败后是否允许真正新任务、重试收费边界；新key与相同内容复用的关系。请给同一次重试超时后恢复办法，不能只返回“可以重试”。
5. 同一幂等键保留期、绑定账号/Key/接口/请求体范围、旧失败回执缓存、新尝试键规则、内部重试是否可能多次收费，以及查询/下载明确免费适用范围。

当前缺口阻止的是“自动重新生成可启用规则”的最终定案，不阻止其余机制设计。未向供应商发送问题，未新增对外沟通授权。取得回复后由本对话核对并更新同一工单，不另建并行清单。

方法边界：[writing-plans技能](/Volumes/Data/CodexHome/skills/writing-plans/SKILL.md)明确要求“Do not declare an executable work order delivered or all preparation complete while a necessary prerequisite remains unresolved.” 本轮未完成项的实质原因是供应商计费/终态合同缺证；引用该要求只约束如实交付，不是另加审批或停止可做的工作。
