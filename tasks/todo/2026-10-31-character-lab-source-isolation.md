# 角色参考图独立工具与模板来源隔离

2026-10-31用户明确：角色参考图属于现有工具区`/tools/character-lab`，不归入普通模板，包含默认过渡帧的列表、喜欢、活跃统计及置顶投影须统一隔离；原图、候选、成品、历史仍在该工具。显式素材库选用不等于模板归属。

- 复用已存在的可信owner-plan键和sha256(owner:planId)批次关联，无新schema/全库回填/改snapshot；已只读实际匹配3条历史Lab输出，原id/owner/费用/原件不动。普通结果在分页LIMIT与count前同口径排除，置顶按源owner分类并传同db/tx。
- 新报价与创建内部可信来源一致，独立上下文/参考，不继承当前或默认模板的通用上下文、固定参考、风格与提示词组；共用模型/价格引擎及管理员原Lab设置保持。旧已受理/unknown先查原号，不重算旧fingerprint或费用。
- 工具输出栏保留共用原图发送；候选明确发送底层完整4/9宫格，成品为当前生成原图，不冒单格裁剪或输入。切历史按实际task隔离。飞书显示“角色参考图工作台”链接回原工具。

工程：真实隔离SQLite查询/分页/统计/置顶及quote-submit5项有证；无生产改写、收费生成、试发或浏览器验收。v0.121.6已部署，待用户手验；最终回执见§11及`docs/materials/2026-10-31-feishu-global-character/implementation/`及固定todo追加，实际效果待用户手验。


## 11. v0.121.6实际交付与待手验

已部署，待用户手动验收。main `849c895d53afba3b1dcf8ff6961d48cea66ce941` / BUILD `f1dkMKWqw0791lMH8lbS-`；相容guard `d0708bd1ee0e4a64b038a344212ae2ad210ad98c` / v0.121.6+feishu-global-character-guard.1 / BUILD `KSIDStgsHKXwxox5kSTlA`。run `51812274-20b3-46a2-9671-08ca234ecd92`，19:03:45Z开始、19:04:13.975907Z公网收口。

本单与另外两包同批交付：飞书轻反馈/真实后缀/自动V3与手动V2模块名链接、global双pending/旧草稿不抢新正文/按需历史/发布专属布局、Lab历史3条可信来源在分页count前隔离/新报价创建无模板上下文继承/工具输出保共用发送。原件、旧费用、原号与未知保护保留。

匹配工程与修后Linux完整tsc、main/guard两完整Next含类型lint通过；首构建仅工程夹具UUID类型推断失败，补一行:string后重绑当前源，原失败及工程原时间保留。179个原生依赖逐字未变复用原证；11writer自然排空、配置与SQLite一致备份、6启动门、7服务4timer及三公网JS字节一致。guard只关两个新飞书入口，保所有旧新已受理消费，程序回退不回业务数据。首发迁移专用fullRelease不适用本次无schema，未运行/未冒formal准入PASS，沿最近v0.121.5实际常规fixed pair链。

完整私有回执：正式根`docs/materials/2026-10-31-feishu-global-character/implementation/attempt02/deployment-result.json`、`guard-restore.md`。无浏览器/收费生成/真实工程试发或历史补发/真实私密正文保存/独审。历史两次500缺唯一内部原号关联；已修复隔离复现的P1008错误与恢复提示，不称历史全部同因。原medium/4K供应商返2048原因继续待核，旧四请求证据保持。
