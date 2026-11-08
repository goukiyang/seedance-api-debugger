# 角色融合提示词发布摘要

2026-11-08：已部署，待用户手动验收。入口 https://sd2.youdooart.com/tools/character-fusion 。原工单见 [CHAR-FUSION01](../../../tasks/todo/2026-11-08-character-fusion.md)。

- 分支：`codex/character-fusion-20261108`，应用提交 `9b2eccae8fd333cfbe8defe8d32178347638e344` 已推至既有origin；版本0.135.0，BUILD `u_Nz4s0rvT7Lzfs9T5Op8`。继承实发0.134.31/3654ea83，精确15文件差量，后续文档提交不等于运行源。
- 新增：八维Boss、锁定与随机刷新、三态规则/自定义、固定要求/批量/三语言、本地规则生成¥0、逐条与批量操作、TXT/CSV、本人服务器配方。没有模型调用、生成提交、上传或schema变更。
- 出图：按工单降级约定，复制选中提示词并打开现有生图模板或角色参考图页，用户粘贴；两个页面无通用纯文本接收口，未改其生成链。
- 工程：32种子规则检查、独立全量tsc、完整lint、Linux完整Next及内置检查均通过，保留非阻断警告。
- 发布：stage `character-fusion-20261108/attempt03`切版exit0，无恢复；09:30:47Z公网、09:32:20Z健康。6启动检查、7服务、4timer、新页JS SHA与匿名配方401通过；匿名页面307转登录，登录200。费用全字段/私有策略/原环境及数据链接保持。
- 恢复：沿原stage `program-recovery.sh release-input.json`，兼容guard F0 / BUILD `_JwQu0Zzx5P5dk89dyQd9`，原05:29:46Z完整构建及1469编译哈希复用；只回程序，不回数据/媒体/账单/原请求。一致DB备份只留服务器。
- 待手验：规则与锁定交互、复制、配方刷新/切号、手机无横滚及两个出口；没有浏览器或真实生成测试。CodeGraph两次超时未取得结构查询，已定向读源码复核，本单记录保留缺口。

原型及私有发布元证在正式根 `docs/materials/2026-11-08-character-fusion-prototype/`；本Git摘要不包含原DB、环境、配置、价格原行或用户数据。旧目录已有改动保持原样。

10:04Z发布保障补正：继承恢复脚本的stage/baseline仍为旧任务常量，已仅修为本单冻结输入，保存原脚本与前后SHA。语法、只读前置及当前F0的1469编译哈希通过；未执行恢复、重启或写业务数据。此前可执行恢复入口的过早表述以本更正为准，实际恢复未演练。详情及anchor-fix-proof.json入口沿原工单末节。
