# 视频复用修复与 GPT Image 2.6 接入

用户目标：修复同事无法复用生成视频的输入；核实 GPT Image 2.6 后端并接给前端。两项并行保留，不以新增事项取消前项。

## 证据和架构判断

- 生产基线 aff41ac30bcf40dbf55704f8fa4e2f7e8c69f96e / v0.134.1。近期两条原任务多次 POST reuse 返回409，原号回执为 REUSE_ASSETS_UNAVAILABLE。
- 一条原请求的4张素材及另一条的7张素材均存在、active、归本人，ReferenceImage绑定也存在。用实际权限函数核4张全部可用。
- 只读执行原route至最终写入边界（finish被替换为记录器，零工作区/原回执写入）：原4张均已准备，两个URL另有他人Asset副本；assetByUrl的最后一条覆盖原ID，随后重复URL被误记缺失，整次拒绝。与生成供应商、计费无关。
- 第二缺陷：route以空payload结束素材拒绝，事务层又丢弃拒绝payload，前端原有“仅恢复参数”因没有draft而不可用。
- 修法：冻结ID绑定优先，URL重复表达沿同一源去重；没有ID的历史URL记录才逐个验证可用别名。冻结源被撤权/删除不借他人副本补齐。参数拒绝在来源和工作区CAS通过后持久交付参数；原号回查重新核来源权限，撤权不返draft。未知只查原号，不改旧回执、不生成、不扣费。
- 2.6在官方文档中分为 gpt-image-2.6-flare / gpt-image-2.6-sunburst，沿现有OpenAI Images生成/编辑适配及统一目录，前端、管理和计价共用。独立注册，原2.5默认/冻结记录不迁移；供应商成本与站内默认价格均null，不复制2.5费率，不自动换通道。
- 旧保护版严格读取modelCapabilities键，因此后台可保存新型号前需补齐保护版2.6读者并完整构建；不直接复用不识别新型号的旧guard。

## 当前进展

- [x] 视频真实拒绝回执、素材归属与权限核对；原route只读取证定位URL别名覆盖。
- [x] 修复冻结ID/URL去重与真正失效素材的参数回退、回查撤权保护。
- [x] 注册2.6两型号、标签、质量/分辨率和协议映射，缺省费用null。
- [x] 聚焦隔离工程fixture：原ID优先（两种返回顺序）、legacy URL授权查找、撤权/删除、参数回执回查、撤权后不泄漏、工作区冲突；两型号JSON/multipart请求model/quality/size透传，未知短名拒绝、2.5仍可读。零浏览器/真实生成/收费/生产数据写入。
- [ ] 生产候选完整构建与类型/lint、2.6相容保护版构建、聚焦提交推送、保护部署和公网健康。
- [ ] 2.6实际通道可用性/独立费用/目的地许可：供应商GET models未在现有凭据目的地策略中，按原保护停止此读取；没有绕过。现有通道没有2.6能力或站内价格，保持未启用。官方价格不能当现有代理商实际价格。
- [ ] 用户手动验收视频复用；2.6真实出图在通道和价格确认后另验，不以mock冒已出图。

## 官方依据

- https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst
- https://developers.openai.com/api/docs/models/gpt-image-2.6-flare
- https://developers.openai.com/api/docs/guides/image-generation （含2.6质量集合与独立token成本）
- https://developers.openai.com/api/reference/resources/images/methods/generate

## 独立复跑

`node --import tsx scripts/test-video-reuse-image26.cjs`。只用内存假数据和捕获传输；不是浏览器功能验收。Mac全仓类型检查因数据盘I/O等待中止，类型/lint沿Linux候选完整Next构建，不冒已通过。

本轮新发现的线索与问题：未新增任务外问题；2.6通道、价格和目的地许可是本项未闭环条件。
