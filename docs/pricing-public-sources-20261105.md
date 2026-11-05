# 2026-11-05 待核费率来源登记

本次核对现有启用通道。公开标价、站内已采用人民币基价和供应商逐笔实扣分别记录；历史点数不能反推人民币价格。新固定价仍按 1 元 = 100 点，完整任务最后四舍五入到整数点，不先取整每秒点数。

## AI MediaKit 标准/专业超分

- 来源：[官方视频工具计费](https://docs.volcengine.com/docs/intelligent-processing/video-tool-billing?lang=zh)、[API 指南](https://docs.volcengine.com/docs/intelligent-processing/enhance-video-guide?lang=zh)。现有接口为 `/api/v1/tools/enhance-video`，不采用同页大模型版或极速版的价格。
- 基准 0.75 元/分钟，按输出时长精确到毫秒。现有 480p/720p/1080p/2K/4K，≤30fps 标准版依次为 0.0125/0.0125/0.025/0.05/0.1 元/秒；专业版依次为 0.125/0.125/0.25/0.5/1 元/秒。>30且≤60fps 乘2，>60且≤120fps 乘4，共30个现有规格。
- 不插帧沿用源帧率，不默认为≤30fps；服务器读取有权源任务保存的帧率和时长，源帧率未知时要求显式选输出帧率。报价使用预测时长，不能冒成供应商出账。
- 62条成功任务的官方金额均为空，已存创建/查询 JSON 未发现实际扣款字段。该公开标价不是折扣、资源包或账号实际账单；未开通6K/8K或其它增强版本。
- 实施状态：源码补齐30个身份及毫秒报价，待完整工程检查、相容发布和原后台签名预览/CAS保存。后续生产保存回执登记在正式费率工单，不以本文件宣称已生效。

## 火山 IP Seedance

实际通道 `ark.cn-beijing.volces.com/api/v3`。来源：[官方模型价格](https://docs.volcengine.com/docs/ark/model-pricing?lang=zh&redirect=1)、[版权视频](https://docs.volcengine.com/docs/ark/generate-copyright-video?lang=zh)。在线人民币/百万 completion tokens：

| 模型 | 分辨率 | 无输入视频 | 有输入视频 |
| --- | --- | ---: | ---: |
| Seedance 2.0 | 480p/720p | 46 | 28 |
| Seedance 2.0 | 1080p | 51 | 31 |
| Seedance 2.5 | 480p/720p | 70 | 42 |
| Seedance 2.5 | 1080p | 77 | 46 |
| Seedance 2.0 Fast | 480p/720p | 37 | 22 |
| Seedance 2.0 Mini | 480p/720p | 23 | 14 |

模型费为实际 `usage.completion_tokens / 1000000 × 对应单价`。版权费另加“每个所选IP的单价 × 输出时长”，各IP价格需在方舟体验中心核对，不存在已确认的统一版权单价。带视频最低token量依规格变化；2.5 Draft两步独立收费，正式步骤以原输入是否含视频选价，Draft本身不算输入时长。

686条成功IP任务已有token用量，官方金额字段均为空。上述模型单价已登记为公开来源，但不能填进当前“固定元/秒”表冒充完整实扣。尚未改动IP站内价；需要完整按token及所选IP费用的合同才能采用，不套用另一家Seedance供应商历史美元均价。

## Flare 两个现行 FluxPort 通道

来源：[供应商公开价格](https://uselg.top/pricing)、[公开价格JSON](https://uselg.top/api/v1/pricing/public)、[模型文档](https://uselg.top/docs?model=gpt-image-2.5-flare)。实际Key地址为 `api.uselg.top`；仅调用公开文档列出的只读 `/v1/usage`，两个现行Key均HTTP200，返回币种USD、钱包模式，但没有实际group_id或倍率。

公开 `gpt-image-2.5-flare` 同时列出多个组和接入专用组，按次数字包括0.019/0.15/0.1及有条件的0.01/0.05；公开存在该价不证明当前Key有权使用该组。未从组名猜报价，未用历史5点倒推人民币，也未将Musk旧token账单套到FluxPort。现价人民币继续待确认，缺口为实际Key分组及该组当前收费合同。

## 普通 Seedance 的参考视频与 Draft 升级

来源：[现用供应商文档](https://model.seedance-api.net/docs?menu=apiSeedance20Fast)。查询结果公开列出 `billing_status`、`actual_cost`、`currency_or_credit_type=USD`，已有历史逐笔账单。参考输入时长及Draft步骤影响成本，历史平均数不是统一固定每秒价格。未从方舟官方价跨供应商填补，未重算历史或改变这些范围的冻结/结算合同。普通无参考视频已采用的六档人民币基价保持。

## 保持的边界

四档图片已确认的0.10/0.05/0.06/0.07元及10/5/6/7点不改；H3原明确免费不改；停用/未就绪通道不为登记价格而启用。无新增生成、无付费试跑、无原始账单伪造、无余额/项目额度/历史流水回写。
