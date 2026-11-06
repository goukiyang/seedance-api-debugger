# 费率单项启停资料

用户要求每项费率前增加启停开关。实际合同、实现、失败尝试与发布记录只维护在[原单](../../../tasks/todo/2026-11-05-pricing-item-activation.md)。

UTC 2026-11-06T08:49:14Z 已保护部署 v0.134.3：主程序7dc33318a，BUILD avlAWxMmaCsB0eCJC9gUv；相容guard0e840e2d，BUILD VvC4RjOix_v26EtpJJZyP。完整工程和构建通过，实际开关/保存/生成效果待用户手动验收。

正式工作区私有 `release/attempt03/` 保留public-deployed、source-pair-contract、main/guard-build-success、activation-ui、fresh-health、price-protection、database-protected及误引用旧入口被拒绝的记录；不上传原数据库、环境、用户媒体或整份私有价格行。服务器原证在 `/data/video-api-debugger/release-staging/pricing-item-activation-20261105/attempt03/`，原attempt01/02失败证据保留，未改成成功。

源代码的独立分支为 `codex/ledger-rate-accounting-20261105`；guard为 `codex/points-pricing-settings-guard-activation-20261105-r2`。重型发布窗口已交还后继批次，后续必须继承新启停读者，不能回旧d2。
