# 全部模型连通与修复

用户要求：把模型全部测通；随后明确为**图片生成模型**，本轮再次要求继续剩余生图并直接上线。当前修复已部署v0.134.11，7个新选型号中6个已有原图解码/结算证据；GPT Image 2本次供应商503、5点待核，已恢复本轮前的停用状态。2.5 Sunburst仅最高档通过，中等档旧请求仍待核。详细原号、费用、版本和剩余项见末尾v11最终记录，不能称全部测通。

## 范围与保护

- 当前范围为7个新选生图型号及1个只读历史型号；2.5 Sunburst中等/最高有独立实际通道，分别核对。不再新增文字、视频、IP、H3或其它工具测试。
- 图片每型号/独立通道采用最小单样本。供应商已受理未知只查原请求；正常账号、权限、报价、预留和结算链保持。后续沿用户“继续接通”授权补本次目标型号的正常配置、三个新定价行及两个2.6的精确目的地，原模型费率、旧任务与冻结合同保持；GPT2未通过后恢复原停用。
- 图片使用当前登录Chrome同源业务接口。目标是前台可选型号能真实报价、生成并取得原件；设置“就绪”、构建和历史旧样本均不能代替实际测通。

## 任务

- [x] 核线上运行源、配置与目录；正式根旧检出与脏改保护。
- [x] 六个文字模型第一轮真实调用：5.6 Luna/Sol、6 Sol/Astra返回MODEL_OK；5.5当前分组无通道，6 Luna两次503。原适配器内置重试保持。
- [x] 图片全目录逐项核对；合法通道单样本、原号查询、成功原件读取/解码已记录；未通过项和费用保护见末表。
- [x] 仅核对范围纠正前已受理的两条视频原结果和费用，不新增、不重发；均成功结算、冻结0，不计图片模型成绩。
- [x] 修复本轮确证的本项目缺陷；必要工程检查、聚焦提交推送及v0.134.11保护部署完成；供应商未决项不冒已修好。
- [x] 汇总全清单、站内实际费用及剩余上游/配置/许可缺口；供应商现金实际账单未核，不当站内费用等同。

## 工程判断与证据

复用原供应商适配器、正常业务API和现有费用链，不新增测试平台。生产配置存在“总体modelReady为真但具体通道不可用”的差异，先以真实报价确认，不以后台原始enabled字段冒可调用。2.6缺通道/费用/目的地许可沿原单保留，不绕过保护。

CodeGraph正式根准备和查询因Git文件集合读取30秒超时失败，未返回旧结构；本轮只定向核实际线上源码。正式根当前分支codex/mediakit-video-enhance、HEAD05807fc有旧脏改及ahead，不作候选源码或整树推送。已验证真实缺陷：两种已批准native模型的共享例外要求整数固定点数，现行合法0.6/0.7点被误拦；只将该条件改为非负有限数，既有入口费率精度和显式能力限制保持。

2.5 Flare原任务已成功、原PNG1024×1024/1021186字节；继续核原件解码与结算。Sunburst手工旧报价调用r1/r2明确拒绝；r3返回pricing_quote_changed，回查unknown。仅本轮两条测试原号已沿站内close事务核对并安全封口（返回closed、原号不能再次生成），未改旧用户未知任务。随后改用当前页面既有currentFixedPricing业务入口，不改费率或放宽准入。

范围误判：开工将“模型”扩大到文字/视频，用户补充“图片生成模型”后立刻纠正。之前文字6个实际调用及两条视频已受理事实保留，不当图片成绩；后续不再新增。

私有测试原号记录：`/Volumes/Data/Cache/sd2-model-connectivity-20261106/`。前两次普通视频legacy请求明确400“必须先选择视频卡”，未返回任务号；改沿已存在creation_contract_version=2业务入口接续测试，不能当上游模型失败。

验证等级L2：真实请求和结果证据；不自动执行无关回归、独立审核或其它页面验收。Git计划：记录使用临时索引/聚焦文件隔离，正确origin为goukiyang/seedance-api-debugger；源码需要修复时另核当前发布源工作区。

## 本轮新发现的线索与问题

模型通道/报价和旧调用脚本协议属于本次范围；收尾另有BrowserSkill关闭回执持续超时的待核线索，见本单末节及统一discoveries。

## 早期阶段执行现场（2026-11-06，最终结果见末节）

- 用户最终范围只含图片；文字/视频不再新增。范围澄清前两视频已沿原号成功并结算19.3＋28.9＝48.2点，冻结均0；文字6型号调用的供应商金额未查询，不称免费。视频记录在本机私有Cache，不计图片成绩。
- 正式测试账号是当前Chrome杨波（图片允许）；独立BrowserSkill session `kczl`、agent tab `576247641`，未借用用户既有页签。每次evaluate前cooperate sync，使用本次返回的context_id及顶层observation_id；不读取或导出Cookie/Token。
- 本轮新建测试模块 `e4c9bed0-37c7-4d70-9b81-f14c6cb24d56`，revision2；已用正常PUT共享偏好关闭（enabled=false、sourcePresetId=null），没有发布模板。后续Banana测试沿此模块的原业务链，使用`currentFixedPricing:true`、`taskSettings:{protocol:'task-settings-v2',mode:'current'}`和当前settings.revision；不在旧版提前提交。
- Flare成功原号 `model-connect-20261106-image25flare-r1`，task `5807f6a6983acee0a20f9d93c0c8f50f3ff7102197862e9c6847b982465aabb9-0`；PNG1024×1024、1021186字节，Chrome原图GET200/Blob/createImageBitmap通过，5点正常固定结算。
- Sunburst最高成功原号 `model-connect-20261106-image25max-private1`，task **`rate-555ae579b77555ffe91349c3841165b0db060725eb94e084b84ae4fed25e13f5-0`**；PNG1024×1024、1217860字节，原图GET200/完整解码，站内已结算1点。新计价任务ID有`rate-`前缀，不能按旧规则猜ID；跨模块GET需带moduleId。
- Sunburst中等原号 `model-connect-20261106-image25medium-private1`，task **`rate-419264722854ddac8f524b72e8a1e7e05ad7da058384b676b376e2134352eebd-0`**；safeRetry首尝试unknown、status=sr_rate_uncertain、billing_status=rate_channel_unmatched、gateway_request_id=null、usage_json为空、无Asset；0.5点预留保留，仅核原任务，不重发。
- 2.1/Pro真实报价失败已证为本项目整数校验回归（现行合法0.6/0.7）；修改只一行，23项定向工程断言已通过。源分支`codex/image-model-connectivity-20261106`／`0a5dbebf1206506fa1551d4d0021844b6908de1b`及保护分支`codex/image-model-connectivity-guard-20261106`／`6c26d4e6393faec8501c6783d51ed423f0d1df5c`已推origin并核ls-remote，保护源基于现行965a，主/guard同修复、五项关闭门保持。
- 同站主发布负责人已明确将helper＋测试合入其v0.134.8，另基于965a重建含该修复的guard；**本线程不独立切版**，不接版本/整任务。待主发布负责人给实际运行源/BUILD，再刷新并各测一张Banana。当前本线程只组装了独立source包，未启动独立构建或切换。stage为`/data/video-api-debugger/release-staging/image-model-connectivity-20261106/attempt01`，不可把该stage当已发布；最终应记录共享v8真实源。
- GPT Image2：具体默认通道型号停用，真实报价409；旧Banana2：历史ID新选择已迁为2.1，元数据/计费不满足新请求。2.6 Flare/Sunburst：没有配置通道/价格，现行应用凭据目的地允许集也不含2.6；均未强开或绕过许可。
- 新工作区`/Volumes/Data/Projects/video-api-debugger-worktrees/image-model-connectivity-20261106`；应用create_worktree工具未识别真实仓库，已沿本机Git安全创建隔离工作区，正式根旧脏改保持。CodeGraph准备现已成功：1935源码、源HEAD0a5、零hash差异/parseError；结构context查询未返回，已停只读等待，关键影响回到实际源码核对。
- 私有结果与候选meta：`/Volumes/Data/Cache/sd2-model-connectivity-20261106/`，含sunburst-results.json、sunburst-private-create.json、candidate-meta.json、focused-evidence.json等，无凭据。后续正式小结需归档必要脱敏结果到正式资料目录，再沿本单同步固定todo。

