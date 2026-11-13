# FEEDBACK-SKILL01 反馈到飞书接收闭环技能

状态：技能已完成、全局安装并导出，文档校验通过；聚焦Git交付沿本节末尾记录。业务与线上运行未修改。

用户要求：摸清系统收到反馈、发给本人飞书、本人回复收到的整条链路，以及设计、要求、展示，整理成完整技能。

本轮仅调查和技能制作；保护原工作区脏改，不修改应用/网关/生产数据，不造反馈、不试发或代点卡片，不部署。

## 交付内容

| 项 | 结果 |
|---|---|
| 链路 | 网站/插件入口、原号提交、Feedback/回执/通知事务、图片准备、投递、回调、持久确认、展示 |
| 设计 | 提交回执、卡片正文/图片/来源/双按钮、原卡确认反馈、管理及本人详情 |
| 要求 | 精确收件人/实际操作者、app/tenant/nonce/message绑定、原号去重、未知安全窗、图片权限 |
| 后续 | 已修复并通知回测、按轮次去重、原提交人本人结论，与接收/查看/归档独立 |
| 技能 | [.agents/skills/feedback-feishu-ack-workflow/SKILL.md](../../.agents/skills/feedback-feishu-ack-workflow/SKILL.md)，3份按需参考、发现元数据 |

## 事实与证据

原要求沿FEEDNOTIFY01/FEEDUX02/FEEDIMG03原通知单、固定todo的FB-ACK R02/R06以及F24-S01/R07；不重写历史状态。当前根checkout 05807fcdd过旧，改从已核部署对象和相同目标文件的已有工作区读取。CodeGraph准备与context查询成功，关键结论回源码。

2026-11-12纽约23:31起只读核：Web真实源2c338614b0dc189937fdbcaa7c6b63e33f1b2096/0.148.11，9核心文件及实际共享网关字节核对；相关源码与已有seamless工作区9bab07517一致。timer有效、oneshot sender实际WorkingDirectory同managed release；原current链接不能代表有效执行来源。网关8790 health正常，精确Nginx回调路由和原source分支已核。

数据库mode=ro汇总：旧通知sent36，新带接收按钮通知sent23；23个flow中3个receivedAt。未输出原文、真实身份、消息号、nonce或凭据；未修改业务行。这证明存在平台回执和持久确认，不证明本轮真实客户端显示/点击已验。

“回复收到”现实现是“已收到”按钮；没有查到聊天手打“收到”自动关联反馈。确认不改Feedback.status；卡片更新失败不撤销事实。unknown实际存为行failed/meta.unknown，不能据failed盲重发。原通知接收人和后续回测原作者是不同角色。

## 验证与收口

技能5文件（主入口、3参考、发现元数据）已完成。系统skill-creator quick_validate通过；4个相对Markdown链接可达，元数据长度/默认自动发现正常，9核心文件与实际服务器SHA及运行Git对象逐一匹配。非独立语义复核覆盖：手打收到、unknown落failed行、卡片更新失败但已入库、换绑/转发、重复确认与新修复轮、旧checkout误当现网；合同与对应实现一致，不冒真实功能测试。

已安装到 `/Users/gouki-youdoo/CodexHome-local/skills/feedback-feishu-ack-workflow`，链接到本项目单一技能源，不复制两份维护。便携包 `/Users/gouki-youdoo/CodexHome-local/skill-exports/feedback-feishu-ack-workflow.skill` 已生成，ZIP完整性和全部5文件逐字节核对通过。正常自动发现保留，文件安装不证明既有聊天已经重载。

工程范围仅技能文档和发现元数据，不跑应用构建/功能回归；真实飞书和站内效果仍用户手验。没有新依赖、共享配置修改、真实外发或应用发布。

Git交付使用 `codex/feedback-feishu-ack-skill-20261112`，以已有远端可见的运行提交2c338614为base；临时索引只纳入5个技能文件、本记录和固定todo新增入口。当前原分支领先远端的7个旧提交、原18个dirty和实际index不混入交付，不切换用户工作区。

本轮新发现的线索与问题：未新增任务外问题；当前checkout旧、旧链接及历史阶段文案已作为查证边界处理，不定性为线上故障。
