# 项目资料索引

## 人物描述优先与自由表达（2026-10-05）

- 项目video-api-debugger；接收2026-10-05，来源用户本对话文字与人物页截图；资料版本原始反馈v1，补充并纠正旧C1/D3分类硬拦截，不替代原件。
- 原文件名：codex-clipboard-e55ec5aa-faff-4b03-9158-1aea6b1718c3.png；[正式副本](2026-10-05-avatar-description-first/codex-clipboard-e55ec5aa-faff-4b03-9158-1aea6b1718c3.png)，原剪贴板路径保留；800x573 PNG可读，辅助反馈不逐项哈希，不公开Git。
- 关键词/用途：AV1、反派、描述优先、自由表达、可选条件、分类拦截、完整原文、四宫格、原回复免费复用。截图展示用户只输入“反派”，系统误要求补充；用于修复与后续用户手动验收，不当成真实模型原回复或修复后证据。
- [正式工单及当前状态](../../tasks/todo/2026-10-05-avatar-intent-generation-flow.md#11-av1描述优先与自由表达2026-10-05)包含已确认原则、范围、实际源码根因及开源实际代码来源。本批已实现部署、待用户手动验收；没有调用付费模型或人工改生产数据，旧付费样本不证明新自由描述效果。
- 2026-10-06交付v0.44.1/f0a142f/BUILD Nc2Ap5uhxsUEQCkxpRocE：[11文件与命令/风险报告](2026-10-05-avatar-description-first/delivery.json)、[统一diff](2026-10-05-avatar-description-first/source.diff)、[候选](2026-10-05-avatar-description-first/candidate.json)、[公网证明](2026-10-05-avatar-description-first/public.json)、[源码Review](2026-10-05-avatar-description-first/source-review.json)已归正式根。资料版本对应本批，来源Git与服务器实际输出；关键包/源码/静态哈希核对、辅助日志可读不重复逐项核验，无替代原截图。已部署待用户手动验收，0模型/图片/人工数据写，匿名登录重定向不能当真实效果证据；历史原则补充而非改全站模式。

## 批量生成与文件夹交付设计（2026-10-05）

当前授权/状态（2026-10-06，资料v1.1.0）：用户明确要求批量与演化内容联合落地，后追加完成提醒及人物预览。演化内容填写“什么发生变化”，复用原补充输入框，不增加重复正文。同一[工单v1.4.0第14节](../../tasks/todo/2026-10-04-template-context-version-code.md#14-批量与演化联合实施2026-10-06)的BATCH1/EVO1/REL1/NOTIFY1/PREVIEW1已实现并发布v0.45.0/545d9d6/BUILD KbJIPWhOPLhIslbk70m-a，发布检查有据、真实效果待用户手动验收。安全交付[回执](2026-10-06-batch-evolution/delivery.json)、[统一diff](2026-10-06-batch-evolution/app.diff)、[最终候选](2026-10-06-batch-evolution/candidate.json)、[公网证明](2026-10-06-batch-evolution/public.json)、[源码复核及逐项未验收](2026-10-06-batch-evolution/review.json)已归正式根，关键复制字节/哈希一致，辅助可读不重复逐项校验。来源为本批实际Git/构建/服务器输出；无新用户媒体附件，未复制数据库/凭据/用户素材，无本批付费生成、目录访问或自动功能验收。以下v1.0.1设计记录为历史，不冒称当前未实施或真实效果通过。

资料名称：批量生成、指定文件夹与闭环流程需求及设计建议；接收2026-10-05；项目video-api-debugger；来源为用户当前对话文字，无原文件名或新附件；资料v1.0.1补充原v1.0.0，无替代原始要求。关键词：BATCH1、批量生成、素材文件夹、结果保存位置、费用上限、暂停续跑、失败重试、ZIP、手机降级、入口、生成结果、我的批次。用户已确认设计目标并追问入口和查看位置；文件夹读/写用途尚未答复，结果目录为主、素材目录可选及首版模式均为建议，不是实施授权。

正式原文及完整设计：[既有模板工单v1.3.1第13节](../../tasks/todo/2026-10-04-template-context-version-code.md#13-批量生成与文件夹交付设计建议2026-10-05)，路径`/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-04-template-context-version-code.md`。正文、现有任务/上传/结果保存/ZIP源码可读；原生目录、browser-fs-access的Apache-2.0实际代码及官方浏览器限制已查，未安装或运行。要点为文字批量不强制参考图、生成/保存分开、预算有界、8张在途规则复用、未知请求不重发、保存失败不重生成、源图不覆盖。入口建议放现有生成栏的单次/批量切换，同页结果区按批次看，顶部“我的批次”跨模板找回，手机版提供查看本批结果；实际位置未实施或视觉核验。仅设计记录，未取得文件夹权限、未上传/生成/收费/测试/部署；无新媒体附件，无图片完整性校验对象，非关键辅助不逐项核对。第12节演化建议及历史实施记录保留，不将模板源码的只读观察冒称当前线上功能证明。

## 完成提醒与人物结果预览（2026-10-06）

资料名称：生成完成标签页/可选提示音、人物随机结果缩略图与双击大图反馈；接收2026-10-06；所属项目video-api-debugger；来源为本轮用户文字，无新文件或媒体附件、原文件名不适用；资料v1.0.0，追加当前联合实施，不替代原结果功能。关键词NOTIFY1、完成提醒、标签页、提示音、批量汇总、PREVIEW1、人物随机、缩略图、双击大图、手机返回。原文及实施边界见[同一工单第14节](../../tasks/todo/2026-10-04-template-context-version-code.md#14-批量与演化联合实施2026-10-06)：已随v0.45.0实现并部署，真实效果待用户手动。提醒跟真实终态，不提前消费未知结果、站内换页保留本次观察，声音默认关、不申请系统通知权限；人物本图/候选/历史复用原查看器，不把文字候选当图片。官方浏览器资料与Airhorn PR实际diff已读，只作原生轻量路线参考、不安装新库；安全发布材料见上方2026-10-06-batch-evolution，原文/链接可访问，无新用户附件校验对象，兼容/声音/实际页面由用户手动验收，不声称付费通过。

## 演化模板方向与内容设计（2026-10-05）

当前授权/状态（2026-10-06，资料v1.1.0）：用户批准与批量一起落地，并明确演化内容复用补充textarea、填写“什么发生变化”、不另加正文框；此确认替代下文历史“只固定记录/不改应用”的边界。[EVO1同一清单](../../tasks/todo/2026-10-04-template-context-version-code.md#14-批量与演化联合实施2026-10-06)已随v0.45.0实现并部署，进入Prompt/任务与批次快照/历史/安全草稿；真实演化视觉与恢复效果待用户手动，不暗改档数、范围、排版和费用。交付证据见上方2026-10-06-batch-evolution；无新用户媒体附件，既有历史原文及来源保留，不把发布当功能验收。

资料名称：万用T度演化模板两项参数需求与设计建议；接收2026-10-05；项目video-api-debugger；来源为用户当前对话文字，无原文件名或新附件；资料v1.0.0，无替代关系。关键词：EVO1、万用T度演化、递进、递减、具体内容、演化方向、演化内容、填空、模板参数。用户明确两项及主要用途；命名、摆放、默认/正文/手选优先级是建议，未实施。

正式原文及设计入口：[既有模板参数工单v1.2.0第12节](../../tasks/todo/2026-10-04-template-context-version-code.md#12-演化模板参数设计建议2026-10-05)，路径`/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-04-template-context-version-code.md`。正文和所引共用生成源码已读，可访问；仅该模板显示、复用补充框及生成按钮、按正文理解不加常规确认，档数/范围/排版/费用不暗改。模板专属原文和实际界面尚未核对，不冒称链路已接通；无图片归档或一致性校验对象，非关键辅助未逐项校验。只固定记录，不改应用、不部署或付费。

## 模板标题收藏闭环（2026-10-05）

- 项目：video-api-debugger；来源：用户本对话文字与模板工作台截图；收到日期：2026-10-05；资料版本：原始反馈v1，无替代原件。
- 原文件名/资料名：codex-clipboard-d2a7827a-f62f-46fa-b4f2-8f16c99e452b.png；[正式原件](2026-10-05-template-title-favorites/codex-clipboard-d2a7827a-f62f-46fa-b4f2-8f16c99e452b.png)，原来源本机剪贴板附件路径，原件保留；PNG可读，310x113；辅助反馈图不逐项哈希，不作为发布或功能验收证据，原图仅本机。
- 主题/关键词/用途：模板标题、名称右侧收藏、取消点赞UI、个人收藏找回、使用、取消撤销；截图显示“转写实（推荐）”名称上方独立点赞及收藏。用于FAV1实现和用户手动验收，非导航页分类方案。
- 用户明确要求和执行状态：[固定FAV1工单](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#fav1模板标题与收藏闭环2026-10-05)。v0.44.0/17c55b2/BUILD 2eaaF0OY1UB1XncX97oQJ已部署，发布检查完成，实际效果待用户手动验收；保留需求原图，不当效果图。
- 本批交付资料：[统一源码diff](2026-10-05-template-title-favorites/source.diff)、[候选证明](2026-10-05-template-title-favorites/candidate.json)、[完整构建日志](2026-10-05-template-title-favorites/build.log)、[公网产物证明](2026-10-05-template-title-favorites/public.json)，资料版本对应应用0.44.0；来源本轮Git及服务器输出，主题为同行收藏、个人模板收藏闭环、安全发布与回退。关键发布包/回退包传输哈希及公网CSS/JS哈希已核，正文diff与确切提交对应，辅助日志可读不重复逐项哈希；原图及被忽略的构建日志仅本机，资料不含账号或收藏数据，未做功能自动验收。

## 设置保存成功关闭（2026-10-04）

2026-10-04，video-api-debugger，用户文字要求“写工单，排查项目同情况，一起修改”，无新附件或原文件名；工单版本1.0.0，补充全局保存成功关闭规则，不替代即时保存/应用/主工作台语义。主题：设置、异步保存、成功退出、失败保留、多表单草稿、返回来路。[正式工单](../../tasks/todo/2026-10-04-settings-save-close.md)正文可读；图片/视频上下文、旧模板编辑及后台 API 设置v0.39.1已部署，源码9c8a9ac，BUILD Bh-CIEFvI5EM3Y7NndzrU，保留此前v0.39.0新功能。开源参考 Radix Dialog 与 Ant Design ActionButton 官方文档/实际 Promise 分支，原链接在工单；仅方法借鉴，无新库。[完整差异](../../tasks/todo/2026-10-04-settings-save-close.diff)、[发布证据](../../tasks/todo/2026-10-04-settings-save-close.evidence.json)正式根可访问，构建/17源码/19新公网静态/4服务检查通过；功能待用户手动验收，不用正式根旧应用源码覆盖生产。

## 头像受控随机生成器 V1 需求（2026-10-04）

- 来源：用户在本项目主对话提交的30节需求正文与后续12条逻辑补充；无新图片、音视频或设计稿附件。接收日期2026-10-04（北京时间），原文件名不适用（对话文字）。原文归档：[30节需求](2026-10-04-controlled-avatar-generator/requirements.txt)、[12条补充](2026-10-04-controlled-avatar-generator/supplements.txt)，资料版本1.0.0，后者补充前者而非替代。
- 状态：[正式工单v1.2.0](../../tasks/todo/2026-10-04-controlled-avatar-generator.md)已补齐；2026-10-05用户明确“可以…开始落地”，批准站内人物生成及嫁接方案，新增导入窗口素材下方删除按钮；随后追加生成图片下方恢复设置按钮：悬停显示，单击图片只显示选中边框，按钮点击才恢复。P1-P5实施及应用v0.41.1为第12节历史，当前v0.42.3和有限状态修复见第15节，新链路/开源来源方案见第17节、尚未实施。优先1/3/4/5/6/9及原V1范围不变，各次收费和测试按对应后续明确授权及证据记录。
- 实施交接资料：项目video-api-debugger，2026-10-05实施lead形成并由supervisor归档，原目录名2026-10-05-implementation，资料版本对应应用0.41.0及最终0.41.1；主题为人物生成/三对象/受控随机/安全回填/素材隐藏撤销/恢复设置/候选构建/回退。正式根[首批历史报告](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/report.md)、[最终报告](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/patch-0.41.1/report.md)、[33文件清单与发布证明](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/patch-0.41.1/delivery.json)、[完整源码diff](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/patch-0.41.1/full-source.diff)可访问，同目录含构建日志/公网与运行证明/部署脚本；原件保留在worktrees/avatar-generator-20261005下相同相对路径。最终版本补齐P3三类本人资源，接续而不删除0.41.0证据，原需求/补充不被执行报告替代；源码2b1c4cf、BUILD TVyNICHldwYntu2SSA7Po。完整diff与Git一致、关键diff/运行/公网证明SHA复用delivery记录并核对一致，辅助说明/日志不重复逐项哈希；未含浏览器截图或收费生成证据，无本轮新媒体附件。用途：后续问题排查、用户手动验收、回退及交接；禁止把工程检查当功能验收。
- 最新反馈（2026-10-05用户文字，无新附件/原文件名）：生成未出图、继续、默认四拼一；用户明确选择“生成一张四宫格图片”，不是页面四独立图。[原话与G1/G2专项](../../tasks/todo/2026-10-04-controlled-avatar-generator.md#13-生成未出图与默认四拼一2026-10-05)保存同一正式工单。主题：描述解析400/pending/409、未创建图片任务、失败恢复、真实2×2四宫格、单图报价。只读服务/任务/请求时间事实已登记，原始400文字与实际页面仍缺证；生成故障修复进行中，不重复收费取证。一次生成1张组合图、四格不同人物、按1张计费，原独立模式保留；恢复/历史/人物身份边界见工单，旧页面2×2解释已被此确认替代。用途为本轮修复及后续验收，接续而不删除原30节/12条需求和P1-P5历史证据。
- 恢复设置同操作行截图（2026-10-05用户当前附件）：项目video-api-debugger，原文件名codex-clipboard-d538df10-c2b4-4507-9f80-93d16ac6a08d.png，原件版本未标注；[正式原图](2026-10-04-controlled-avatar-generator/2026-10-05-restore-action-row/codex-clipboard-d538df10-c2b4-4507-9f80-93d16ac6a08d.png)。主题/关键词：恢复设置、图片结果、悬停、底部操作行、下载、预览；用户要求“不要自己单独成一行”，将恢复按钮与已有操作按钮并排，保留原P5单击选中/按钮恢复语义。此图补充布局要求而非替代原交互，见同一正式工单13节G3；358×484 PNG可读，正式副本与剪贴板来源SHA256均55ba8eefbb7fdad60e7b164d3870198fc459ddb8954ad9367fc65d29fff36fba。用途为本轮布局实施/后续手动验收；不是修复后截图。含界面姓名，原件本机保留、不自动公开Git；无新音视频附件。
- 站内集成补充（2026-10-04用户文字“工具入口设计在哪，怎么跟我们网站系统嫁接”，2026-10-05批准落地，无新附件）：现有工具分组→人物生成，参考素材选择器提供情境入口，生成图进入我的素材，选中单图后回到原任务；复用账号/点数/图片worker/统一素材库。路径/tools/avatar-studio，替代早期未实施的/avatar-studio；来路/草稿/槽位校验、四份独立任务与禁止隐式继承模板设置见工单7.1。已有原30节/12条原文仍有效；开工正式站只读版本0.40.0，未做功能验收，删除对象澄清及实际进度见12节。
- 主题/关键词：受控随机头像、Avatar DNA、方案D、自然语言、人物范围、权重、冲突、特征预算、局部锁定、Seed、Prompt、配置、收藏、历史恢复。
- 用户明确方向：描述优先；不填写也能随机。快速设置仅性别、年龄、发型、眼镜、面部特征、饰品，默认不限；高级项折叠。素人、上班族、主角、家庭通过描述解释，不新增首页大分类按钮。单人主流程，多人次级入口支持2/3/4人。
- 随机内核：保存结构化基础信息、脸部、眼/眉/鼻/嘴、肤色与头发DNA；特征标记独立保存天然特征、后天痕迹、饰品与低频身份物品。条件权重、冲突规则、保守/标准/大胆强度共同约束，不能所有字段等概率，也不能堆满标记。普通/职场/家庭明显特征0-2、主角1-3；主记忆点至多1，次记忆点0-2，微特征0-2。工单建议明显预算计主+次，微另计，显式超预算保留要求但不再随机补特征。
- 锁定与输出：至少可锁性别、年龄、脸型、发型、标记和饰品；明确输入不能被随机覆盖。DNA、Prompt编译和生图模型解耦；Prompt自然语言、默认真实人物摄影，避免模板脸/过度精修；即使未接图片API仍能输出Prompt，不在普通主界面显示JSON。
- 用户确认布局：方案D，左输入与快速设置，中间大图与候选缩略图，右少量标签/自然语言总结、弱化Prompt及历史。结果可前后切换、收藏、下载、再次随机；复杂规则隐藏于系统内部，主按钮清晰。
- 配置与结果：配置支持保存、命名、使用、编辑、重命名、复制、另存为、二次确认删除；最近3个配置可达，完整管理次级页面。结果自动历史，保存图片/准确时间/DNA/Prompt/来源配置/描述/Seed，支持恢复、收藏、删除、基于此继续生成；恢复必须带回全部参数和锁定，收藏对象是具体结果。
- 新补充：明确输入>锁定>配置>推断>随机，字段保存user/config/inferred/random与独立locked；Configuration是规则、Character是人物、Generation是当次图片。换一个人/沿用方向与换造型/保持此人分清，微调只改目标字段；建议默认4位不同人物、可选1/2/4，每位独立DNA/Prompt/任务，不以同Prompt的n=4替代；批次多样性不破坏固定条件。
- 追溯：每条Generation能查到字段来源、规则/词库/算法/编译器版本、DNA Seed、Prompt与图片；具体保持身份和沿用方向的区别见工单，原需求中模糊的“基于此继续”已拆开。V1不增场景栏、大量摄影/风格控件、家庭大入口、节点编辑器或专业Prompt编辑器。
- 工单建议（非已实施事实）：最近一次明确编辑处理描述/快捷条件冲突，保留派生锁与手动锁的区别；关联采样、明确预算、DNA和生图Seed分开。摄影默认内部化，标准描述与模型适配分层；删除可撤销且不级联资产；基本文件成功不代表人物质量符合。完整DNA逐字段重抽和自动图像语义验收留V1.1，六类局部重抽作为轻量加项。
- 关键边界建议：DNA Seed只保证在相同输入/规则/算法版本下复现结构，不承诺外部生图像素相同或高清人脸完全一致；保存DNA、规则/编译器版本及实际模型参数，生图Seed单独保存（模型不支持时如实标记）。保持同一人的变体需参考原结果图片及模型能力，Prompt锁定不能冒充图像身份锁定。
- 链路建议：描述解析一次并校验，确定规则驱动随机与编译，再选择图片生成或复制Prompt；空描述不需语言模型。图片任务保留部分成功、失败和受理未知的区别，恢复不自动生成或扣费。若集成SD2，复用现有生成/积分/资产/鉴权，不建立重复账本；个人配置和结果默认账号隔离，共享另行定义。
- 开源资料：已读取[seedrandom源码](https://github.com/davidbau/seedrandom/blob/released/seedrandom.js)及[包信息](https://github.com/davidbau/seedrandom/blob/released/package.json)，MIT，可独立Seed随机，不解决人脸约束；已读取[Zod解析实现](https://github.com/colinhacks/zod/blob/main/packages/zod/src/v4/core/parse.ts)及[许可证](https://github.com/colinhacks/zod/blob/main/LICENSE)，MIT，可校验结构，语义冲突仍需业务规则；[DiceBear官方文档](https://www.dicebear.com/integrations/javascript/)仅作Seed+选项思路参考，图形头像不代替真人摄影输出。本次未安装、接入或运行这些组件。
- 用途与校验：供后续范围核对、数据设计、实施和手动验收读取；按“受控随机/三对象/四位候选/优先级”可检索。本节及两份原文可读性、工单/资料入口在交付前核对；无图片、视频或音频附件需归档。Jev本地doctor返回deferred/未授权，未外传需求或调用其云判断。本次意见由主控分析，不称独立审核或功能验收。

- 0.42.0接续反馈（2026-10-05用户文字，无附件）：最新错误定位explicit.gender非对象，已保留原回复但未提交图片任务；只读调查并安全规范化进行中，不自动重复收费。该错误属于新反馈，不冒称原首次400具体字段已确定。G2与失败恢复已公开0.42.0/82fe2cb/BUILD ZFdnS_3WyEES4aw7_V_vA；G1字段修复和G3操作行准备0.42.1，原30节/12条与历史版本证据保留。正式工单13节记录原话及状态纠偏，真实出图待手动验收。

- 本批正式交付证据（2026-10-05实施lead形成、supervisor归回正式根）：资料原目录g1-g2-0.42.0及g1-g3-0.42.1，资料版本对应两次真实发布，后者补丁接续前者、原0.41.*不删除。主题：失败解析CAS/私有回执/免费重检、真实单张四宫格、回退隔离、恢复操作同行、候选与公网产物。[最终报告与17文件说明](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/g1-g3-0.42.1/delivery.json)、[本批统一diff](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/g1-g3-0.42.1/source.diff)、[27项日志](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/g1-g3-0.42.1/sd2-avatar-0.42.1-regression.log)、[公网证明](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/g1-g3-0.42.1/sd2-avatar-g3-public-proof.json)、[运行/回退](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/g1-g3-0.42.1/runtime-proof.json)可访问；源码2c895ee、v0.42.1、BUILD BaWLKa1vTqBaQDtynG4MU。关键副本与worktree字节一致，统一diff与Git一致，JSON/日志可读，辅助文件不逐项哈希。明确最新gender字段为一层单对象数组并已安全修复，但缺对应原描述，整份真实回复需用户主动免费重检；真实收费出图/布局交互未自动验收。本记录非新功能授权，不把候选/公网正常冒充图片已出；G3原截图本机保留，作为需求而非修复后证据。

- 本轮付费检测登记（2026-10-05用户文字“付费检测，你要做”，无新用户附件）：项目video-api-debugger，授权仅本次单次必要出图；[原授权及V1/V2对账](../../tasks/todo/2026-10-04-controlled-avatar-generator.md#14-用户明确付费检测2026-10-05)。资料v1.0.0，受测应用0.42.1；主题/关键词：真实出图、单张四宫格、1024×1024、5点、任务/费用闭环、余额历史刷新。结果来源为本次真实成功任务的原生下载，[contact-sheet-result.png原图](2026-10-04-controlled-avatar-generator/2026-10-05-paid-verification/contact-sheet-result.png)可读、目视四格不同人物/每格1人、SHA256 ca22fa635152a4ce8954409b82a8c7ab7bbce5e867df201b8bc92b372addf552；[avatar-result-page.png截图](2026-10-04-controlled-avatar-generator/2026-10-05-paid-verification/avatar-result-page.png)可读，部分结果低于屏幕，完整四格以原图为准，非关键截图不补哈希。[receipt.json安全回执](2026-10-04-controlled-avatar-generator/2026-10-05-paid-verification/receipt.json)记录确切任务、一次实际5点扣费、约50秒、4份DNA/1个任务、未调用文字模型及原描述缺口。用途为本次检测、后续刷新修复及交接；补充而不替代原G1-G3需求/历史证据，不宣称原描述整份检验或全站验收完成。图片与含身份的截图仅本机私人保留，不自动公开Git；安全摘要可聚焦提交，禁止自动加次数或外发私人图片。
- 刷新修复与免费复查（2026-10-05）：资料v1.0.0接续上条，应用0.42.2/ad65015/BUILD nS8nR1E0dMsv12y2vj6jr；主题：历史最新状态/缩略图、共享余额同步、web-only、候选构建/回退。[三文件与发布报告](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/paid-refresh-0.42.2/delivery.json)、[完整本轮源码diff](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/paid-refresh-0.42.2/source.diff)、[公网证明](2026-10-04-controlled-avatar-generator/2026-10-05-implementation/paid-refresh-0.42.2/sd2-avatar-paid-refresh-public-proof.json)与同目录构建/切换/运行原件从实施worktree归档，关键报告与源副本字节一致，diff与Git一致，JSON/日志可读；辅助文件不逐项哈希。parent只读复查的[post-refresh-page.png](2026-10-04-controlled-avatar-generator/2026-10-05-paid-verification/post-refresh-page.png)原名/来源为本次专属BrowserSkill页面截图，版本、余额6240、历史成功和同图缩略图同屏，PNG可读，仅本机私人保留。receipt.json followUp记录同一taskId/asset、原图1024²/缩略图640²均已加载，session停止；没有新付费或恢复/重试。用途为刷新修复追溯/用户验收/回退，不替代原付费图或原描述校验；内部旧客户端更新弹窗未实际演练，G1原文缺口保留。
- 多状态有限测试要求（2026-10-05用户文字，无新附件/原文件名）：video-api-debugger，原话“帮我多测几种不同状态，和有限范围测试”，资料v1.1.0；主题/关键词：12组状态、空输入、描述校验、报价/排版、pending/failed/unknown、请求乱序、恢复/取消、0额外费用。已登记[固定工单15节S1/S2](../../tasks/todo/2026-10-04-controlled-avatar-generator.md#15-多状态有限范围测试2026-10-05)，稳定受测0.42.2/ad65015发现3个页面状态问题，907a7a2/v0.42.3统一修复后的23项隔离页面及8项内核检查通过，安全发布/源码远端/回退已确认。正式证据目录2026-10-04-controlled-avatar-generator/2026-10-05-state-tests；本要求接续14节付费结果，不自动授权更多收费、故意破坏任务或全站验收，原描述及真实退款缺口保留。
- 多状态真实页阶段证据（2026-10-05主控现场形成，原文件名real-page-evidence.json，资料v1.1.0）：[安全JSON](2026-10-04-controlled-avatar-generator/2026-10-05-state-tests/real-page-evidence.json)记录5个真实可撤销场景、临时选择还原、任务/图片不变及余额6240不变，专属session已停止；JSON可读，旧原图/截图沿用14节可访问入口，不重复截图。用途为12组定向测试的真实页面部分，不替代隔离模拟/条件内核检验；初次3条ERR_FAILED与末200条网络截断保留，后续一次有界诊断已重现chrome-extension://invalid/资源/控制台错误，确认本次是扩展地址而非sd2 API，不追溯归因所有旧中断或称控制台清洁。资料补充上条要求与旧付费证据，私人原图仍本机，不新增外发授权。
- 多状态修复交付资料（2026-10-05实施lead形成、parent归档；首次资料v1.0.0，应用v0.42.3/907a7a2，BUILD FsqpYuy1_T1uLBWVvKz96）：[delivery.json逐文件及12组结果](2026-10-04-controlled-avatar-generator/2026-10-05-state-tests/delivery.json)、[baseline-review.json稳定复盘](2026-10-04-controlled-avatar-generator/2026-10-05-state-tests/baseline-review.json)、[8项内核](2026-10-04-controlled-avatar-generator/2026-10-05-state-tests/baseline/kernel-results.json)、[23项页面复测](2026-10-04-controlled-avatar-generator/2026-10-05-state-tests/repaired/component-results.json)、[完整源码diff](2026-10-04-controlled-avatar-generator/2026-10-05-state-tests/source.diff)、[source-review.json来源/边界](2026-10-04-controlled-avatar-generator/2026-10-05-state-tests/source-review.json)、[runtime-proof.json](2026-10-04-controlled-avatar-generator/2026-10-05-state-tests/runtime-proof.json)和同目录构建/切换/公网原件，均按原文件名正式保存，关键JSON可读/报告复制一致/diff与Git一致，辅助日志不重复哈希。用途：错误恢复、未知提交、乱序防回退、有限回归及部署回退；替代旧产品页面状态实现，不覆盖基线19通过/3产品问题/1fixture缺口的历史。real-page-evidence.json publishedFollowup追加实际v0.42.3、原成功图片及6240不变、无业务点击、ttpl已停；此前5项真实检查受测版本仍0.42.2，不改写。合成故障/余额/1像素图不当成Provider退款或新收费出图证据；原用户描述缺失、旧客户端更新弹窗未实演。
- 文案意图理解反馈（2026-10-05用户文字，无新附件/原文件名，资料v1.0.0）：原话“输入文案，总是说尚未识别，按道理，不应该是llm帮我识别下我的意图先做分析吗”。video-api-debugger，关键词：LLM意图分析、固定字段、未识别列表、语义待澄清、成功缓存循环、分析与出图分开。原文和源码事实/建议/边界登记在[固定工单16节I1](../../tasks/todo/2026-10-04-controlled-avatar-generator.md#16-文案意图理解反馈2026-10-05仅排查与建议)，正文可读；当时线上v0.42.3。已查明输入只查状态、首次生成确认后才调LLM、结构有效但含未识别的缓存可反复阻止候选；尚无用户触发文案或对应真实回复，不把通用缺口冒充具体根因。建议理解摘要/条件/澄清先于出图，尚未实施或收费；不覆盖15节有限测试成果、不忽略明确要求，模型与原草稿保护继续有效。

- 输入与生成链路重梳（2026-10-05用户文字，无新附件/原文件名，资料v1.0.0）：原话“我觉得你应该根据我们刚才对输入框内容的修改，重新梳理下这个生成链路的逻辑”。video-api-debugger；主题/关键词：输入意图、语义就绪、未指定可随机、缓存、主操作、报价失效、历史快照。[正式子Todo v1.0.0](../../tasks/todo/2026-10-05-avatar-intent-generation-flow.md)保存完整推荐主路径、状态/参数变化处理、有限验证和未实施清单；补充16节反馈，不冒称已有输入框代码改动。正文和原需求/旧真实四宫格/有限状态报告入口可访问；没有新的效果图或收费调用，旧图片不作新链路证明。
- 开源数据与词库来源（2026-10-05用户文字，无新附件/原文件名，资料v1.0.0）：用户要求补齐“具体采用哪些开源库”，建议DiceBear系统机制、MAAD-Face真人属性、CelebA查漏、Avataaars字段组织，最终自有Avatar DNA，并禁止真人数据集图片作产品素材。video-api-debugger；关键词：开源选型、词库来源、MIT、CC BY-SA、CelebA非商业、字段映射、版本兼容。完整建议摘要/核实差异/唯一执行边界在[原工单v1.2.0第17节](../../tasks/todo/2026-10-04-controlled-avatar-generator.md#17-开源数据与词库来源2026-10-05)，实施待办接同一子Todo。已读取官方许可证、MAAD-Face论文分类、DiceBear固定源码及Schema、Avataaars选项/包约束；当时快照/URL在正文，未下载数据集或复制代码。结论为推荐参考机制而非安装四包，MAAD-Face许可/来源义务须按实际复制核对，CelebA图片/标注/衍生数据不导入商业产品；图片版权不由数据/软件许可代替，法律适用未作保证。资料补充原工单，不替代原需求或历史成果；应用仍v0.42.3、尚未实现新词库。可读性/入口检查通过，非关键辅助文件不重复校验，无新增私有图片公开授权。

- 新链路落地与付费验收授权（2026-10-05用户文字，无新附件/原文件名，资料v1.1.0）：原话“开始落地执行。并且做付费验收。”，video-api-debugger；关键词：意图理解、胡须词库、缓存、四宫格、有限付费、部署。完整E1/E2/E3及授权边界在[子Todo v1.1.0第8节](../../tasks/todo/2026-10-05-avatar-intent-generation-flow.md#8-授权落地与付费验收2026-10-05)。用户已明确授权收费，主动告知最小1次分析/1图最多5点、文字金额未知，不以可选预算问询重复审批或扩大授权。前轮方案、预检6235及窗口停止为历史，不把旧图冒充新结果；本轮实际完成与证据见下条。正文/旧附件入口可访问，归档在正式根，不用正式根旧源码部署。

- 新链路实施、修复及真实付费A2证据（2026-10-05主控/lead现场形成，无新用户附件，资料v1.1.0）：video-api-debugger；关键词：真实LLM、背景单值数组、胡茬分类、自有词库、四宫格、免费重检、实扣5点、刷新。初批[实施报告](2026-10-04-controlled-avatar-generator/2026-10-05-intent-implementation/delivery.json)与[最终修复/逐文件报告](2026-10-04-controlled-avatar-generator/2026-10-05-intent-implementation/repair-0.43.1/delivery.json)、[统一源码diff](2026-10-04-controlled-avatar-generator/2026-10-05-intent-implementation/repair-0.43.1/integrated-source.diff)来自实际应用worktree，最终报告复制字节一致；初批77项、修复批70项、复用29组件，失败批保留。当前v0.43.1/738a7fc/BUILD by14yomS4fR8tZH8zSdLV发布/健康/远端Git/回退有证据。自有词库及来源边界，不导入数据集/新依赖。
  [安全付费回执v1.1.0](2026-10-04-controlled-avatar-generator/2026-10-05-intent-paid-acceptance/receipt.json)保留首次v0.43.0真实422，最终同原回复免费重检1次成功、文字仅1次、唯一新任务成功；精确任务账本5点冻结→5点成功结算、6230→6225、冻结清零，没有双扣。原生[contact-sheet-result.png](2026-10-04-controlled-avatar-generator/2026-10-05-intent-paid-acceptance/contact-sheet-result.png)1024² PNG可读/目视四格各1人、短发胡茬无眼镜日常服装干净背景，关键SHA/四份UI年龄35/39/32/36在回执；[task-ledger.txt](2026-10-04-controlled-avatar-generator/2026-10-05-intent-paid-acceptance/task-ledger.txt)及reloaded-grid1/2、grid3/4为账本/刷新/格信息原始DOM，身份仅本机。[result-page.png](2026-10-04-controlled-avatar-generator/2026-10-05-intent-paid-acceptance/result-page.png)可读但卷动只展示主图下半及控件/缩略图，不代替完整原图。原文件名不变，来源均BrowserSkill正常授权页面/原生下载，正式目录保留；没有新用户原图素材，生成图用途为本轮验收，不是第三方数据集素材。
  私有原[rows.private.json](2026-10-04-controlled-avatar-generator/2026-10-05-intent-paid-acceptance/rows.private.json)为限定合成描述2行只读回复，mode600/字节一致/JSON可读；[analysis-background-error.png](2026-10-04-controlled-avatar-generator/2026-10-05-intent-paid-acceptance/analysis-background-error.png)保留首轮失败现场，但错误横幅由DOM证明。图片/身份/原回复/原始DOM只在本机，不公开Git；安全JSON报告与diff聚焦提交。此项补充而非替代旧方案/旧付费证据；文字现金费、原故障描述、精确Default物理profile和真实旧客户端更新弹窗仍未知，A1/A3未收费测试，不冒称全面验收或法律保证。

- 手机大图返回与人物描述主依据（2026-10-05用户文字，无新附件/原文件名，资料v1.0.0）：video-api-debugger；主题/关键词：手机返回、大图关闭、History、人物文案、可选条件、未指定随机。原话及B1/B2/C1完整目标、授权和手动验收边界在[固定子Todo v1.2.0第9节](../../tasks/todo/2026-10-05-avatar-intent-generation-flow.md#9-手机返回与描述主依据2026-10-05)。v0.43.2/03aa5e8已部署：仅图片返回关闭入口、描述主输入与可选补充；未指定不是解析失败，主动选择/旧现场/收费确认保留。候选类型/lint、789源码、公网版本及两份目标资源检查通过，手机和新文案效果待手动验收，费用0。已核安装Next14实际源码及MDN/Next14官方依据，不加依赖；异常卸载同页历史和发布漏等push确认的取舍/执行问题在报告留痕，远端及回退点已补核。[正式交付](2026-10-04-controlled-avatar-generator/2026-10-05-mobile-preview-back/delivery.json)、[源码diff](2026-10-04-controlled-avatar-generator/2026-10-05-mobile-preview-back/source.diff)、[公网证据](2026-10-04-controlled-avatar-generator/2026-10-05-mobile-preview-back/server-public-proof.json)及必要日志正式归档、关键复制一致性核对；其余可再生辅助资料不逐项校验。既有原需求/同行恢复截图/前批四宫格与付费原件由同一工单链接，无新图片或公开媒体授权；旧图不能充当新交互验收。

### 微信脸型库参考（2026-10-04）

- 资料名称：《GPT Image 2.5 做 Seedance 2.5 角色脸型库：20 张提示词全公开，附 220 张完整版》；作者远见明察，页面显示2026-09-11 01:55（时区未注明），接收日期2026-10-04。来源为用户提供[原文链接](https://mp.weixin.qq.com/s/Tr6hAKdY-AJw1vK8c63n7Q)，原文件名不适用。
- 正式登记：[出处、阅读范围及对照建议](2026-10-04-controlled-avatar-generator/wechat-face-library-reference.json)，资料v1.0.0；本条是外部方法参考，不替代原30节需求、12条补充或工单，建议未批准。只保存链接、出处和自有分析，不复制作者整篇正文/提示词库/配图。
- 主题/用途：人物差异、骨相组合、身份/造型/镜头分层、基准参考图、同人复用；用于完善受控随机头像方案的候选差异与人物保存判断，不自动扩展首版范围。
- 摘要与建议：已有方案覆盖结构关联、特征预算和参考图；可再考虑结构组合分层抽样、统一头像取景、稳定基准图及版本、固定身份摘要，用户手动分别检查不同人的差异和同人的保留。多角度角色素材包留后续按需能力，不默认增加候选生成费用或常驻分类按钮。
- 边界/校验：Chrome正文方法及示例已读取，公开20例只抽样，220型完整版未获取；无生图和全图差异验证。毫米级定位、平台65%相似阈值、文中型号及绝对成败说法未独立核实，不写硬规则；不强制人人有疤/痣，不改变用户明确条件。JSON与入口在交付前核对可读；无用户附件原件缺失，无作者素材商用授权证据。
- 技术核对：[IP-Adapter仓库及实际源码](https://github.com/tencent-ailab/IP-Adapter/blob/main/ip_adapter/ip_adapter.py)已读，代码Apache-2.0，只借鉴图文条件分离，不新增Python模型链路；[Diffusers复现文档](https://huggingface.co/docs/diffusers/using-diffusers/reusing_seeds)支持区分随机复现和身份保存。未安装或运行；更多限制见正式登记。

## 主图导航与视频参数反馈工单（2026-10-03）

项目video-api-debugger；2026-10-02后台两条原文见下节。2026-10-03追加/generate三参数灰色，随后明确取消三参数业务锁（模型合法范围保留），新增I5模板上下文未修改关闭及同类误提醒，I6多任务待确认只读排查。I1-I5已部署v0.36.3，最新运行源码8315f02776290cda1c0f1e7286856d193f95dfca、BUILD TIe6lesNJcjyQirM3FMpx；I3模板导航状态按surface/user本地持久化、迁移旧session记录；[发布证据](../../tasks/todo/2026-10-02-feedback-primary-navigation.evidence.json)/[统一diff](../../tasks/todo/2026-10-02-feedback-primary-navigation.diff)正式归档；最新候选内置检查及4服务/20相关静态/2变更源码一致通过，首次27静态/20源码证据为历史，功能待用户手动验收。I6故障阶段已明确、底层原因无法追溯待查；视频标注原件仍待归档，不称W1附件齐全，反馈new不改。

| 资料/原名 | 来源/日期/版本 | 主题与用途 | 正式入口、关系与校验 |
|---|---|---|---|
| 主图与导航反馈优化；2026-10-02-feedback-primary-navigation.md | 后台原文/用户追加；2026-10-03创建；v1.0.0 | 主图约+30%、满额添加位、小屏导航、视频三参数误锁；边界/手动验收/附件/交接正文 | [正式工单](../../tasks/todo/2026-10-02-feedback-primary-navigation.md)；可读；历史规则见10月1日原文；工作树非唯一资料位置 |
| feedback.json及48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg | 2026-10-02；快照v1.0.0/原图 | 两条原文与导航参考，不作验收图；无音视频 | 下节原路径/校验保留；工单有绝对路径；raw/原图不公开Git |
| 视频三参数用户截图（原名未知） | 2026-10-03用户会话；原版本未知 | /generate三chip灰色；DOM/模型/输入事实完整记工单；非自动浏览器证据 | 仅父会话可见，无path/attachmentHandle；待主控导出到docs/materials/2026-10-03-feedback-video-parameters/；原件未归档/未校验，不伪造已保存 |
| codex-clipboard-4f833484-e649-4fac-9224-20a130ea6102.png | 2026-10-03用户剪贴板截图，原件/原名保留；父归档 | 图片模板img2.5-S最高4K多次待确认；用于I6故障阶段核对，不据图定Provider失败，与上条缺原件截图不同 | [原件](2026-10-03-feedback-generation-results/codex-clipboard-4f833484-e649-4fac-9224-20a130ea6102.png)；895x725 PNG，父sips可读/复制SHA256一致2fc4dcf6bbe59df8e36f836a1d1da658cd66c6f56f028ee50aee57769a5ccd02，复用校验；私有不上传Git |
| I4取消锁/I5未修改关闭/I6事故对话原文及只读结论 | 2026-10-03当前用户；工单v1.0.0补充 | 最新指令替代旧ratio_locked保留结论；两异常为request/network与request/timeout约300秒，无返回回执，异常后同模型有成功记录；底层网络/上游原因未确证 | [正式工单最新段](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#最新纠偏与i6事故证据2026-10-03北京时间0049核对)；原文、线上commit/BUILD及缺口已登记，无生产数据写入 |

## 当日后台反馈（2026-10-02）

项目video-api-debugger；2026-10-02 23:07北京时间从正式SD2生产Feedback表只读拉取，覆盖北京时间当天00:00至次日00:00全部状态，截至读取时共2条，均为new。仅整理资料，不实施、归档反馈或修改生产数据；本地记录v1.0.0，原文JSON和截图仅本机保留，不公开Git。无音视频附件。

| 资料与原文件名 | 来源/日期/版本 | 主题、摘要及用途 | 正式入口、关系与校验 |
|---|---|---|---|
| 反馈原文汇总；feedback.json | 正式SD2后台Feedback，2026-10-02接收；v1.0.0首次快照 | 两条图片模板工作台意见；保留反馈ID、原文、准确时间、页面、状态及附件地址，供后续需求核对，不代表问题已复现 | [原文](2026-10-02-feedback-template-workbench/feedback.json)；JSON可读；不替代历史工单或自动授权实施 |
| cmuqyowne0027vg4vr3xyks6m；无附件 | 2026-10-02 20:51:09北京时间；new | 主图缩略图增大约30%；锁定张数后不再显示添加主图图标。来源/template-studio?type=image | 完整原文见上述JSON；需求已收到，尚未实施；关联历史主图规则需另行核对 |
| cmuqyq5xo002fvg4vjhbp6aar；48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg | 2026-10-02 20:52:08北京时间；new；原名/原件保留 | 手机与平板导航条难以使用，截图为问题参考，供后续核对小屏导航，不作修复验收证据 | [截图](2026-10-02-feedback-template-workbench/48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg)；来源https://sd2.youdooart.com/uploads/assets/48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg；本地与服务器SHA256一致且等于文件名，415273字节、2584×1828 JPEG已打开核对；未复现或验收生产页面 |

## 模板工作台体验优化（2026-10-02）

项目video-api-debugger；历史工单v1.0.0已被2026-10-02用户明确WS1-WS7实施授权更新。源码、统一发布检查及安全部署已完成，v0.36.2；源码f647817、BUILD OlWyIuDDh1fBfDOaID4Tt，4服务/21公网静态/15源码一致，worker未重启，功能待人工验收；只调整/template-studio图片与视频工作台，独立图片页由默认门控保留，不改后台/权限/费用或Provider。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 模板工作台体验优化工单；2026-10-02-template-workbench-ux.md | 用户先要求工单、后明确实施；v1.0.0 | WS1-WS7、逐文件实现、状态/目录缺口、当前进度与人工边界 | [完整正文](../../tasks/todo/2026-10-02-template-workbench-ux.md)、[发布证据](../../tasks/todo/2026-10-02-template-workbench-ux.evidence.json)；UTF-8/JSON可读，正式正文与开发树同步，已部署待人工 |
| 加载样例与desktop/dark/mobile.png、interaction.webm | 既有认可样例，非新附件 | 刷光参考；0–7.8秒全部195帧父侧观察复用，不作生产验收 | [样例](2026-10-02-loading-study/index.html)、[已有媒体](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-loading-study/evidence/)；关键入口可读，媒体沿用既有校验，不公开Git |
| 加载、模板弹窗与图片恢复历史工单 | 已交付历史，不替代当前范围 | 保留既有状态、关闭/未保存保护及后台恢复边界 | 原文及已有附件路径完整列于本工单；已按需读用，不冒充旧附件全部补齐 |

## SD2加载与体验优化实施（2026-10-02）

项目video-api-debugger；2026-10-02用户明确执行U1-U6，替代历史仅文档状态。源码实现、统一发布必需检查与安全部署已完成，v0.36.1；源码8acaf46、BUILD Ec6Hfe91C-vrdLDtYaCKN，4服务/40公网静态/24源码一致、worker正常排空。功能待用户手动验收。唯一工单v1.0.0内容按授权更新，不新建平行方案。

| 资料 | 来源与版本 | 主题/用途 | 正式入口与校验 |
|---|---|---|---|
| SD2加载与体验优化工单；2026-10-02-loading-ux.md | 用户盘点后明确执行；v1.0.0实施记录，应用v0.36.1 | U1-U6状态、局部刷光、产品弹窗、近时、逐文件实现与发布/人工边界 | [完整正文](../../tasks/todo/2026-10-02-loading-ux.md)、[发布证据](../../tasks/todo/2026-10-02-loading-ux.evidence.json)；UTF-8/JSON可读，正式根目录同步，人工待验收 |
| 已认可加载样例 index.html及desktop/dark/mobile.png、interaction.webm、report.json/check.cjs | 既有样例v1.0.0，原件复用 | 动效与布局参考；完整短片0–7.8秒/195帧25fps、无音轨，不作生产证据；脚本不执行 | [正式本地资料](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-loading-study/)；关键入口沿用已核验原件，图/视频不公开Git |
| 既有用户画布原图及关联图片恢复/模板工单 | 来源与替代关系见原条目；无新附件 | 原始参考、避免重做已closed恢复后台实现 | 完整原件路径列在工单附件表，本地保存，不公开或外发 |

## 图片生成与原图恢复补充（2026-10-02）

项目：video-api-debugger。主题：GPT图片、生成幂等、Base64、原图续传、完整校验、透明输出、任务交付。2026-10-02用户由仅工单改为明确执行；有效v1.1.0 ID1-ID4已实现并部署v0.36.0，待人工。最终源码afc4489、BUILD vNT0S5yAGwiHTBok0KVLe，4服务/25公网静态/14源码一致，原请求查询已从新生成条件解耦、worker正常排空；无付费生成、功能/离线/浏览器验收、生产库写入。原图仍未救回，透明请求无确证不开放、已退款终态不自动领图。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 原图恢复补充工单 | 既有下载超时工单顶部更新；2026-10-02补充v1.1.0，用户确认执行 | ID1-ID4逐文件实现、未知受理/同图恢复/校验/状态、发布回退与人工验收；旧记录保留 | [有效正文](../../tasks/todo/2026-10-01-image-download-timeout.md)、[发布证据](../../tasks/todo/2026-10-01-image-download-timeout.evidence.json)；UTF-8/JSON可读，完整正文与开发树一致 |
| 用户参考脚本 | Untitled-1(1).md；来源/Volumes/Data/Downloads/Current/Untitled-1(1).md；2026-10-02接收，版本未知 | 一次生图、Base64优先、URL GET恢复、校验后交付；脚本有已注明局限，未执行，不公开Git | [原件](2026-10-02-image-delivery/Untitled-1(1).md)；复制后cmp核对、文本可读 |
| 历史官方协查回执 | 2026-10-01-image-download-api-receipt.md；v1.0.0；2026-10-02从canvas-liblib-layout工作树归档 | 两次上游请求、消费匹配、下载超时证据及协查事项；只作历史参考，不公开Git，不重复外发 | [原件](2026-10-02-image-delivery/2026-10-01-image-download-api-receipt.md)；复制cmp一致、正文可读 |

历史问题截图原件仍无可访问入口，不用其他截图替代；协查回执原件已归档并修正工单链接，不把它说成全部历史附件齐备。已核对本轮服务/版本/静态发布，未恢复旧图、未回写账本；源码与发布检查不等于真实交付功能验收。

## 模板主操作与产品弹窗（2026-10-02）

项目：video-api-debugger。来源：用户“同时修改并部署模板相关页面”、已确认暗色青绿色设计与现有源码。主题：主按钮、模板、保存、生成、产品弹窗、未保存保护、发布；本轮无新附件。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 模板主操作与产品弹窗 | 2026-10-02 用户授权；实施记录，已部署 v0.34.2 | G1–G4任务、入口覆盖、取消/草稿保护、构建、远端回退及32项公网静态证据；已有原图及历史反馈入口包含在正文中 | [完整正文](../../tasks/todo/2026-10-02-template-primary-actions.md)、[发布证据](../../tasks/todo/2026-10-02-template-primary-actions.evidence.json)；UTF-8/JSON可读，应用工作树副本同步；待用户手动验收 |

## 加载刷光独立样例（2026-10-02）

项目：video-api-debugger。来源：用户要求统一 loading/生成中动效并独立测试。主题：刷光、骨架屏、按钮等待、阶段状态、减少动画。样例版本 v1.0.0，不接生产接口，不代表正式网站已经采用。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 独立交互样页 | 本轮打样；index.html；v1.0.0 | 首次加载、刷新保留原内容、提交、模拟上传和生成阶段；周期/亮度/主题可调，设置保存，真实系统减少动画偏好优先 | [样例](2026-10-02-loading-study/index.html)；Playwright 本地独立检查 PASS，桌面/390px截图已查看 |
| 样例检查脚本 | check.cjs；2026-10-02 | 仅本地文件：动效、状态切换、防连点、恢复、390px 布局与减少动画；无真实生成或生产验收 | [脚本](2026-10-02-loading-study/check.cjs)；检查结果见同目录 evidence/report.json |
| 参考原图 | 既有用户画布原图，未修改 | 作为列表及完成态样图，不冒充生成视频；沿用画布方案拆分资料归档 | [原件](2026-10-02-canvas-plan-split/codex-clipboard-1f20d528-af7d-4e00-b5b5-e1d90892de90.png)；复用已核验原件 |

设计借鉴 MUI Skeleton wave 的变换刷光与减少动画处理；已阅读官方文档及 Skeleton.js 实现，未引入 MUI 依赖或复制其组件。来源：https://mui.com/material-ui/react-skeleton/ 与 https://github.com/mui/material-ui/blob/master/packages/mui-material/src/Skeleton/Skeleton.js 。样例仅本地打开，未公开发布用户原图。

L1：加载动效独立打样，已完成。完成标准：可交互比较各状态，桌面/手机布局及减少动画模式检查通过。证据：同目录 evidence/report.json、desktop.png、dark.png、mobile.png 与 interaction.webm；仅本地保留。发现并修复完成态预览图越界遮挡，整批复测通过；无真实任务请求、无 JavaScript 错误、无外部网络请求。风险分级 L1：隔离样例，没有业务接口、权限或数据变化；未做线上功能验收或部署。

2026-10-02 用户认可上述loading样例，并要求处理既有技能和触发条件。已更新全局 /Users/gouki-youdoo/.codex/skills/loading-state-design/SKILL.md 为v1.1.0，统一局部刷光参考、异步等待自然触发、真实阶段和授权边界；配套可复用CSS及结构/链接/独立CSS检查通过。S1“更新加载状态技能”已完成：触发条件、刷光规范、真实状态和授权边界清楚，结构校验通过。认可样例及技能更新不代表本项目正式页面已接入，也不授权全站批量替换；样例自身仍为v1.0.0。技能完整规范留在技能内，此处只登记来源与项目认可事实。

## 画布视频方案拆分（2026-10-02）

项目：video-api-debugger。来源：用户原工单、画布截图、本侧聊提示词格式及简化讨论。主题：方案拆分、提示词、视频节点、参数继承、任务恢复、结果选用。v0.35.0 已部署；SP1–SP5 已实现并部署待人工，SP6 发布检查与正式归档完成；assetId 如实 null，不创建 Asset。完整发布与回退记录见[原工单](../../tasks/todo/2026-10-01-canvas-plan-split.md)，逐文件 SHA 和检查见[发布证据](../../tasks/todo/2026-10-01-canvas-plan-split.evidence.json)。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 当前简化工单 | 2026-10-02 用户“补”后明确“落地”；v1.1.0 | 固定格式、单方案单视频节点、预览调整、保存、防重复、任务结果与人工验收；替代旧复杂首版；实际实施进度留原工单 | [有效正文](../../tasks/todo/2026-10-01-canvas-plan-split.md)；UTF-8 可读，关键原图复用已核验原件 |
| 历史原方案 | 2026-10-01 侧聊文件；原文件名 2026-10-01-canvas-plan-split.md；v1.0.0 | 原始结构化/AI/方案组设计，保留来源，已被 v1.1.0 替代，不作为当前实施规格 | [历史原件](2026-10-02-canvas-plan-split/2026-10-01-canvas-plan-split.md)；复制后 cmp 核对 |
| 用户画布原图 | 原文件名 codex-clipboard-1f20d528-af7d-4e00-b5b5-e1d90892de90.png；2026-10-02 归档 | 原节点及上下游场景参考；保留原名、未修改；本地资料，不公开 Git | [图片原件](2026-10-02-canvas-plan-split/codex-clipboard-1f20d528-af7d-4e00-b5b5-e1d90892de90.png)；复制后 cmp 核对，PNG 可读 |

原始来源目录：/Users/gouki-youdoo/.codex/visualizations/2026/10/01/01a0f7f9-21b0-79c2-abe7-9c479680591d/canvas-plan-split/。历史原件与当前工单分别保存，归档不授权实施或部署。

## 统一创作资源库（2026-10-02）

项目：video-api-debugger。来源：用户本轮风格广场截图、本站源码及既有工单。主题：素材库、图集、图片/视频模板、风格、生成交接、用户体验。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 功能盘点、审查及落地清单 | 用户要求；本轮侧聊更新；审查d08e9df，发布81de84c/v0.34.1 | I1–I3盘点、A1–A4审查及B1–B3/U1–U6实现与发布证据；待用户手动验收，统一目录未合并；含发布预约流程缺口 | [完整正文](../../tasks/todo/2026-10-02-unified-resource-library.md)；与侧聊副本cmp一致、可读 |
| 风格广场原图 | 用户截图；原文件名codex-clipboard-c227fe09-9c94-47d3-9259-224ace6380d7.png；2026-10-02接收 | 分类、收藏/最近、商业授权与选用流程参考；PNG原件，未修改；不公开Git | [原图](2026-10-02-unified-resource-library/codex-clipboard-c227fe09-9c94-47d3-9259-224ace6380d7.png)；与已核验来源cmp一致、PNG可读 |
| 同图新增素材库入口设计反馈 | 2026-10-03用户剪贴板；本次原文件名codex-clipboard-fdeeedfb-713b-4667-8d6d-e6b73cca8e4e.png，原件v1；与上方原图完全相同，复用、不建重复副本 | 项目video-api-debugger；关键词直接开库、库内上传、分类、收藏、最近、搜索；新需求不替代旧参考图。入口直接库及库内上传为用户明确要求，其余为设计建议；[完整设计v1.1.0](../../tasks/todo/2026-10-02-unified-resource-library.md#9-统一添加入口与素材库设计2026-10-03) | [复用原图](2026-10-02-unified-resource-library/codex-clipboard-c227fe09-9c94-47d3-9259-224ace6380d7.png)；两份来源SHA256一致60f976ac3aafc8e52dd4e24f590f4cc0f89fe37c5fa6eb9705c4479cc4e349b4，PNG可读，仅本地保留；本轮未改应用 |
| 本站原有分类评估与重设计 | 2026-10-03用户追加要求；设计v1.2.0修订v1.1.0的分类建议，旧草图保留，不代表分类迁移已批准 | 项目video-api-debugger；关键词类型、来源、项目、图集、模板分组、内容/用途标签。保留真实旧分组、分层展示，不照搬截图分类；默认组与接口源码已核对，生产自建组/使用频率未采集，新标签未实现 | [分类完整方案](../../tasks/todo/2026-10-02-unified-resource-library.md#99-原有分类评估与重新设计2026-10-03)，文档可读；仅设计及记录，未改应用/数据或重新生成图片 |
| 素材库整合设计预览 | 2026-10-03用户要求生成图片；内置image_gen产出，原文件名exec-d74cc97f-9304-4981-aa45-96465ee424fb.png，保留原始生成文件；预览v1，不替代上方用户参考原图 | 项目video-api-debugger；关键词库内上传、搜索、收藏、最近、来源、已选区。虚构示例素材与数量，不是实机截图、功能验收或用户认可结果；[预览记录](../../tasks/todo/2026-10-02-unified-resource-library.md#97-界面图片预览2026-10-03) | [设计预览](2026-10-03-unified-resource-library/asset-library-design-v1.png)，1448x1086 PNG可读；原始产物与归档SHA256一致22156f36940da0d3d4109da7550cab0844224a7592162084410140106cb008f1；仅本地归档，不公开Git或部署 |
| 视频参考素材库整合预览 | 2026-10-03用户要求生成一张；内置image_gen产出，原文件名exec-2be5dbf4-25da-4b0c-870f-75a269447e4c.png，保留原始生成文件；视频版预览v1，与图片版配套，不替代用户原图 | 项目video-api-debugger；关键词图片/视频/音频、搜索、收藏、最近、库内上传、有序已选。示例素材/时长/数量，非实机截图或模型规则验证；[预览记录](../../tasks/todo/2026-10-02-unified-resource-library.md#98-视频参考素材窗口预览2026-10-03) | [视频版预览](2026-10-03-unified-resource-library/video-reference-library-design-v1.png)，1448x1086 PNG可读；原件与归档SHA256一致91f14a64b77e74fd150982739763db3c072777b58a82ea60f239f5d8deedf724；仅本地归档，不公开Git或部署 |
| 新分类视频参考素材库预览 | 2026-10-03用户要求重新生成；内置image_gen产出，原文件名exec-7c52b3b7-463f-4bd6-9fe9-541358411200.png，原件保留；视频版v2对应设计v1.2.0，旧v1保留对照 | 项目video-api-debugger；关键词图集/项目导航、类型/来源分离、库内上传、收藏/最近、已选。名称、目录、素材及数量为示例，未改线上分类；[预览记录](../../tasks/todo/2026-10-02-unified-resource-library.md#910-新分类布局预览2026-10-03) | [新版预览](2026-10-03-unified-resource-library/video-reference-library-design-v2.png)，1448x1086 PNG可读；原件与归档SHA256一致a4765abe61c2639916511d57ad42b9dec6dea5e34cd788b7c81d6edb8e647aca；仅本地保存，不公开Git或部署 |
| 模板素材与弹窗反馈 | 2026-10-01历史工单，来自同一侧聊工作树 | 固定素材权限和三分区边界；不是本次新bug | [历史原文](../../tasks/todo/2026-10-01-feedback-template-assets-dialogs.md)；副本一致，关联旧附件未逐项复核 |
| 图片下载超时 | 2026-10-01历史工单 | 原图失效、慢速源站与恢复缺口 | [历史原文](../../tasks/todo/2026-10-01-image-download-timeout.md)；副本一致 |
| 复制分享及离开提醒 | 2026-10-02历史工单，v0.34.0 | 已部署能力及待用户验收边界 | [历史原文](../../tasks/todo/2026-10-02-media-copy-share.md)；副本一致 |

本索引只覆盖本次归档，不冒充全项目资料已收齐。完整正文从侧聊工作树复制到正式根目录；历史原文保留版本，不替代当前应用源码。旧工单关联附件中已有5个缺失入口仍未恢复，不能将历史文档归档理解为全部旧附件已校验。

## 模板保存与最新生成异常（2026-10-03）

项目：video-api-debugger。来源：用户本轮剪贴板截图及明确确认。主题：保存按钮、主图最多1张、待确认、HTTP 502。原件仅本地保存，不公开Git或部署；完整要求及实施进度见[既有工单](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#图片模块保存位置主图默认与g1诊断2026-10-03)。

| 原文件名 | 摘要、用途与版本 | 正式入口与校验 |
|---|---|---|
| codex-clipboard-03172503-81ea-4c23-a3cd-35b17c7ad922.png | 2026-10-03用户截图；保存按钮在表单底部紧贴选项；N1位置参考。N2已确认默认主图最多1张，不是结果张数；原件v1，无替代关系 | [原件](2026-10-03-feedback-template-save-default/codex-clipboard-03172503-81ea-4c23-a3cd-35b17c7ad922.png)；737x936 PNG可读；原件/副本SHA256一致a7ab662013168aa6958ff9ed67dcf66eb65190210a76f417510e19e0c3b985d4 |
| codex-clipboard-9f700e16-f9d4-4e3c-a789-503a78fa5a19.png | 2026-10-03用户最新截图；两条img2.5-S最高4K结果待确认；G1只读诊断参考，更新事故时段、不替代凌晨原图；原件v1 | [原件](2026-10-03-feedback-generation-results/codex-clipboard-9f700e16-f9d4-4e3c-a789-503a78fa5a19.png)；572x470 PNG可读；原件/副本SHA256一致b91dcb90d0b60b33cc8fa287050a2d8b01c1f356d08e8290a35886c7b13789b0 |

10:04-10:06北京时间只读核对：本批3条请求10-12秒后收到生成接口HTTP 502、无原图；队列未重启，配置9月22日后未更新。本轮未重发、不修改任务/账务/Provider；502内部原因未知。截图不含任务ID，不将截图与某条任务强行一一对应。

### 图片生成重复确认反馈

2026-10-03用户明确不需要截图中的重复提醒。来源：用户剪贴板；主题：确认生成、旧待确认记录、误触发、恢复设置。属于R1修复，不是此前I5未保存关闭提醒；[完整原文和进度](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#r1图片生成重复确认2026-10-03)。原件v1，无替代关系，仅本地保存。

[codex-clipboard-f5514b6f-ae53-432d-bb56-8ddb68123c16.png](2026-10-03-feedback-generation-confirm/codex-clipboard-f5514b6f-ae53-432d-bb56-8ddb68123c16.png)：生成图片时“确认生成/新建生成任务”弹窗，说明可能再次产生上游费用。795x751 PNG可读；原件及副本SHA256一致29f2362016356ef7c8b548065296dc564b02188e19982bf5cb6164065465eb3f。不能从截图推断用户改了任何设置。

2026-10-05追加“不要反复确认/生成按钮放参考图下方、补充文案上方”，随后明确随机人物“写了正文，就按正文理解直接出”（用户当前对话文字，无新附件/原文件名，资料v1.1.0；替代本条先前仅模板移位范围）：video-api-debugger；关键词：D1/D2/D3、生成图片、按钮位置、参考图、补充文案、正文理解、一键出图、直接提交。完整原话、实际模板共用入口、费用/未知受理/未保存保护、源码及React来源、发布检查与手动验收边界见[同一工单v1.1.0 D1/D2节](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#d1d2图片生成按钮位置与重复确认2026-10-05)；人物普通分析/报价分层确认由一次显式生成替代，输入本身不生成、变价/缓存/失败/未知及旧草稿保护见[人物工单v1.3.0第10节](../../tasks/todo/2026-10-05-avatar-intent-generation-flow.md#10-人物正文一键出图2026-10-05)。已部署v0.43.3/0941beac/BUILD D7veEEW5tSA1MsaVkxWwm，D1/D3已源实现、D2发布检查完成，实际布局/一键出图待用户手动验收。最终候选内置类型/lint、789源码、3新chunk与公网版本/回退/远端先核后切通过，worker未重启；费用0，无新增付费/浏览器验收。正式根[逐文件交付](2026-10-05-generation-toolbar/delivery.json)、[最终统一diff](2026-10-05-generation-toolbar/unified.diff)、[源码自查](2026-10-05-generation-toolbar/source-review.json)、[公网证据](2026-10-05-generation-toolbar/server-public-proof.json)同目录归档，关键报告/diff复制一致性核对；旧候选source.diff单独保留，辅助headers/脚本本机不逐项哈希。原始v0.43.3标签保留初候选，实际release/v0.43.3-avatar-one-click-final指最终0941，细节见工单。沿用上方R1原图及原校验，仅作为旧提醒参考，不当新布局/一键效果证据、不公开媒体或原模型回复。

### 激活点赞收藏图标常显（2026-10-05）

资料名称：激活点赞收藏图标常显需求；接收2026-10-05；来源为用户当前对话文字，原文件名不适用，无新附件；项目video-api-debugger；关键词：E1/E2、左上角、点赞、收藏、激活、悬停、ContentReactions。完整原话：“点过赞的或者收藏的左上角的激活图标固定，不因为鼠标没移上去而消失”。资料v1.0.0，为新增显示规则，不替代既有点赞归属/收藏私密/权限或数据要求。

用途：只在媒体卡共用覆盖层使真实已激活图标常显，未激活按钮仍按原悬停/聚焦/触屏规则；完整范围、源码根因与进度见[同一工单v1.2.0 E1/E2](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#e1e2激活点赞收藏图标常显2026-10-05)。正文与当前源码可读性已核，无新用户文件需要复制；已部署v0.43.4/3fae527/BUILD d3AOx5AwMdobt6iDbMTL0，E2候选内置检查及公网新共享CSS/版本/服务、回退/远端先核后切通过。仅四份应用文件，无数据API/DB/权限改动；费用0，worker未重启，真实鼠标移开及取消/触屏效果待用户手动验收，不以CSS/构建检查冒称实演。正式证据目录为`/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-05-active-reaction-icons/`：[完整报告](2026-10-05-active-reaction-icons/delivery.json)、[统一源diff](2026-10-05-active-reaction-icons/source.diff)、[源码自查](2026-10-05-active-reaction-icons/source-review.json)、[候选](2026-10-05-active-reaction-icons/candidate.json)、[公网新CSS](2026-10-05-active-reaction-icons/public.json)、[远端refs](2026-10-05-active-reaction-icons/remote-refs-proof.json)、[运行与回退](2026-10-05-active-reaction-icons/runtime.json)。执行者已停止，冻结完整95份文件已复制至正式根，九份关键报告/diff字节一致且版本/BUILD相符，diff对应真实部署前后Git树；辅助日志/脚本按风险复用，不逐项哈希。资料v1.0.0及来源不变，无替代私有原图/先前人物工单，原构建警告与初步refs日志差异见完整报告，不公开私有媒体或凭据。

### 弹窗位置反馈

2026-10-03用户明确要求“弹窗不要弹角落，要弹就弹在触发按键范围附近”，归属video-api-debugger；关键词：P1、角落、按钮附近、确认框、命名框、小屏、键盘。复用上方R1原件v1，来源和原文件名不变、无替代版本；截图左上角弹窗为定位参考。文件未变，复用可读性/完整性校验。[既有工单P1](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#p1统一弹窗定位2026-10-03)记录范围与进度；原图仅本地不公开。

### 文案GPT模型真实连通测试

2026-10-03用户纠正测试范围为“文案类gpt模型测通”，在费用说明后明确要求直接执行。北京时间13:34:51-13:35:18以正式服务器现有适配器逐项真实请求，6/6成功；主题/关键词：T1、GPT-5.5、GPT-5.6 Luna/Sol、GPT-6 Luna/Sol/Astra、json_object、1265 tokens、零重试。来源是本轮实际API诊断，不是用户截图或静态推断；[完整记录](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#t1静态核对与真实测试结果)及[结构化证据textConnectivity](../../tasks/todo/2026-10-02-feedback-primary-navigation.evidence.json)。v0.36.6运行源码不变，生成证据可解析并已核对6项返回模型名/格式，不含凭据或用户私有内容；替代此前T1未执行状态，不替代P1手动页面验收。实际费用未知，不含长文案、队列或浏览器全流程测试。

### 模板上下文复制粘贴

2026-10-03用户文字要求在模板上下文输入框上方加复制和粘贴按钮，归属video-api-debugger；关键词：C1、复制全文、粘贴文本、光标/选区、输入框上方、上下文权限、字数上限。没有新附件，复用[模块上下文原图](2026-10-03-feedback-template-save-default/codex-clipboard-03172503-81ea-4c23-a3cd-35b17c7ad922.png)，原件v1和既有来源/校验不变，无替代关系、不重复校验或公开原图。[固定工单C1](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c1上下文复制粘贴2026-10-03)记录实现及发布/手动验收范围。

### 外部账号视频封面费用

2026-10-03用户文字反馈，项目video-api-debugger，资产管理/assets，主题C2、外部账号、本站生成视频、封面标价、真实扣点/现金区分。无新附件；账号邮箱不复制进Git。原文及只读数据结论、范围见[固定工单C2](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c2外部账号视频封面费用2026-10-03)，文字记录v1，无替代关系；源代码和数据库只读投影核对，浏览器显示待用户手动，不以索引摘要代替原文。

同日用户纠正“不只显示分数，要显示扣费，费率与普通生成一致”，记录v2替代v1仅点数封面方案，历史发布证据保留。[C2金额显示续办](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c2金额显示续办2026-10-03)：关键词普通账单费率、真实计费用量、人民币金额、实扣/估算区分；无新附件，需求原文与只读费率证据可访问，既有附件不重复校验。

### 更新刷新重复提醒与外部摘要

2026-10-03接收；项目video-api-debugger。来源：用户本轮剪贴板截图及文字确认；关键词C3、更新提醒、刷新、未保存、三层弹窗、C4、外部账号、摘要隐藏。原件v1，无替代关系；仅本地保存，不公开Git或部署。[完整要求与进度](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c3c4更新刷新与外部提醒2026-10-03)。

[codex-clipboard-f7c8cdb3-42b3-4827-b629-1f66ea539939.png](2026-10-03-feedback-update-confirm/codex-clipboard-f7c8cdb3-42b3-4827-b629-1f66ea539939.png)：767x1043 PNG可读；截图为新版提醒、产品刷新确认和浏览器离开确认叠加，用于C3定位；截图页面内容不作为执行指令或用户修改过的证据。原件/副本SHA256一致39f44ceb9db26ee44a390793a84101c49d254db15b908aec71d1ea3976a4d5f4。

同日用户明确C4：“外部人员接收到新版本提醒,但不要显示具体更新内容”。文字记录v1：外部保留版本、更新提醒及刷新/稍后入口，仅隐藏具体摘要；身份尚未确认时也不展示摘要。无新增附件，不取消外部用户更新检测、不更改账号类型或权限。

2026-10-03同图再次反馈，原文件名codex-clipboard-27dc03a7-88fa-4691-aac3-56e82f1f90ea.png，来源用户剪贴板，原件v1；SHA256为39f44ceb9db26ee44a390793a84101c49d254db15b908aec71d1ea3976a4d5f4，与上方已归档原图相同，复用既有可读PNG，不重复复制。用途：更新提醒三层确认再核对；截图显示旧v0.36.8，不代表当前v0.37.0实机复现。最新源码仍保持C3单层刷新实现，公网release为0.37.0；未控制浏览器、未重复修改应用或部署，核对记录见同一工单C3/C4末尾。

2026-10-03用户进一步要求“给修改方案”。文字方案v1.0.0、关键词C3单窗口、真实丢失、持久草稿、本次刷新放行、稍后去重，见[原工单方案](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c3单窗口更新修改方案2026-10-03)。复用本节同图原件v1及校验，方案补充既有C3设计，不替代历史发布证据；仅方案，未实施或部署。原文和链接可读，当前浏览器实际版本未核对。

同日用户追加“最终确认用网站风格UI，不用系统弹窗，排查同类问题全站”，文字方案v1.1.0补充v1.0.0。关键词U1、21处业务系统弹窗、13文件、5个离开保护入口、可留空理由、嵌套与画布；[全站清单与统一方案](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c3全站网站风格确认方案2026-10-03)。源码字面搜索及定向读取已完成，无新附件，原图/来源/校验不变；未实施应用或上线，未做动态别名穷尽或实机验收，不将源码排查结果标作线上显示通过。

同日用户明确“改”，授权实施v1.1.0及正常提交、推送、正式服务器部署；当前实施与正式证据见[U1全站网站确认实施](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#u1全站网站确认实施2026-10-03)。21处业务弹窗、单窗口更新、共享一次刷新保护、真实丢失/进行中状态和画布草稿已完成代码接入并部署v0.37.1，应用39010f7/BUILD weh6ZSLi1ojK25-2vyXQm；构建与部署检查完成，功能待用户手动验收。正式根本机[统一代码差异](2026-10-03-feedback-update-confirm/implementation-v0.37.1.diff)涵盖本批28份应用文件，[发布检查证据](2026-10-03-feedback-update-confirm/deployment-v0.37.1.json)记录4入口、40静态SHA和28源码一致性；可读、版本与提交对应，辅助证据不重复逐项哈希。用途：本轮交付、恢复及手动验收定位，替代此前“应用未实施”当前状态，不删除历史记录。不新增或复制同图，原件及SHA校验复用；素材和本机证据目录不Git上传或部署。

### 统一素材库批准实施

2026-10-03用户最新明确要求“按照最新的设计落地”，项目video-api-debugger，资料版本v1.2.0设计，应用交付v0.37.0；关键词：L1–L3、统一素材库、库内上传、类型/来源分离、真实项目图集、收藏、最近选用、全范围搜索、有序选中、候选发布。正式根原图[video-reference-library-design-v2.png](2026-10-03-unified-resource-library/video-reference-library-design-v2.png)用于桌面布局，1448x1086 PNG已有可读/一致性证据，本轮已view_image，不重复哈希；原件仍私有，不Git上传或部署，无新附件。v2替代视觉v1，§9.9分类设计v1.2.0有效。[固定工单§10](../../tasks/todo/2026-10-02-unified-resource-library.md#10-最新设计实施与发布2026-10-03)记录源码、授权边界、发布检查及手动验收缺口；正式根只同步记录，不覆盖旧应用或无关dirty todo。

同日已部署v0.37.0，应用6d2f390/BUILD JmPs7-sSzCKO0_LJ_YKrJ，候选内置检查、self Review、远端回退tag、公网版本/新静态/健康与持久数据保护有据；待用户手动验收。L2部分完成：use-only且无原图下载权限的共享/公共图片暂不支持图片工作台，窗口逐项解释并禁选；本人task-only视频已有正常下载GET→上传适配，不启动交付队列。正式根本机[统一代码差异](2026-10-03-unified-resource-library/implementation-v0.37.0.diff)仅含本批14个应用文件，原图不变，差异可读；Git中使用工单所列commit入口，不重复上传私有素材目录。

### 导航与媒体封面交互

2026-10-03本轮用户浏览器评论及文字需求，项目video-api-debugger，文本v1；关键词C5/C6/C7、固定顶栏、单击恢复/双击放大、视频卡内播放、查看靠右、封面左上点赞收藏。原文、1068x871标记及实现/同类分类见[固定工单C5-C7](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c5-c7导航与媒体封面交互2026-10-03)。浏览器评论截图1/2仅在聊天可见，原文件名/本地路径未提供，待补持久原件；未归档、可读/完整性未核验，不用旧U1截图或自动截图代替。截图v0.37.0不表示当前正式应用回退。北京时间2026-10-04 00:10:42已发布v0.37.2，应用fb630d8/BUILD zCelY_zSjwH6rS-xpfzLN，C5/C6/C7均已部署待用户手动；不因换日再升级，不替代旧U1/C2等历史素材和发布记录。正式根本机[本轮统一diff](2026-10-03-media-cover-interactions/implementation-v0.37.2.diff)及[部署检查证据](2026-10-03-media-cover-interactions/deployment-v0.37.2.json)保持私有，不Git/部署；差异可读，证据对应同一应用提交，原截图仍待补。1000ms单击有界窗口及无法保证任意OS双击设置的边界见工单，不以构建/发布冒充功能验收。

2026-10-04追加C8，文本v2补充不替代C5-C7；关键词版本号半字号、正常字重、品牌不变。原文与已发布后独立PATCH0.37.3路径见[工单C8](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c8最新补充2026-10-04)。浏览器评论截图3（C8）仅聊天可见，原文件名/磁盘路径未提供，待补持久原件，可读性/完整性未核验；截图v0.37.1不是正式回退证据，不用旧PNG代替。北京时间2026-10-04 00:25:53已发布v0.37.3，应用1c9930c/BUILD J3lGF2j4oXVNQCRQ_lYos；C5-C8完整保留，待用户手动。正式根本机[最终C5-C8统一diff](2026-10-03-media-cover-interactions/implementation-v0.37.3.diff)、[0.37.3发布证据](2026-10-03-media-cover-interactions/deployment-v0.37.3.json)可读、对应同一提交，仍私有；0.37.2证据保留，不重复新建资料/设计说明。

### 深夜配色与周期额度用户列表

2026-10-04，项目video-api-debugger，来源为用户本轮文字要求；原文件名不适用，无附件，文本v3交付补充不替代历史素材。关键词：D1、深夜模式、白页、主题tokens、D2、周期额度、用户列表、候选成员与适用名单分离。原文、源码证据与范围见[固定工单D1-D2](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#d1-d2深夜配色与周期额度列表2026-10-04)，正文可读。已明确D1补齐默认暗工作台，不新建主题开关；共享页面/组件及局部白UI已于北京时间01:50:27发布0.37.4，应用b127209/BUILD ZgKKw-0pLsNEIe24xVMJt，待用户手动视觉验收，媒体/作品/纸面保留。D2普通用户管理无周期额度排除及规则筛选联动，额度候选成员却复用适用名单筛选；具体列表待用户答复，调查已完成未改额度/权限，不冒称D2完成。正式根本机[本轮统一diff](2026-10-04-dark-ui-periodic-list/implementation-v0.37.4.diff)、[部署证据JSON](2026-10-04-dark-ui-periodic-list/deployment-v0.37.4.json)可读，内容对应同一应用提交，私有不Git或部署；检查说明见工单，不以发布证据替代视觉验收。

### 播放时隐藏封面按钮

2026-10-04，项目video-api-debugger，来源为用户文字需求“单击播放后，封面不要出现播放按键”；原文件名不适用，无新附件，文本v2交付补充。关键词：P1、视频封面、播放按钮、悬停、键盘聚焦、等待与错误反馈。原文、根因、共用引用和实现范围见[固定工单P1](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#p1播放时隐藏封面按钮2026-10-04)，正文可读；移除播放期间hover/focus强制显示覆盖，保留透明点击区及等待/重试。北京时间06:53:11已发布0.37.5，应用da4e285/BUILD FkdpYXAklqREmAjtSKyog，待用户手动，不冒称视觉验收。正式根本机[本轮统一diff](2026-10-03-media-cover-interactions/implementation-v0.37.5.diff)、[0.37.5部署证据](2026-10-03-media-cover-interactions/deployment-v0.37.5.json)可读、对应同一应用提交，私有不Git/archive，旧版本证据保留。D1配色与C5-C8/U1保持，D2仍待具体列表确认；本轮无新附件，不冒用历史截图。

### 历史恢复、查看与版本字号

2026-10-04，项目video-api-debugger，来源用户本轮R1/R2文字及R3浏览器评论，文本v2交付补充；关键词R1直接恢复、R2无文字Eye查看、去重复入口、R3版本字号增加50%。原文、范围和实施见[固定工单R1-R3](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#r1-r3历史恢复查看与版本字号2026-10-04)，正文可读；只取消历史恢复专用确认，其他安全/付费/退出保护保留。北京时间08:00:29已发布0.37.6，应用2cb3e9b/BUILD 9OIK8DVopn89g3Quh4LRG，R1-R3均待用户手动验收。当前资料补充不替代C5-C8/P1旧图与旧记录。正式根本机[本轮统一diff](2026-10-03-media-cover-interactions/implementation-v0.37.6.diff)、[0.37.6部署证据JSON](2026-10-03-media-cover-interactions/deployment-v0.37.6.json)可访问、对应本次提交，私有不Git/archive；候选构建及发布检查、一次标记误报守旧与证据复用详见工单。

关键用户原件已查看可读，按原文件名归档在正式根/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions，源路径/var/folders/lt/cl_ckbmn1jl2wwj44t43qm6h0000gn/T/加各原名；均私有、不Git/archive：
- [codex-clipboard-bf8b8e0b-ce42-4ded-9a04-3db19b540822.png](2026-10-03-media-cover-interactions/codex-clipboard-bf8b8e0b-ce42-4ded-9a04-3db19b540822.png)：接收2026-10-04，用户本轮clipboard，R1恢复历史设置弹窗证据，原件v1非替代旧PNG，39476字节，源/归档SHA256 16480b548d9736ec65f9d0c2cbea6361253cf958ef54d6f3bf1d12f4115e4361一致。
- [codex-clipboard-f479bf73-86c9-44cc-9d9c-ff24143aa971.png](2026-10-03-media-cover-interactions/codex-clipboard-f479bf73-86c9-44cc-9d9c-ff24143aa971.png)：接收2026-10-04，用户本轮clipboard，R2恢复按钮及重复查看操作行证据，原件v1非替代旧PNG，22347字节，源/归档SHA256 09c884786253ebb0a1a44683764aa07bbbfa740941c3242b88aa009910a6ef55一致。

R3浏览器标记图仅聊天像素，原文件名/本地路径未提供，待补持久原件，可读/完整性未核验，不拿上述两PNG冒充。历史OS双击1000ms边界仍在，D2具体列表仍待确认。

### 视频比例、风格卡片与数量控件

2026-10-04，项目video-api-debugger，用户文字与浏览器评论，文本v2交付补充，关键词S1视频contain固定外框/竖屏黑边、S2卡片选用/取消与管理事件隔离、S3标题行高/主图风格组参考图数量select。原文、真实源码证据及范围见[固定工单S1-S3](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#s1-s3视频比例风格卡片与数量控件2026-10-04)，正文可读；北京时间14:07:40已发布0.37.7，应用bce7033/BUILD p7KYo9xeDmtuYO7YZCc9y，S1-S3均待用户手动验收，不替代R1-R3和历史资料。用户已确认外框不变，不裁剪拉伸，不改数量/选中/保存业务。正式根本机[本轮统一diff](2026-10-03-media-cover-interactions/implementation-v0.37.7.diff)、[0.37.7部署证据JSON](2026-10-03-media-cover-interactions/deployment-v0.37.7.json)可访问且对应同一应用提交，私有不Git/archive；检查与回退证据见工单。

本轮浏览器标记截图2张仅聊天像素，原文件名及本地路径未提供，待补持久原件，未归档或核验复制完整性：S2风格组dialog target dialog.studio_styleDialog，S3主图select target materialHeading select，页面template-studio/1068x871/v0.37.6，适用本轮卡片与紧凑控件要求，不当作线上回退证据。既有[R1恢复原图](2026-10-03-media-cover-interactions/codex-clipboard-bf8b8e0b-ce42-4ded-9a04-3db19b540822.png)和[R2操作行原图](2026-10-03-media-cover-interactions/codex-clipboard-f479bf73-86c9-44cc-9d9c-ff24143aa971.png)保持私有、可读且前轮hash已核，仅参考保持前修，不冒充本轮原件或自动截图。

收尾追加“每模板12张/3行、超出翻页、宽屏与开源方案”文字为独立设计咨询，2026-10-04，原文件名不适用，无附件；parent另行只读研究，本批未实施分页，也未因此增加应用版本。D2仍待具体列表；OS双击时序和外来预裁素材边界仍登记。

### 模板结果分页方案（T1研究建议）

2026-10-04，项目video-api-debugger，来源用户设计咨询及parent本轮只读开源研究汇总，原文件名不适用，无新附件，建议v1，不替代S1-S3或历史实现记录。关键词T1、模板结果、每页12张、3行/宽屏、容器查询、cursor/真实count、Mantine、TanStack Query、页缓存、分页状态恢复。完整原话、当前接口/布局证据、建议边界及官方/原始代码/MIT链接见[固定工单T1](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#t1模板结果分页方案2026-10-04仅研究建议)，正文可读。

parent核对现网源为auto-fill/min220/gap20、每批24/cursor与追加/静默刷新，没有真实总页；建议固定每页最多12，按结果区宽度2/3/4/6列，不暗增数量，不承诺窄区3行。受控页码、紧凑条、保留旧页数据和预读等仅开源模式参考；复用现PaginationControls/fetch/状态存储，不安装新整套库，真实count缺项需后续获准再实施。只读研究已完成，建议未批准实施、未接入/功能验证，本轮不改分页代码、接口或0.37.7版本/服务。Jev doctor由parent已核deferred cloud_disabled/not_authorized，无API调用，本lead不重复或开启付费。资料链接可定位原文，外部内容核对来源为parent，不冒称本lead重复读码验证；无附件复制校验项。


### 模板封面点击体验（U2判断与建议）

2026-10-04，项目video-api-debugger，来源用户当前文字反馈“点击生成图片封面好像没动静”，原文件名不适用，无新附件，建议v1。关键词U2、单击恢复、1000ms、取消待执行点击、双击预览、已套用、局部反馈、成功误用error、禁用原因。原话、生产源代码位置、官方/开源参考及A/B语义取舍见[固定工单U2](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#u2封面点击体验排查2026-10-04仅判断与建议)，正文可读。代码排查完成，非浏览器实测；只记录建议，未改交互、未升级或重新部署0.37.7。双击只看图的旧规则不擅改，瞬时恢复与双击纯预览不能无条件同时承诺。既有附件及缺口复用，不伪造本轮截图。

### 素材标题与封面反馈（U3-U6实施）

2026-10-04，项目video-api-debugger，用户素材区间距反馈、U2建议明确批准“同意，一起实现”、蓝点完整交接及新增“图片比例增加4:1选项”。关键词U3标题空隙/数量口径、U4即时套用/真实选中/来源已修改/阻止原因、U5小蓝点/个人回执/完成版本、U6图片4:1/模型通道能力/比例归一化。文字v3与[固定工单U3-U6](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#u3-u6素材标题与结果反馈2026-10-04整批实施)正文可读，整批实现v0.38.0，统一构建发布进行中。U4批准B明确替代旧“双击不恢复”和1000ms延时；U2历史研究不改成实施完成，T1分页未批准，D2列表待确认。U5规则完整：模板小蓝点、分组汇总，明确打开且成功读取后存个人已读，后台刷新不消点；独立服务端私有回执，不写DB，不扩权限。U6无附件；已核Google官方4:1能力及旧worker原生传参路径，仅Banana 2原生通道开放，其他通道明确限制，不改为其他比例、不重启图片worker，官方链接/尺寸及源级证据见工单，不冒称付费生成验证。

[codex-clipboard-11bfb0d0-12a8-4c0f-9c99-a70c47760b38.png](2026-10-03-media-cover-interactions/codex-clipboard-11bfb0d0-12a8-4c0f-9c99-a70c47760b38.png)，原文件名保留，接收2026-10-04，来源用户本轮clipboard，用途U3主图/风格组/参考图标题空隙与数量说明，原件v1不替代R1/R2或旧图。正式访问路径/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions/加原名；源路径/var/folders/lt/cl_ckbmn1jl2wwj44t43qm6h0000gn/T/加原名。parent已读取498x694可读、64115字节、复制SHA256与原件均1a74433710230eb9402e4bfc366d647c54e5c43eaa630b1d642f0ed8dcca3017，本lead复用校验；私有不Git/archive、不重复拷贝。U4批准为用户文字，无附件。

U5浏览器评论原文“增加红点系统，生成还未看的，在这块增加 一个小蓝点，点击后消失”，目标template-studio左侧分组快捷栏aside.studio_moduleRail，1259x871、节点(173,56)。截图仅聊天标记像素，原文件名及本地原件路径未提供，待补持久原件；未归档/核验复制完整性，不拿U3截图冒充、不自动截图替代。适用模板未读与分组聚合，原件版本/替代关系待补，文字完整规则见工单。

2026-10-04北京时间15:31交付补充，文本v4：U3-U6同批v0.38.0已部署，应用138a2c70493ff91a87feab1de4a6aebd76f2c0fa/BUILD F5HwWnLy0uFMi_KGPDBdN，四项均待用户手动验收，前段“构建发布进行中”为实施历史，当前以本段及工单交付小节为准。正式根[统一diff](2026-10-03-media-cover-interactions/implementation-v0.38.0.diff)、[部署JSON](2026-10-03-media-cover-interactions/deployment-v0.38.0.json)可访问且对应本次产物，私有不Git/archive；公网版本/6份新静态、候选/本地构建、回退及worker/数据保护证据见工单。文字资料/附件不替代旧PNG或U2研究记录；U4批准即时套用已替代旧1000ms/双击不恢复规则，U6无新附件且仅支持的Banana 2原生通道开放4:1，T1分页未实施、D2仍待确认。

### 封面与banner试做（V1，2026-10-04）

2026-10-04用户提出重新制作封面与banner，指出全身图细节不清、不便比较，要求先选3–5种形式做代表模板，确认后再铺量，并将此作为后续固定流程。本轮四类：转写实（推荐）、极简Q版化、转成线稿、草稿转成稿（高完成度）。关键词：脸部/半身/局部、相同部位对比、结果主视觉、草稿成稿、3:4封面、4:1banner、先样板后批量。比例与四种具体构图只是本轮建议，待用户确认，不能记成全站已批准样式。

首批样板v1.0.0已做，待用户确认；线上未替换、未铺量，当前应用v0.38.0不变。已确认的长期方式为3–5代表样板→用户确认→批量制作，保留按类型选择构图。用户本轮仅提供文字，无新附件；本轮从已有四个模板任务取八份原图/真实生成结果，以及内置imagegen制作四幅设计板。设计板有重绘与比例精度限制，仅供选构图，真实比较以原图预览为准，不用重绘伪造质量变化。

正式根私有[真实原图预览](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-04-template-cover-banner-pilot/preview-v1.html)及[素材与精确prompt清单](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-04-template-cover-banner-pilot/manifest-v1.json)为唯一交付入口，两个工作区均指向正式根，不复制原件到worktree。清单逐组保存原文件名、来源/任务对应、八原图可访问路径与SHA256、四设计板及生成器原件路径、提示词、已查参考和验证缺口。原始图片已打开可读，八份尺寸与元数据一致、SHA256匹配内容哈希文件名；脚本语法和裁切边界静态检查通过，未做浏览器/视觉功能验收。版本v1.0.0，首次样板，无替代关系；原图及生成器原件保留，不覆盖线上资产。本轮完整执行边界和确认门槛见[固定工单V1](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#v1封面与banner试做2026-10-04)。

### Q1/Q2模板快捷设置与历史封面上下文（2026-10-04）

- 资料名称/原文件名：模板设置与历史复现提示截图；`codex-clipboard-26d3afd9-1a27-4df3-b50c-56913ad90d58.png`。来源：用户本轮提供；接收日期：2026-10-04；来源路径：`/var/folders/lt/cl_ckbmn1jl2wwj44t43qm6h0000gn/T/codex-clipboard-26d3afd9-1a27-4df3-b50c-56913ad90d58.png`。
- 项目/主题/用途：video-api-debugger；模板快捷设置、另存为模板、恢复默认、历史生成封面上下文。作为 Q1/Q2 实施参考截图，画面可读地显示“恢复默认/保存设置/另存为模板”及退出历史复现模式后的上下文提示；不是实现或发布证据。
- 正式归档：[原始截图](2026-10-03-media-cover-interactions/codex-clipboard-26d3afd9-1a27-4df3-b50c-56913ad90d58.png)，正式路径：`/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions/codex-clipboard-26d3afd9-1a27-4df3-b50c-56913ad90d58.png`。PNG 566×216、29,327 字节；已打开可读，源与副本逐字节比较一致，SHA-256 均为 `b4a88859c4791c715259ae98e6163b49749a3fd88150954697df3f5e419378a6`。
- 版本/关系：首次归档，截图对应的应用版本未知；保留原文件名，不覆盖或替代既有附件。此 Q1/Q2 记录与封面/banner V1 样板任务分开，V1 状态及资料不变。
- 当前工单：[Q1/Q2固定记录](../../tasks/todo/2026-10-02-feedback-primary-navigation.md)。v0.39.0已实现并部署快捷模板入口与原上下文恢复，待用户手动功能验收；该截图只作需求参考，不当作成功证据。正式根私有[统一diff](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions/implementation-v0.39.0.diff)及[发布检查证据](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions/deployment-v0.39.0.json)登记应用commit54f67d1、BUILDoxKFErSV4OZB-19N8xJKh、三个公网入口及15份静态文件检查；原图和证据不上传Git。

### 模板上下文五位版本码（2026-10-04）

资料名称：模板上下文五位版本码及设置模板管理实施工单；原文件名2026-10-04-template-context-version-code.md；工单版本1.1.0，承接原1.0.0方案，新增本次明确实施授权及UI1-UI3。来源：用户文字需求及主管兼容性纠正；项目video-api-debugger；关键词：模块上下文原文、SHA-256、五位混合码、历史标签、模板改名/更新/归档、生成按钮前移。旧工单“仅方案”状态已被本次授权及实施记录替代，不扩展到视频或完整最终提示词。

唯一正式入口：[完整工单](../../tasks/todo/2026-10-04-template-context-version-code.md)，路径/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-04-template-context-version-code.md；主todo已登记。v0.40.0已部署，最终应用116ee2a82c1c3541c10c751674433d4958ffb54f，BUILD irfPSW4cqY4pqCko6De9P；14源码/15公网静态/3公开入口及4服务通过，待用户手动功能验收。曾切换73b3b2f后发现worker SQLite超时并回退9c8a9ac，再收敛标签写争用；未人工重启worker，但发生自动重启，完整因果未业务复现证明，详见工单第11节与证据，不能写成全程PID不变。

私有正式根[统一diff](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions/implementation-v0.40.0.diff)、[最终发布检查](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions/deployment-v0.40.0.json)、[构建日志](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions/build-v0.40.0.log)、[首次切换/回退](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions/deployment-v0.40.0-first-switch.json)均可访问、对应各自真实产物，不上传Git或源码包。回退tag rollback/2026-10-04-before-template-context-v0.40.0已推送，目标9c8a9ac。无新媒体附件；复用[既有模板设置区截图](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions/codex-clipboard-26d3afd9-1a27-4df3-b50c-56913ad90d58.png)，原名/来源/既有可读及完整性校验见上方Q1/Q2登记，只是布局参考。保留V1原图/样板，不替换封面；未运行浏览器、业务API或付费生成验收。