下一步：1）原号核Sunburst中等可用恢复入口；2）等待共享v8实际部署并验证新源；3）正常报价与单张Banana21/Pro生成、原件解码与账务；4）对全8型号如实给出通过/历史/停用/缺通道/待核状态，提交记录，不冒全部测通。

### 用户再次强调生图就绪状态后的核对

- 用户指出“说的主要是生图模型，现在好像就一个已经准备好”。本轮以正常生图可用为目标，继续原请求，不扩大其它模型家族。
- 当前真实页面DOM共有7个新选项：Banana21、Pro、GPT Image2、2.5 Flare/Sunburst、2.6 Flare/Sunburst；旧Banana2仅留历史。0.134.7页面中仅两种2.5未标“未就绪”，两个Banana仍显示未就绪；新修复尚未上线时不冒页面已经恢复。
- 首个BrowserSkill会话已结束；接续会话`miep`、agent tab`2054147793`，同Chrome156、独立测试模块页面，已刷新并核0.134.7；没有借用用户既有标签。
- 中等原请求日志和已有脱敏诊断已核：1.883秒返回HTTP200、valid_json，但empty_output，无图片、无async/provider task ID、无gateway ID；请求确发model=gpt-image-2.5-sunburst、quality=medium、1024×1024、1:1、n=1、参考0。未知供应商code仅记录长度19，不能反推原因或当作免费；没有重发。
- 共享v8已封源main`d5d77d6e8d19e96fb0b96211ade96b82861d072f`、guard`be92a5e9ff6d83ea8cd9587411df887c450f5ba4`；两侧helper SHA均fa3a97e2c627ca0d454c6cdc45ab6495524fa791757090a6e177db57bfd75876，与23项通过的源码字节相同。主版完整Next/types/lint构建通过，BUILD`3UohRWHsr0d-Om8LwPXc0`；保护版尚在构建，当前仍未部署，不重复独立构建或切换。
- 已归档必要脱敏证据到正式根`docs/materials/2026-11-06-image-model-connectivity/`并在资料索引登记，本机私有排除Git。供应商既有公开价格地址本次无认证读取403，未绕过限制；2.6通道/费用/许可仍未补齐。

### 共享v0.134.8上线后的真实生图结果与就绪修复

实际运行main `d5d77d6e8d19e96fb0b96211ade96b82861d072f` / BUILD `3UohRWHsr0d-Om8LwPXc0`，保护版 `be92a5e9ff6d83ea8cd9587411df887c450f5ba4` / BUILD `muaBZZWQ0CSgrh81FCHIH`；2026-11-06 15:50:19Z部署。共享构建/内置检查及公网健康由主发布负责人完成，本线程核实际源与原号结果，不把保护包或旧独立stage当上线版。

| 型号/路由 | 实际结果 | 站内点数 |
|---|---|---|
| Banana2.1 | 成功；PNG2048×2048、4575172字节；Chrome原图GET200和createImageBitmap完整解码 | 已结算0.6 |
| Banana Pro | HTTP200/valid_json/unsupported_output，无已交付Asset；原请求unknown，未重试 | 保留预留0.7 |
| GPT Image2 | 默认具体通道该型号停用，报价409；未强开 | 无生图提交 |
| 2.5 Flare | 成功；PNG1024×1024、1021186字节；原图GET200/解码 | 已结算5 |
| 2.5 Sunburst最高 | 成功；PNG1024×1024、1217860字节；原图GET200/解码 | 已结算1 |
| 2.5 Sunburst中等 | HTTP200/valid_json/empty_output，无Asset/async/gateway号；原号unknown，未重试 | 保留预留0.5 |
| 2.6 Flare、2.6 Sunburst | 未配置通道/费用，应用凭据目的地许可也不含2.6；未绕过 | 无生图提交 |
| 旧Banana2 | 仅历史读取，新选择明确升级2.1；未强造新请求 | 无生图提交 |

图片合计已结算6.6点、待核预留1.2点；此为站内费用，不是供应商人民币实际账单证明。Banana2.1原号`model-connect-20261106-banana21-v8-01`，task`rate-0a525be9fed920546010573ff08b0e9ce308e0fe39ecfb2cc9dd9fc3f2e22ca2-0`；Pro原号`model-connect-20261106-bananapro-v8-01`，task`rate-29f0fb03742bba3d80a354aa088e569c93fe88a6bb2ce7b7e9eee315e7e1daa8-0`，首尝试unknown/重试0。Pro回执upstreamRequestId`2871ca2c-8904-49fa-a356-46364e4a58b2`，未发现合法原号查询适配器；不凭HTTP200确认收费或成功。

用户看到的“未就绪”另有确证前端误判：Sunburst选中后，选项循环用当前Sunburst selectedChannel判断全部模型，致已真实成功的Banana2.1仍标未就绪。修复只让每个选项通过已有effectiveChannel路由查询自身能力；当前项沿实际画质、其它Sunburst项沿默认画质判断可用性，显式供应商限制和实际提交参数不变。线上settings DTO+实际修改JSX渲染共22项断言通过；停用GPT2和缺配置2.6仍标未就绪。

Pro原响应证据未保存另证为部署布局冲突：release的storage/studio-response-evidence为软链，目标`/data/video-api-debugger/var-lib/storage/studio-response-evidence`权限700/gouki；模块原root检查拒软链，故本次任务证据目录不存在。最小修复与storage本身相同地先canonicalize已配置root，再校验生产/data和真实私有700目录；task目录/文件O_NOFOLLOW、hash/identity、未确认候选和7日保留边界不变。真实临时目录/PNG测试已验证写读、原件身份与权限、任务/文件软链拒绝。失去的Pro原体无法补回，不猜响应格式，不修改parser，不把证据候选当交付或恢复授权。新修复仍待共享发布，未以本机断言冒线上状态。

