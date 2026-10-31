# SAFE-RETRY01 资料登记

检索日期：2026-10-31 America/Los_Angeles；归档核对：2026-10-31T08:07:06Z。仅公开HTTPS GET，未调用生成/重试/取消接口，无登录凭据或用户媒体外传。远程JS仅按文本读取，没有执行。

| 原件 | 来源 | SHA-256 |
|---|---|---|
| fluxport-ApiDocsView-DvghblkZ.js | https://uselg.top/assets/ApiDocsView-DvghblkZ.js，由当次/docs HTML及index-DZ5uMUGz.js定位 | bf012791f441dd5017fd933ee663372f414b10a9740492e89144476bcdea3661 |
| fluxport-public-pricing.json | https://uselg.top/api/v1/pricing/public | 8cc93aabfbffadcb4620ed1d17c9dfccf314971c066d5294a7fff0dcbc8bfe72 |
| musk-faq.html | https://api.muskapis.com/docs/zh-CN/faq | 4f733d5b2202318d483254fd7ba554d78b95e9d45939e36afe9d704a41040d4f |
| musk-troubleshoot.html | https://api.muskapis.com/docs/zh-CN/troubleshoot | 4756f8e5e8586f577b06330e2f40524b62da30a903ee8b56e5a112cb100d47d6 |

Musk文档身份由当次公开`https://api.muskapis.com/api/status`的docs_link核实；不是根据相似域名猜测。HTML通过标准HTMLParser读取main正文，pricing通过JSON解析；FluxPort JS定向读取内嵌文档内容。未查到明确免费错误码合同，不能把该结论解释为断言一定收费。

上游网页原件保本地，不向公开Git转载整个JS/HTML/报价数据。公开Git仅工单与安全索引；完整设计见[正式工单](../../../tasks/todo/2026-10-31-safe-generation-retry-preflight.md)。原件hash用于核对本轮依据，不证明供应商实际计费已验证。
