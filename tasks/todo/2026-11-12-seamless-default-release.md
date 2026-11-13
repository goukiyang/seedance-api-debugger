# SEAMLESS01 项目默认无感发布（本轮不上线）

用户2026-11-12明确：本项目以后默认无感秒切，先别上线。授权是源码、项目规则、必要离线工程检查与聚焦Git交付；本轮不上传服务器新引擎、不reload、不启停服务、不切流、不做迁移或收费/浏览器功能验收。原UPDATE-PAGE01异常提示页此前已上线，保持原样。

## 1. 事实与最终方案

- 当次只读运行锚点为 `7bd03a42fd15eab25b7a53fe45090b3daca00837` / v0.148.9，固定Web是 `sd2-gray.service` / 3302；正式根05807旧脏分支不是运行源，未拿它覆盖新业务。
- 已核共享v1旧switch确实先挂503并停Web/image/HD；当前真实发布又依赖私有逐次build/cutover。最高生效CWD是12个服务的 `zzzzzzzzzzzz-upload-recovery.conf`；当前pricing allowlist为root0644，原guard仍root:gouki0440及root+i屏障。新默认按实际形态接线，不假称旧低优先级配置或固定440模板能覆盖当前运行。
- 新统一入口/引擎1.1.0：原站继续服务，新候选Web3303及独立图片worker先真实启动；旧/新/固定guard的公开静态资源只追加保留，再Nginx HUP平滑切流。等原Nginx worker（含还在缓冲的上传）退出及原同步生成结束，才自然停旧后台；正式3302及新后台就绪后切回，最后排空临时请求/worker并恢复原timer状态。
- 常规准入要求同Prisma/迁移、同持久服务合同和依赖，保留原精确相容guard；已知六个增量只接受封存的明确源差异。后台协议、数据结构、依赖等不满足此证明时，留旧站并拒绝，不默默改为停站发布。涉及这种变化须另做相容化；本次不授权迁移/整体重构。本版对API、src/lib及worker采用保守哈希准入：未知差异先拒绝，不把“未证明”说成“一定不兼容”；后续确实同合同的修复可在源码判断和工程证据支持下更新封存相容增量，不能只填true绕过。
- 新版临时进程使用root封存、限定run/服务/源/BUILD的启动授权，同权限私密策略和消费者证明副本，并逐次核对现行主策略哈希，权限变动即停止使用旧副本；guard直接读取现行策略。原永久main/guard仍严格两成员，原guard和不可变屏障不改。全部旧canonical组及全机同旧根的进程实际排空后才更新原三个启动控制及真正生效的CWD/私密消费者绑定；无DDL、原价/原号改写或业务数据库恢复。
- 原同步记录保持精确v1及同账号8张并发口径，另在同一事务添加限定进程的元数据；旧号/未知不换号重发。收费与共享模板两类worker就绪凭据按临时源隔离，保留原进程/父进程/源码哈希/TTL/回收CAS检查，正常主进程仍用原key。旧writer不会使新版心跳过期，新writer也不会抢掉旧版心跳。
- 候选未就绪保留旧站；长请求未结束返回pending/75并保留当前在线服务，原计划可resume，不强杀/超时伪造完成。真正公网不可用才用已固定的guard恢复，仅切程序/配置，保当前数据；部分控制配置有CAS和接续记录，不自动清除他人的活动发布或重写失败历史。

## 2. 固定实施清单

1. [x] 项目AGENTS、CLI、profile默认seamless；共享旧冷切分支拒绝，旧安装引擎仅允许只读查历史。旧分支先聚焦合入本实现，再准备下次正式发布。
2. [x] 实际新Web/图片worker的启动保护、同权限私密策略、Nginx切流/旧worker退场/旧资源保留、固定主入口交接已接入新默认执行器。
3. [x] 原后台、SQLite一致只读备份、原屏障/源/BUILD、收费/共享心跳、同步原号和固定guard恢复已接线；拒绝不相容变更。真实Linux/systemd交接尚未执行，不冒部署/功能达标。
4. [x] 最终类型/lint与离线工程证据、差异核对、CodeGraph更新及聚焦提交推送；结果见下节，服务器仍未启用。

## 3. 工程验证与边界