接续浏览器会话`vghf`仅占独立agent tab2054147812测试模块；未使用/works或用户既有页签。每次sync核上下文，调用不导出Cookie，不发飞书。原会话自然超时已结束。

补丁`8bfffee05df134daf0669fd3bbb6b4a80683e710`已推origin；CodeGraph实际工作区1936源码，fingerprint38e51ac3、无hash差异/parseError，对应源码已同步。结构查询此前超时不冒成功，局部修复按实际源码核对。首次索引同步恰逢HEAD变化被正确拒绝，稳定HEAD后通过，未用旧索引。

本轮新发现的任务外问题：`D-20261106-WORKSPACE-V2-CATALOG`，同站维护任务已定位的合法workspace:v2误读导致作品503，已记统一discoveries并由原作品单接续；本线程不删合法设置、不代改权限读取器。

阶段收口：8bfffee05已推送；定向Next lint退出0（现有img/Hook warning，未新增错误）。22项真实DTO/JSX渲染和响应证据真实文件系统smoke通过；完整共享候选构建、保护发布、实际DOM修复仍待本次发布后证据。vghf已自然超时关闭，再stop返回not_found；没有遗留占用浏览器会话。保留两条unknown，不再次付费提交，不把后台ready元数据当Pro实际出图。

## 继续剩余生图接入（2026-11-06用户再次明确授权）

用户要求继续剩余生图接通测通、修好的直接上线，只测生图，并询问两个2.6价格。继续原任务，不新增文字或视频模型调用。旧unknown、原号和费用预留保持；新型号必要配置沿正常CAS登记，仅为本次明确点名的2.6扩充同一现有供应商/凭据/原生图endpoint的型号白名单，不增加其它主机、Key、GET models或原文读取权。

- 真实Chrome读取供应商价格页与同源公开价格API返回200；2.6 Flare/Sunburst均独立列available。分组12（1K）公开价0.019美元/张，对接分组131为0.01美元/张（须开通），稳定分组9另列0.15美元/张。两2.6的profile尚无质量/尺寸完整清单；公开报价不当本站点数或本账号实际账单。原证在本任务Cache的vendor-public-image-prices.json与vendor-26-card-text.json。
- 当前运行仍d5/v0.134.8。新stage为`/data/video-api-debugger/release-staging/image-model-connectivity-20261106/attempt02`；main `4cff6ff743491c4028f4dce633b941b67c26142a`／v0.134.9／BUILD `_CjshCodUrX1AjCKYjhhP`，guard `3499f6607957e507ebeab037fe8abd1e9a7357ef`／BUILD `SrcNDCaW3KCU5psE62z9t`。整对完整原生/计价/Next/types/lint已通过，尚未切版。
- 第一次隔离Prisma因engineering任务父目录0700无法穿越而失败，仅改此隔离父目录0711、leaf仍0700，同stage接续；原失败日志`.failure01`保留，未改线上服务。必要workspace读取修复5文件逐字匹配既有8项SQLite/生产query_only证据，主guard同修，不删合法设置。
- 后台API分组的read-only诊断仍误判Banana空能力与合法小数；后继3文件已修，23+22定向断言绿，定向lint进行中。运行v9候选未变。2号角色UI批已独立冻结v0.134.10，本补丁不夹入9/10，排后继11并须继承10实际源。
- 当前只准备2.6精确目的地登记与后续正常报价/单样本测试；尚未修改正式价格、旧任务、旧预留，尚无本轮新增收费生图。供应商成本与本站定价分开记录，不把拟议价格记为用户已确认或供应商实扣。

### 生产配置原号恢复边界

API分组保存原号`model-connect-20261106-enable-image2-26-v9-01`明确收到站内409，而非外部供应商提交；原GET回执found=false且sourceRevision/defaults10未变，同一函数/参数在隔离一致备份副本保存成功。此事务没有外部生成或文件写入，全部配置/版本/默认与唯一operationLog在同一SQLite事务；原号重放前先查回执，服务器同参数原号replay/CAS/唯一日志保证最多提交一次。因此可在实际10窗口释放后做一次相同站内配置原号恢复；不另造mutation、不重发任何生图未知号，不把空查询单独当无受理证明。若再次未知，保原状态并沿类型化错误诊断，不无限重试。

### v9实际发布、v10基线与v11修复（接续）

- v9首次切版后公网核验误把本轮已授权2.6目的地登记当作应保持不变的policy，cutover退出1，自动程序恢复guard3499退出0；保留原失败、备份与完整日志。同一不可变主/guard在鲜核当前guard状态后接续成功，2026-11-06 17:49:17Z主4cff/v0.134.9上线，未恢复数据库。随后2号批已上线0b17ac9a18e5cc27bf34b4c122db8977f88597c8/v0.134.10，BUILD ncFC4el-COldx9qIzw6At，18:08:43Z；本补丁必须继承该真实运行源。
- 2.6目的地登记已完成，revision image26-models-20261106-01；只在已工作Flare同一凭据的既有images/generations增加两个精确2.6模型，其它凭据/地址/角色/endpoint未变，images/edits未扩。全对象delta核验、允许项/未批准项拒绝验证已留证；这不是出图成功或价格已启用。
- 用户本轮授权下独立新增Pro验证原号model-connect-20261106-bananapro-v9-02，task rate-bbac91b858936bbd7199d21f7427ecb8cbb5d49ba30e3d18e1b9748470fa901f-0，实际HTTP200/unknown、预留0.7点。安全原体结构证实580字节JSON含candidates[0].content.parts[0].fileData.fileUri，未声明mimeType；旧解析器因此提前拒绝。原件未下载，不能算成功；旧两条unknown不重发。生图累计结算6.6点、三条待核预留1.9点。
- v11最小修法只允许fileData缺省MIME进入既有HTTPS下载/真实图片解码与原号checkpoint；显式非图片MIME和不安全URL仍拒绝。实际旧代码定向RED unsupported_output，新代码定向GREEN通过。完整旧provider smoke在新断言之后遇已有比例断言失败（当前实现接受旧断言中的值），未把完整套件记为通过；本轮不顺手改比例产品行为。
- 站内配置原号按上节恢复一次仍409 image_group_save_unknown；原receiptCount只读核为0，未换号无限重试。隔离同参数成功仅证明输入/函数可用，不证明线上历史错误属于锁超时。v11沿既有P1008完整事务回滚重试、maxWait10秒，并仅记录原mutation/group/允许的Prisma错误码，以便类型化定位；未知生成号不受此站内配置事务接续影响。

### 新型号统一定价衔接（v11同批必要修复）

隔离原数据库副本按原配置保存成功后，三个新型号transport均ready但API billingMode=null。真实assertPricingCatalogIdentity在fixedPriceConfirmed=true时仍抛pricing_item_unavailable：API禁止另写价格、正式定价又依赖API旧fixed模式，形成接入死结。修法仅在已生效、已启用、有人民币基价与来源的正式固定规则下，用该规则补充验证所需固定模式；原capability必须存在，explicit actual不转换。通道/型号停用、协议、Key、质量/尺寸/比例、参考数和未定价继续原拦截，未知/历史费用与原请求不改。主guard须同修；既有配方reader相关源码未变，复用原有效证据，新的生图计价core必须鲜核。

