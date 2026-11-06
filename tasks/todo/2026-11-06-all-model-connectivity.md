# 全部模型连通与修复

用户要求：把模型全部测通；随后明确为**图片生成模型**。从线上v0.134.7开始，现已接续共享v0.134.8，按实际配置逐图片型号核对；可调用项真实生成，停用/缺许可项不强开，失败按原证归因并修复授权范围内的问题。当前3个型号成功、2条原请求待核、3个新型号因配置/许可未提交，不能称全部测通。

## 范围与保护

- 当前范围为7个新选生图型号及1个只读历史型号；2.5 Sunburst中等/最高有独立实际通道，分别核对。不再新增文字、视频、IP、H3或其它工具测试。
- 图片每型号/独立通道采用最小单样本。新测试保原请求号，供应商已受理未知只查原请求；正常账号、权限、报价、预留和结算链保持。不改旧任务、正式默认、费率或凭据目的地许可。
- 图片使用当前登录Chrome同源业务接口。目标是前台可选型号能真实报价、生成并取得原件；设置“就绪”、构建和历史旧样本均不能代替实际测通。

## 任务

- [x] 核线上运行源、配置与目录；正式根旧检出与脏改保护。
- [x] 六个文字模型第一轮真实调用：5.6 Luna/Sol、6 Sol/Astra返回MODEL_OK；5.5当前分组无通道，6 Luna两次503。原适配器内置重试保持。
- [x] 图片全目录逐项核对；合法通道单样本、原号查询、成功原件读取/解码已记录；未通过项和费用保护见末表。
- [x] 仅核对范围纠正前已受理的两条视频原结果和费用，不新增、不重发；均成功结算、冻结0，不计图片模型成绩。
- [ ] 修复本轮确证的本项目缺陷；必要工程检查、聚焦提交推送；有代码发布才保护部署。
- [x] 汇总全清单、站内实际费用及剩余上游/配置/许可缺口；供应商现金实际账单未核，不当站内费用等同。

## 工程判断与证据

复用原供应商适配器、正常业务API和现有费用链，不新增测试平台。生产配置存在“总体modelReady为真但具体通道不可用”的差异，先以真实报价确认，不以后台原始enabled字段冒可调用。2.6缺通道/费用/目的地许可沿原单保留，不绕过保护。

CodeGraph正式根准备和查询因Git文件集合读取30秒超时失败，未返回旧结构；本轮只定向核实际线上源码。正式根当前分支codex/mediakit-video-enhance、HEAD05807fc有旧脏改及ahead，不作候选源码或整树推送。已验证真实缺陷：两种已批准native模型的共享例外要求整数固定点数，现行合法0.6/0.7点被误拦；只将该条件改为非负有限数，既有入口费率精度和显式能力限制保持。

2.5 Flare原任务已成功、原PNG1024×1024/1021186字节；继续核原件解码与结算。Sunburst手工旧报价调用r1/r2明确拒绝；r3返回pricing_quote_changed，回查unknown。仅本轮两条测试原号已沿站内close事务核对并安全封口（返回closed、原号不能再次生成），未改旧用户未知任务。随后改用当前页面既有currentFixedPricing业务入口，不改费率或放宽准入。

范围误判：开工将“模型”扩大到文字/视频，用户补充“图片生成模型”后立刻纠正。之前文字6个实际调用及两条视频已受理事实保留，不当图片成绩；后续不再新增。

私有测试原号记录：`/Volumes/Data/Cache/sd2-model-connectivity-20261106/`。前两次普通视频legacy请求明确400“必须先选择视频卡”，未返回任务号；改沿已存在creation_contract_version=2业务入口接续测试，不能当上游模型失败。

验证等级L2：真实请求和结果证据；不自动执行无关回归、独立审核或其它页面验收。Git计划：记录使用临时索引/聚焦文件隔离，正确origin为goukiyang/seedance-api-debugger；源码需要修复时另核当前发布源工作区。

## 本轮新发现的线索与问题

当前未新增任务外事项；模型通道/报价和旧调用脚本协议属于本次范围，持续核对。

## 当前执行现场（2026-11-06，接续入口）

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