- 离线真实Nginx + 两个假HTTP服务：新请求切到新版本；旧长请求和跨HUP的缓冲上传完整结束；POST原body/编号各执行一次；旧/新静态资源均可读且继承原有origin/安全响应头；无效配置不能挤掉当前运行worker。全部log、pid及五类temp目录显式隔离，未再污染系统Nginx目录或owner。
- 同一实际控制器的8个阶段成功/失败/pending接续顺序，固定guard恢复且无数据回滚；临时启动guard完整源/构建、真实unit/实际环境绑定、root+i、撤销/篡改/额外dropin拒绝；当前实际builder证据适配器逐项绑定原Next/types日志/进程、计价/native矩阵及prepared entry。
- 实际SQLite只读查询全账号在途请求，按原key关联元数据，不扫全部历史心跳；未知/畸形原记录不当零。真实SQLite事务验证元数据同事务、旧号重复拒绝及中途失败无半条新受理。执行改动后的TS函数核对双源收费凭据共存、错源/错进程/错哈希/过期拒绝及CAS回收；共享模板key同样隔离。
- 最终24组离线检查通过；完整 `tsc --noEmit --pretty false --incremental false` exit0，六个改动TS文件的Next lint exit0；控制器/CLI语法与默认policy已核对。既有 `release-entry-engineering.mjs` 是Linux原生检查，本机执行在平台断言 `darwin !== linux`处拒绝；没有伪造平台或拿它算通过，后续真实Linux准入仍必做。
- 本轮没有整站候选构建、真实服务交接或生产故障注入；Next跨版本主动导航可能有框架自身的刷新行为，现有页面/草稿完整体验仍由用户手验，不声称所有跨版本行为已无感。
- GitHub只读检查：仓库Webhook为空、Actions workflow数量0，本分支不是已记录的旧自动发布目标；未建立、修改或执行任何自动上线任务。

## 4. Git与交付

基线7bd；主工作区 `/Users/gouki-youdoo/.codex/worktrees/seamless-release/video-api-debugger`，分支 `codex/seamless-default-20261112`，正确origin为 `https://github.com/goukiyang/seedance-api-debugger.git`。保护正式根全部用户脏改，项目规则/todo按独立标记更新；备用独立检出未写实现。本轮只推隔离分支，未合并部署分支、未启用服务器引擎；后续发布须先核源码包含本实现。

已在实际工作区查询CodeGraph并回源码检查影响面，索引已在实现提交 `3f37b48827ad1f679c09ce5d8f1b8a616f1363c6` 核对：2109文件，pending=0、hash mismatch=0、parse error=0。实现已提交并推送，远端同头；随后仅收口文档，不为文档再重建源码索引。参考：[Nginx HUP](https://nginx.org/en/docs/control.html#reconfiguration)、[Next14自托管版本差异](https://nextjs.org/docs/14/app/building-your-application/deploying#version-skew)。本轮新发现均属发布改动必要因果范围；依赖安装的既有Next告警已在正式 `tasks/discoveries.md` 登记，不重复新增或夹带升级。

最终工程原证在正式根 `docs/materials/2026-11-12-seamless-release/offline-engineering.json` 和 `verification.json`；全类型、六文件lint、24组离线检查与差异检查通过。实现提交 `3f37b48827ad1f679c09ce5d8f1b8a616f1363c6` 已推送且远端核同头。规则与源码交付完成，服务器引擎未安装/未启用；无新线上配置、服务重启、切流、DDL或功能验收。用户手验与真实Linux发布检查保持待办。本轮未新增任务外问题。

## 5. R02 用户授权上线与自动接续（2026-11-12）

用户明确先上线现成果，再处理自动接续；前次不上线限制已解除。已核当前线上8c275e3/v0.148.10，无同目标发布控制器；保留这版视频参考修复再发布v0.148.11，不回退业务功能。预检发现图片消费者实际为image-worker，main的methodReaderPassed=false为合法角色区别；已按实际绑定修正，未伪造通过字段。发布过程中本代理自动观察/pending接续，不交用户手动。发布完成后再修改正常等待的程序自动接续；运行期间冻结发布引擎，功能手验仍独立且不阻断工程发布。