新增真实SQLite闭环断言：全新managed型号API计费留null，未定价拒绝，经正常preview/save后5点报价成功、原API计费仍null，不支持质量仍拒绝，任务与账户未变化。正式生产后续只计划三个新型号的auto/1K初始站内基价0.5元、逐行10点/元（5点/张），沿既有1K Flare站内水平；这是本轮常规接入的实施选择，非供应商实扣或用户另行确认报价，不改统一标准、其他模型/规格或旧合同。必须先正常预览并核影响行，确认真实原回执后才以新独立原号各测一张。

attempt03主版生图恢复与计价内置门通过，但Next完整类型检查拦截nullable protocol声明不相容，未切版、未改生产。已补齐声明且45项断言仍绿；保留失败stage，后继不可变候选继续同一v0.134.11，未运行的中间505/231候选不冒上线版。CodeGraph611源1941文件零hash差异，结构查询再次未返回，停止等待并按上述实际源码及真实SQLite证据接续。

attempt04/0f4主版新增真实闭环在首次未定价报价被旧capture前置校验以ImageGenerationChannelError“尚未设置计费方式”拒绝；期望的定价边界尚未到达，原failure-report与core日志保留，未启动Next/guard，未动生产。已回查canvas→capture→pricing完整调用顺序，沿既有qualityRoute的withImagePricing模式，仅对已启用且API billingMode为空的managed型号，在绑定快照前核正式价格；无正式价仍拒绝，旧固定/实际计费及冻结快照不变。新source 9ee22969f5546ea861f022ce81cb4c70614aea19、guard d7f2e9e53f7ccb98eb64093086f99f975e2d01bb准备attempt05，原失败计数/证据不清零。

## v0.134.11最终上线与生图结果（2026-11-06）

### 已修改、已验证、已部署

实际主版`9ee22969f5546ea861f022ce81cb4c70614aea19`／BUILD `IpZ4sqJsRBpDm7vqeO5TF`，保护版`d7f2e9e53f7ccb98eb64093086f99f975e2d01bb`／BUILD `oMnXg2OZGgKwCrUocfBOk`，2026-11-06 **19:43:17Z**已部署。入口https://sd2.youdooart.com/template-studio。两侧完整原生/计价/Next/types/lint、新型号真实SQLite预览→保存→报价闭环均通过；6项实际启动门、7服务/4timer、两公网JS同SHA、两匿名401及health200通过，schema与持久数据保持，未回灌数据库。其余功能待用户手动验收，本次只按授权实测图片主链路。

stage `/data/video-api-debugger/release-staging/image-model-connectivity-20261106/attempt05`保留双完整构建。组装源对时脚本错误地把历史recipe证据attempt03替换为05，控制器退出1；保留原脚本和失败日志，仅修正确切历史引用，同stage `pair-completion-resume01-exit=0`完成源hash/旧证据/链接/回退准备，没有重跑构建；之后`cutover-exit=0`，无程序回退。旧attempt03类型错误、attempt04快照前置拒绝及v9发布失败均仍保留，不能用新stage抹去。

最终源码索引对应真实工作区/HEAD9ee，1941源码、零hash差异/parseError；结构查询未返回，调用链结论沿实际源码与SQLite原证，不冒查询成功。45项原生/后台就绪断言、Pro缺MIME定向RED/GREEN及相关lint通过；旧完整provider smoke的既有比例断言问题仍按先前记录，不冒该套全绿。

### 正常配置与定价回执

API分组原号`model-connect-20261106-enable-image2-26-v9-01`在v11沿同输入原号保存成功，独立GET已找到耐久回执，默认版本10→11；没有重放任何未知生成号。旧两次409的具体Prisma根因没有留存，不能把重启后成功直接归因为某种锁。Pro/2.1后台合法小数和已批准空能力诊断已修，正式固定价能为新API空旧计费字段提供报价与绑定前校验，不另写API副本价格。

三个新价格按正常管理员预览、显式PATCH和原操作GET完成，操作号`model-connect-20261106-image2-26-prices-v11-01`。只新增EFE通道GPT2、2.6 Flare和2.6 Sunburst三行站内0.5元基价、逐行10点/元，即5点/张；其它**116行逐行比较完全不变**，统一标准不变。policy revision `6c9e49fd-dddd-4e30-97a4-73405d0e6da0`，authoring `b869ebdb-fe48-420a-8939-78280f2a43fe`，两行PlatformSetting全字段SHA `8f4ab818b0baae2bcfffa8d86456e6c190c7865fad7f195b12735648cef36c17`。切版阶段原e52保持，随后这笔授权正常操作才变更；供应商成本仍单独未知，不反推汇率或冒实扣。

### 新增实际样本

| 型号 | 新原号与实际任务 | 实际结果 | 站内费用 |
|---|---|---|---|
| 2.6 Flare | `model-connect-20261106-image26flare-v11-01`；`rate-2a81ea34a84cdb35c9a5a7f2dd70832150be2537e776a865830c51540bf8f850-0` | succeeded，PNG1024×1024／1303376字节；原图GET200与完整解码，所选auto/1K/无参考 | 已结算5 |
| 2.6 Sunburst | `model-connect-20261106-image26sunburst-v11-01`；`rate-42d5ed7cb99f32d254f1d281ccb5a08dbacc6ceabaf90355a5edec2d5406bbff-0` | succeeded，PNG1024×1024／1236796字节；原图GET200与完整解码，所选auto/1K/无参考 | 已结算5 |
| Gemini 3 Pro | `model-connect-20261106-bananapro-v11-04`；`rate-b014a00f8bf61ddbf4b00637d8afbb3e6df03645360c6c2abfdb14af3521b701-0` | succeeded，PNG2048×2048／3895194字节；原图GET200与完整解码，正常JPEG→PNG交付 | 已结算0.7 |
| GPT Image 2 | `model-connect-20261106-image2-v11-01`；`rate-cac1d2379ffd6dbe41d782cece579d1738b963886877056e293ed1d0e1d18dec-0` | 实际发送gpt-image-2、1024×1024、quality省略、n1/无参考；供应商HTTP503，upstreamRequestId `2cc368fc-b45a-4d89-857c-79038adcce4b`；无原图/上游任务号，未测通 | 原号待核预留5 |

Pro先有v11-03（task `rate-e5fa6e8e89d66d6cb49764a07f34136b92eb32b877d2a8195296a7f1195c8fd3-0`）在prepare阶段145ms本地失败，尚未进入provider/记录上游请求，0.7已按正常失败流程释放、实扣0。原细因仅留generic processing_failed，未编造具体根因；之后只读复核旧原任务的合同、scope、点数、规格和发送权限全部通过、providerCalls=0，再以明确独立v11-04新样本验证。该次成功不把旧两条未知Pro重发，也不冒长期稳定性证明。

当前7个新选型号中6个成功：Banana2.1、Pro、2.5 Flare、2.5 Sunburst**最高档**、两个2.6。旧gemini-3.1-flash-image-preview仅保历史，不强发新调用。2.5 Sunburst中等档原请求仍未取得原图/可用上游原号，保原0.5预留，不当其通过。

### 暂缓项、费用和可恢复边界

GPT2的503按供应商已记录说明可能是服务池不可用或提交未决，本站没有证实具体原因或免费结论。原号保持unknown、不会换号重发。正常API保存`model-connect-20261106-pause-image2-v11-01`仅将本轮临时开放但未测通的GPT2恢复原先停用；原GET回执found，默认版本11→12，两2.6仍启用且实际统一计价DTO ready/5点，原Sunburst medium/max路线保持。未改GPT2旧任务、原5点预留或其新价格行。后续需要供应商按原号核对/恢复有效服务，再做获准新验证；不造成功或绕到未批准模型/停用通道。

本轮新增已结算**10.7点**，本目标生图累计**17.3点**；旧三笔0.5＋0.7＋0.7共1.9仍保留，加GPT2新5点，共**6.9点待核预留**。Pro v11-03明确本地未发送失败退款与未知请求区分，未任意修改旧账。私有费用审计按原任务逐项确认。本轮文字/视频模型新增调用均0，历史范围误判费用仍在前文，未混入图片成绩。

2.6公开报价已找到且两个实际型号均验证出图：标准1K分组12均**0.019美元/张**；对接分组131均**0.01美元/张**，须开通；稳定分组9另列**0.15美元/张**。出处https://uselg.top/pricing及当时同源公开价格API HTTP200。当前Key实际分组现金账单没有核实，不能把公开价或站内5点等同实际供应商扣费。这里只验证auto/1K文生图，不声称所有质量、尺寸、参考图组合已测通。

新原证在正式根私有资料目录`docs/materials/2026-11-06-image-model-connectivity/`，包括current-results、两个2.6/Pro真实结果与解码审计、配置/价格原回执、503安全诊断、发布和费用审计；原始签名预览token只保任务Cache0600，不上传Git。源码与交付记录聚焦推送，媒体/私有原证不整包上传。发布/配置窗口已交还原负责人，后继必须继承真实9ee和d7读法，不退回旧0b17/3499；旧请求和业务数据不回灌。

本轮新发现的任务外问题：`D-20261106-BSK-SESSION-CLOSE`，本轮独占测试会话grcq/vvbk的stop持续等扩展超时，已记录统一discoveries。Pro一次提交前细因缺失属于本次模型原证缺口，已如实记本节，不扩全站排障。

### 浏览器收尾待核线索

本轮仅使用独立Agent Window，未借用用户既有页签。grcq（window2054148168）及vvbk（window2054148163）实际调用session stop均返回extension timeout，grcq一次sync明确session is stopping；最终session list仍列两项，不能声称清理完成。doctor确认daemon身份/协议、1个实际Chrome扩展连接均正常，日志持续failed to stop idle session；未证明具体根因或工具升级可修。已保脱敏cleanup原证，不杀Chrome、不手管daemon、不改扩展权限。该工具收尾缺口不影响已成功原图GET/解码/结算，也不触发生图重试。

## GPT2、中档与标准参数接续（2026-11-07）

用户授权：继续GPT Image2与Sunburst中档接通实测、修好直接上线，只测生图；旧待核原号不重发。截图2.6 Sunburst保留最高/4K时，不能因本地登记的支持范围卡住生成。

实际基线v0.134.16、16c57e550068fca839b351997c213466c25e288b／BUILD RfviUaNpEBzDe5Tdvrg-L；复用本线程隔离工作区，新分支codex/image-model-unblock-20261107，正式根脏改保护。当前defaultRoutes12、settings32，两旧任务均uncertain、retries0、无Asset。GPT2默认EFE原停用，medium仍独立80a通道、medium/1K2K、7参考、0.5点；两个2.6的EFE登记auto/1K、0参考、正式固定价5点。原工单的历史结果和6.9待核不重写。

- [x] 核线上源、真实设置、旧原号和截图质量/分辨率双层拦截。
- [x] 让平台合法GPT标准质量/尺寸原样通过前后台能力登记校验；不降档，不切路由或借其它规格价格。
- [x] 工程验证真实SQLite报价/绑定、前端共享判断和供应商payload；保原权限、停用、素材限制、费用和未知原号。
- [x] 核GPT2和medium既有服务/协议，做必要的全新独立单张样本；旧号只读，文字/视频零调用。
- [x] 继承实际最新源完成聚焦提交推送、相容保护发布和运行核对；记录成功结果、费用与真实未决项。

架构判断：sharedImageStudioChannelIssue与validateImageGenerationChannel重复将provider登记当平台参数准入，截图的标准选项因此被拒；pricing/image-availability先核平台枚举，provider已原样传model/quality/size。只在现有model-catalog加纯判断，两个入口共用：平台列出的GPT质量/分辨率无需provider数组包含。原缺配置/停用、native限制、参考上限、medium/max双线路、按规格真实价格和冻结合同保持，不把供应商尚未实测的组合声明为支持。报价或供应商真实拒绝继续如实反馈，结果尺寸按现有IMG-VIS可用原则。不迁库，不改已受理/unknown任务，不新增平台或自动重试。CodeGraph真实16c57索引1944文件无差异，context已返回共享入口和质量/比例关系，关键判断核源码。

验证L2：用户本次明确授权生图功能测试；仅对本轮共享参数变更做定向工程断言、已有必要构建及新样本原图GET/完整解码/结算核对，其余页面仍用户手验。供应商未决不冒通过；未知旧任务缺原图/可查询上游原号时继续保留，不换号补造旧结果。

### 中档新样本与尺寸误判修复

新独立请求`model-connect-20261107-image25medium-r1`已沿中档80a原通道正式受理，task `rate-cda3ff725c885931aadcd205c79b7183811e8541f17943af53425e9679f960d4-0`。请求medium/1K/1:1/无参考，供应商已实际返回PNG1536×1536、2625210字节，Chrome原图GET200和完整解码通过；运行16旧worker却仅因请求1024×1024而判failed/provider_loss，已按旧流程释放0.5预留，本站实扣0。原图可用，本站任务尚未成功，不能混作全链路通过；此笔不改状态、不追扣、不重发。旧四笔6.9待核原号不动。

最小修复在正常worker明确不要求像素完全一致，仍在元数据记录请求与实际尺寸；媒体完整解码/尺寸上限/格式/透明要求/保存与正常计费边界保持。默认验证器继续严格，既有“明确尺寸拒绝后恢复”的原件检查点仍沿历史退款路径，不让旧退款变成新扣费。没有改尺寸计算、裁切、拉伸或自动重新生成。正常结果成功后不再产生尺寸失败提示，实际宽高按原详情查看。

定向真实SQLite检查在Linux隔离目录size-repro01完成9组：保全部8组历史原图保留、原号恢复、退款/未知、权限与坏文件保护；新增正常本机原图尺寸差异→完整保存→succeeded→单次正常结算→再次恢复不重复扣费。productionWrites/paidRequests/browserRuns/forbiddenCalls均0；四文件真实hash与本机实际源码核对。Mac同fixture在本地慢读取环境触发180秒无正文退出1，不冒通过；Linux同字节验证退出0，并非用重试隐藏已确认产品错误。原证size-probe-linux-receipt.json和medium7-retained-original.json已归正式私有资料。

attempt01冻结d48/254只含参数放行；新增实际返图证据证明还需本次尺寸修复，故只对本线程构建树SIGTERM结束、未切版、未动正式服务。部分旧native检查完成，取消记录保留；controller退出码0不证明整批构建通过。最终须重新冻结主/guard并用attempt02，不修改运行中旧stage。打包与慢Git提交交叠曾生成指向旧d48的本机release17b资料，核真实source后未投递；其它中间包同样不冒最终产物。

### 最高质量的供应商枚举与菜单

当前供应商2.6 Sunburst公开文档（`https://uselg.top/docs?model=gpt-image-2.6-sunburst&group_id=12`）列low/medium/high，high为最高合法API档；页面历史max/xhigh是更强质量意图。新2.6适配仅对两个精确2.6 ID将max/xhigh发送为high，页面和冻结请求保留原值，诊断记录实际发送值；属于枚举转换，不降至medium/low，不换模型、地址或价格。GPT2与2.5双线路质量原值不改，旧unknown也不转换。定向检查覆盖两2.6的五种质量发送与原输入不变，以及2.5最高仍发max；真实最高/4K出图仍待新部署后验证。

下拉与同一平台GPT枚举对齐，修复只放行而仍把保留最高/4K标“不支持”的残留；2.5仍仅中等/最高，native菜单不变，没有新增布局、提示或CSS。最终质量/尺寸取图成功与当前后台能力登记分开报告。



### v0.134.17 已上线与实际生图（2026-11-07）

最终 main `ce3ecc1ea9599388e8eb389d3f3fefe452ca6579` / v0.134.17 / BUILD `SMcYioDmGLio8bcidl-LU`，guard `841ad62a9e4b59ee8f1f903c2c67f27c745f71d7` / `Al_ZSWzar0oc5c7xDQE3R`。attempt03 两版 fresh native/pricing 与完整 Next/types/lint 均通过；13:04:37Z 切版/公网核对成功，cutover0、七服务四timer、两生图页chunk和匿名401有证。价格两Setting全字段仍8f4ab818，私有策略仍b132555，无schema/依赖/价格迁移，程序恢复不回数据。

attempt02 的29组native通过，13/14 pricing组通过后，旧image-spec断言仍要求合法low因provider未列而拒绝。只修断言为允许平台合法low并保留未知enum拒绝，94条独立规格断言通过；ce3相比8437业务代码不变。原failure-report/失败日志保留，attempt02未跑Next/切版；attempt03整批fresh通过。

本轮仅5次新的独立单张生图，无参考、通用静物提示词，私有测试模块、飞书关闭，文字/视频模型调用0：

| 请求后缀（统一前缀model-connect-20261107-） | 结果和费用 |
|---|---|
| image25medium-r1 | 16旧版返回完整PNG1536²/2625210字节，GET200+完整解码；旧尺寸规则误判failed，预留释放、实扣0。原记录不改、不追扣不重发。 |
| image26sunburst-v17-max4k1 | rate-3e798ad115d5750923811a0df3b505f09928918390f40c5df056b89ccafe56c6-0 succeeded。选择max/4K、本站合理请求2880²；PNG2880²/11790597字节，GET200+Chrome完整解码，实扣5。 |
| image25medium-v17-r2 | rate-20fb926240ab7cf11831ea96287a6ccfadd6d88f1bca381ec0102a9aa26a34ff-0 succeeded。medium/1K请求1024²，PNG1536²/2756331字节，GET200+解码，实扣0.5，尺寸不再误判失败。 |
| image2-v17-high1 | rate-b1849b4819f0320f9da56d5d37cd40017d8334482eee438165e8c0679c26bb2f-0；上游202、原async imgtask_7b945251-8d9b-4d3b-9a63-22baf63ed81f，summary200明确failed、身份verified，无可识别具体原因。本站failed/provider_loss、实扣0。 |
| image2-v17-medium1 | 前一新high明确terminal后，单次不同的官方合法medium/1K区分档位特例与线路问题；rate-abbb42c78228146ce87ae2e36b2746c4eba21975855200f650b244494ee93ee2-0 HTTP503，无asyncID；未知code只知长度19，不编原因。uncertain保留5，不重发。 |

没有换key/别名/路由或自动重试，没有开通新组。GPT2仍未测通，等待供应商可用或原号具体结果。正常管理API只将GPT2 enabled开后停回，原mutation enable-image2-r1 / pause-image2-r1，defaultRoutes12→13→14；其它模型/旧Key地址/medium路线/价格保持。未写pricing PATCH，原三行统一5点报价仍合法；raw API null计费不冒实际站内报价。

本轮实扣5.5，生图累计22.8；旧四笔6.9与新GPT2 medium5分开，共11.9待核。只读SQLite前后核旧四笔snapshot/freeze/billing_contract SHA、状态、账本完全一致，原号provider重发0。失败退款不追扣。私有原证image-final-audit7.json、final7-poll3.json及gpt2-samples-provider-diagnostics7.json已定位。

本人fixture实页：2.6 Sunburst max/4K均有合法选项、无质量/分辨率不支持提示；正常fill提示词后生成按钮可用，未点额外生成。该证据只覆盖本次范围，不代表全站手验、全部规格/参考图稳定性。

### GPT2最高切换后续小修（v19候选）

显式模型下拉默认保留quality，从2.6最高max/xhigh切GPT2仍会被目标enum拒绝。最小补丁只在显式新选GPT2时，把最高意图转为该模型合法最高high；分辨率/输入/素材保持，GPT2 high显示最高。恢复历史、冻结和pending未知保护不变，无新增降档/路由/费用修改。

实际提取UI事件和共享label共9条断言通过；CodeGraph6f8106源1946文件零hash差异/parseError，调用结论复用。补丁c89b0a721已推送；继承18 aa9e34763c7a5cc5b15989a79187eddd20177bf9后的最终候选6f8106ed879e2ed66515f725143011becee84c67 / v0.134.19，codex/image-model-quality-label-20261107，较18仅两文件和版本/简讯共5文件。独立stage image-quality-switch-20261107/attempt01构建中，复用已发布841保护版真实构建/native与原时间，不冒重跑。18已13:19:13Z实际上线aa9/tEZbib4hTHkvbIbGYVZKU，生产窗口已交回本线程，19须继承这一实际pair再切。

本轮新发现的线索与问题：质量枚举和原图尺寸根因均属本任务，未新增范围外问题。早期BSK会话在本轮开始list已为空，不能据此声称旧timeout根因已修；保原发现记录，未重启Chrome或工具后台。

### v0.134.19 最终发布与发布恢复记录

2026-11-07 13:37:27.490Z 已实际保护部署 v0.134.19 / source `6f8106ed879e2ed66515f725143011becee84c67` / BUILD `QzkN1fJzfaLVWPG1TbnLY`，服务器 image-quality-switch-20261107/attempt02 / cutover0。完整 main native/pricing、Next/types/lint 于13:28:57Z通过，guard841/Al_ZS沿用原实际13:03完整产物；同一候选复用，没有因发布工具修正重编或重测模型。新旧源对、实际六项启动检查、七服务四timer、两生图public chunks同SHA、两匿名401与health200均有证。33项模型配置value SHA保持最终revision14，价格两Setting全字段仍8f4；程序恢复不回DB/账本/媒体/回执。代码已推原正确remote，公开入口仍 `/template-studio`。本次指定生图样本证据沿上表，其余功能已部署、待用户手动验收；GPT2上游仍未测通。

首次attempt01不冒成功：13:30:30Z停止服务后，被sd2-feedback-delivery的预先failed/exit1状态挡住；journal证明该oneshot13:30:22Z已退出1，早于切版，MainPID0，非核心生成服务。未激活6f、未写新allowed/指针、未建数据备份或回灌。自动program-recovery又因继承的baseline硬编码ce3而拦截；这是准备脚本漏核，保cutover1/recovery1全部原文。沿既有已授权服务恢复，在指针始终aa9的前提下立即启动原七服务四timer，公网v18/health200确认恢复，无数据恢复。

新attempt02保持失败stage和所有构建成果，发布工具在启动前冻结：只修正恢复baseline绑定aa9，以及同一个通知oneshot在服务stop前已failed、前后退出元数据完全相同/无PID/空cgroup时允许继续。新的核心失败、活PID、时间变化、timeout及SIGKILL仍拒绝；真实抽取停止判据8条断言通过，未删除必要数据保护。source pair与8f4重新鲜核后第二次切版成功，没有第三次尝试。通知投递自身exit1的业务原因/影响另入 `tasks/discoveries.md` D-20261107-FEEDBACK-DELIVERY-EXIT1，本轮未顺手改造通知。

旧四笔快照/冻结/合同/账本已在v19上线后再次只读确认完全不变，6.9预留不重发；本轮5.5实扣和新GPT2 503的5点待核保持。首次发布短暂停服、恢复原18、最终19的记录均保留到私有资料release19-attempt01/02，不以新成功覆盖失败。

最终v19实页核对：本人fixture从2.6最高max/4K切GPT2后，真实select为quality=high、文案最高、resolution=4K，质量/尺寸不支持提示均无，未点击生成。GPT2因最终恢复停用而按钮禁用是实际线路可用性保护，不冒此次已测通；截图中的2.6最高4K按钮可用与两真实原图证据独立保留。原证ui7-v19-after-gpt2-switch.json已归私有材料。

### 两个2.6 API参考图文档核对（2026-11-07洛杉矶）

用户要求确认API，不把站内maxReferences=0当API拒绝证据。供应商group12两个型号页均展示POST /v1/images/edits参考图示例：JSON用images[].image_url（公网URL或完整Data URI），本地文件multipart用image；同步/异步字段一致。但同页限定仅模型明确支持编辑时使用edits，且注明此线路未配置专属请求示例，没有给2.6专属支持确认和参考上限。通用说明中的8张属于Seedream5.0 Pro，不能移植到2.6。

真实网页和同源公开GET核对：pricing/public两group12 offer无profile/参考能力字段，model-document两HTTP200均revision空/edits[]；后者是文档编辑覆盖列表，不是图片edits能力开关。只能确认平台有参考图传法，不能据通用模板确认当前2.6线路/Key能带图，也不能断言模型本身不支持。尚缺真实带图生成或供应商对当前分组明确确认。本次文档读取generationCalls0、配置写0、旧待核重发0，不改参考上限/私有策略/价格；Ego空间27正常finish关闭。

来源：[Sunburst供应商文档](https://uselg.top/docs?model=gpt-image-2.6-sunburst&group_id=12)、[Flare供应商文档](https://uselg.top/docs?model=gpt-image-2.6-flare&group_id=12)。原网页/公开元数据/结论归正式私有材料image26-reference-doc-pages-confirm7.json、image26-reference-public-metadata7.json、image26-reference-confirmation-summary7.json，无凭据/媒体。

### 两个2.6各一张参考图真实验证（2026-11-07洛杉矶，进行中）

用户已明确授权两个2.6各带参考图实测一张，能用接通上线，只生图，旧待核不重发。接2号29发布后的配置窗口：actual source2266d7d8098acf531a87940929fb6263a9876444 / v0.134.29 / q6NJi504KhO7IJgAleb9f，guard f0fc87f9896daa685c1067bb341e85ee21933a9a / _JwQu0Zzx5P5dk89dyQd9，角色工作台和读者保持。参考是本人此前成功的橙碗/青苹果PNG，asset studio-rate-20fb926240ab7cf11831ea96287a6ccfadd6d88f1bca381ec0102a9aa26a34ff-0，SHA ca18b3d1d349d50c7f41673743a4adb504afb84b80ba434f930729af9206574f，已读权限/完整解码。两个唯一新原号model-connect-20261107-image26flare-ref1 / image26sunburst-ref1，n1/ref1/auto/1K，只换深蓝背景，预算按鲜核原价Flare5、Sunburst2共7点，无文字/视频或旧请求。

现有provider已把非空images送edits，无需先改源或重建版本。CodeGraph actual28索引1953文件零差异，context已定位saveImageApiGroupForm，29相关provider/private/pricing/source字节与28相同，定点源码复用。正常API只两型号maxReferences0→1。同一现有Key和api.uselg.top的edits目的名单仅加两2.6，不加host/key/其它model或原文读取权；用户本次明确带图授权替代此前仅generations范围。原policy三文件完整备份、主29/guardF0各9条真实reader/目的地/模型/凭据正反断言通过，生产私有路径和UID规则保留。此前离线准备失败为候选目录不在控制区及新父目录owner错误，无active policy变更/模型调用；只修本轮候选路径/权限，未改安全源码或用test绕过。06:24:13Z同一29源必要停启后已应用policy image26-reference-20261107-01，七服务四timer/health200，DB写0。

正常API mutation model-connect-20261107-image26-refs-one-r1 已200且原GET found，default14→15，两refcap1；其它模型/Key/协议/尺寸/质量保持。新ref配置使这两行原定价依据需重新确认；第一enable-only preview前置发现needs_review未POST，转正常preview/PATCH只重确认本站原CNY0.5/0.2×10，两值不调，Flare原停用行恢复启用，Sunburst保持启用。operation model-connect-20261107-image26-reference-reaffirm-r1 已200，policy92ac99c7-abc8-45d7-8454-cb9a545b6ed8，preview affected恰两行，不清理其它待核/停用项。重新读取实际统一DTO两模型ready/fixed5和2/refcap1。

两次新任务都202：Flare batch5ba5d8160a109a1f994f57b3cac8c75bd74180b111a041fc21edb7c796d048df；Sunburst batch36d4937817643ddae04754879bf57a87cf763ad4af02217696e5850ab582db85，任务ID各为rate-{batch}-0。正常任务、冻结费用/素材权限/原件保存/结算链不绕过；此后只查这两个原号，无额外生成。旧五笔11.9的原快照/冻结/合同/账本已独立只读备份。stage /data/video-api-debugger/release-staging/image26-references-20261107/attempt01；实际返图/解码/视觉/费用仍待接续，不把202或配置上线冒实测成功。

### 两个2.6参考图已实测成功并配置上线（2026-11-07洛杉矶）

**结论替代前一节仅文档核对的未知状态：当前同一EFE通道的GPT Image2.6 Flare、Sunburst均可带参考图。** 本次各一个新原号、各一张参考图、输出一张；没有重试或额外生成。当前开放合计1张参考图，不据此冒多图上限、其它Key/分组或全部质量/尺寸都已验证。

| 模型 | 新task | 原图与正常结算 |
|---|---|---|
| gpt-image-2.6-flare | rate-5ba5d8160a109a1f994f57b3cac8c75bd74180b111a041fc21edb7c796d048df-0 | succeeded / confirmed，PNG1024×1024，1418954字节，原图GET200、Chrome完整解码，实扣5点。 |
| gpt-image-2.6-sunburst | rate-36d4937817643ddae04754879bf57a87cf763ad4af02217696e5850ab582db85-0 | succeeded / confirmed，PNG1024×1024，1196893字节，原图GET200、Chrome完整解码，实扣2点。 |

实际函数requestStudioImages沿既有OpenAI Images适配把ref1图片字节作为multipart的image[]发到/v1/images/edits；两次原异步受理后查询成功，两safeRetry均仅首尝试ordinal0/retries0。参考为本人已成功中档静物原图；实际看过原图及两成品，橙色碗的轮廓/高光、绿色苹果与左右相对位置保留，台面/背景均由白改深蓝。没有裁切/拉伸冒达标、补图或拿HTTP202冒出图。原始request/async成功后正常移至studio-billing耐久目录；审计已按原reader的delivery→billing顺序读取，不把正常归档当回执丢失。

**已生效配置**：defaultRoutes15，EFE configRevision394cd0cc-747a-45b9-b234-dc9148e1a590，两型号enabled/refcap1，真实统一报价ready/fixed5与2。只修改这两型号参考数，旧Key、基址、协议、其它型号和默认路由归属保持。价格操作92ac99c7-abc8-45d7-8454-cb9a545b6ed8 / authoring37404d45-6517-40fe-8aaf-c24f447c287b / capabilityf4a48550-4e17-409c-8b3e-a0e42ea05489；两Setting全字段SHAd03c539d74a31b5e2a6a0305724b1b9f193e0ade878370898c7632d1bdc96539。只重确认两条新参考能力的价格绑定并启用Flare原5点规则；基价CNY0.5/0.2、10点/元、统一标准和账单主体/凭据版本不变，另外58条已存规则逐字不变；authoring entries/members/global保持。费用是站内价格，不冒供应商现金账单。

目的策略image26-reference-20261107-01 / SHA35fc8b70fc57df1f64e164b5439f1ba8f99d76cf12ab3ad3d8dea588edad2ff0，只在原同Key/musk/api.uselg.top的edits名单加这两型号，主29和相容F0均已实际通过9条正反断言，原其它字段/Key文件不改。必要停启后七服务四timer/health200；应用源/BUILD保持29的2266/q6NJ、guardF0/_JwQu，**本轮为配置发布，无应用代码变化，无需重建或占用30**。随后2号可继承29和这批鲜核配置继续30前端，不得沿旧7d8价格/旧policy保护快照。

前台本人私有fixture刷新后，两型号选项均正常可选、不显示未就绪，主图/参考图添加按钮可用，不再出现0参考限制。本次没有再点生成；两次收费样本已覆盖正常任务/原件/结算闭环，其它页面仍按项目约定用户手验。

本轮实扣合计7点，新增待核0；本目标生图历史实扣22.8后累计29.8。旧五笔11.9的状态、snapshot/freeze/billing_contract SHA和全部账本再次逐项相等，原号重发0；文字/视频模型调用0。原审计准备只因成功回执已从delivery移到billing而读取失败，修正只读路径后核对通过，不改任何业务行或历史数据。

实际证据：正式私有材料reference-tests-20261107内保存输入/源图SHA、两次202和原号查询、原图GET/完整解码、正常CAS回执、主guard策略验证与同源运行检查、最终只读审计final-reference-audit.json、两PNG和原参考。未将密钥、签名token或私有媒体提交Git。旧文档阶段未知、准备失败与历史待核记录均保留。本轮未新增范围外问题。

### 用户补充的 AI Media VIP Sunburst 接口资料（2026-11-07洛杉矶）

来源为本轮用户粘贴的《GPT Image 2.6 参考图与 GIF 接口》，属于接口资料，不把其中 curl 和 GIF 示例当作新增调用指令。原说明指定 `gpt-image-2.6-sunburst`、`POST https://api.ai-media.vip/v1/images/edits?async=true`、multipart 三个同名 `image[]` 字段；静态图示例为 `size=3840x2160`、`quality=max`、`n=1`、`output_format=png`、`response_format=b64_json`。这说明该资料描述了三图输入能力，不把三张示例反推成模型的绝对上限，也不外推 Flare。GIF 的帧参数仅保留为资料，本任务仍只处理静态生图。

本次实时只读查询 `image_generation_channels_v1`：既有 `api.ai-media.vip` 通道 `image-2c29f604-0476-4fe2-8b41-73681d4e7bb1` 为 enabled=false，只有 GPT2/2.5 型号能力，无2.6；已实测两个2.6的启用通道仍为 `api.uselg.top` 的 EFE，auto/1K、maxReferences=1。当前开放1张是该通道已发布的实测配置，不是模型本身的参考图上限。两域名尚无同账户/同分组/同路由的对应证据，不把这份新资料冒充现用 FluxPort 线路已通过三图4K测试。

源码 `src/lib/image-studio/provider.ts` 已支持逐图 multipart `image[]`、异步原号受理和原件保存；现有两个2.6的最高档枚举会把 max/xhigh 发送为 high，源于原 FluxPort 适配。若接入新资料所列目的地，须按其 `quality=max` 合同核对该差异，不能仅凭同型号名套用 high；本次未启用 VIP 的2.6或修改这一行为，不冒该停用线路已发生真实生成故障。公开网页读取未能取得此新接口的独立文档确认，首页404也不当作 edits 不支持的证据。

本次为资料和现状核对：新增模型调用0、配置/策略/价格/生产文件写0，旧待核重发0；不扩大上轮两个单样本的测试数。保留现有已测通配置及2号持有的30构建/切版窗口，仅同步本原单和固定todo。未新增范围外问题。
