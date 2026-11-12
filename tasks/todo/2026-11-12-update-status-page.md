# UPDATE-PAGE01 更新期间以提示页替代默认502

用户2026-11-12要求：产品更新时不显示502，而显示“正在更新”提示页。沿常规修改/部署授权执行，功能由用户手验，不做浏览器或收费生成验收。

## 范围与判断

- 线上只读确认：`sd2.youdooart.com` HTTPS与既有`sd2-server.youdoodesign.com`入口反代`127.0.0.1:3302`，均无网关错误兜底页；现有发布切换会停止应用，因此重启间隙可能暴露Nginx默认502。
- 页面独立存放于`/data/video-api-debugger/site-status/updating.html`，由Nginx直接提供；不依赖Next.js、数据库或图片资源。仅浏览器GET/HEAD且接受HTML时显示，原地址保持，10秒一次只读health，确认恢复后刷新当前页面；未承诺恢复时刻。
- 网关不能从502判断是计划更新还是异常中断，因此标题为“正在更新或恢复服务”，避免把真实故障断言为正常发布；不使用虚假百分比或倒计时。
- Nginx自身502/503/504统一返回503，带`no-store`与`Retry-After: 10`；API、`/_next`、非HTML及非GET/HEAD返回JSON。`proxy_intercept_errors off`保留应用真实401/403/404/500/503正文；原下载鉴权、请求方法、费用和受理未知恢复不变，不重新提交业务请求。
- 只增加本项目两个现有入口的include，不改其它站点、应用、发布器、systemd、数据库或素材；Nginx平滑reload，不停站。已观察其它候选构建，实际reload前核对不存在正在切版/恢复的所有者；不修改运行中的发布工具。

## 实施与工程检查

- [x] 线上对象、实际配置与共享API边界已核对；当前应用基线771ca034ab426114463942f7ec81fa82936d5c65 / v0.148.2。
- [x] 独立静态HTML与`ops/nginx/sd2-updating.conf`已实现，色彩沿现有深色工作台。
- [x] 隔离Nginx验证15项：HTML/JSON、HEAD空正文、原地址保持、真实503/免缓存、应用401/403/404/500/502/503正文保留和正常200；生产请求0。内嵌JavaScript语法检查通过，未做浏览器验收。
- [x] 配置备份、Nginx语法检查及平滑reload。
- [x] 源码聚焦提交并推送既有正确origin分支`codex/maintenance-page-20261112`，不改原工作区分支或index。
- [x] 正常公网健康与实际配置加载证据；页面视觉/真实更新过程待用户手验。

Git：原正式根有大量用户脏改，仅新增本任务文件；应用源不改版，不重编Next。App隔离工作区已checkout但注册准备迟迟未结束，显式重新挂接又报Git检查60秒超时，未在未就绪目录开发。改用独立临时Git index以实际已运行771ca为父树，只纳入本任务3份资产/工程脚本和本原单，生成聚焦分支`codex/maintenance-page-20261112`；不切原分支、不动原index、不提交其它任务的todo及部署文档差异。部署资产已与这三份本机原件逐一核SHA；不因此重做已通过的代理检查或重启生产。

参考：[Nginx error_page](https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page)、[proxy_intercept_errors](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_intercept_errors)。实际工程与发布证据归本单后续；说明记录不冒部署或功能验收。

## 实际部署（2026-11-12）

纽约时间04:47:17（09:47:17Z）完成；04:48:31公网`/api/health`返回200与`ok:true`。配置发布`UPDATE-PAGE01`，应用仍v0.148.2，没有应用构建/版本切换、服务停机、生产故障注入、收费调用、数据库或媒体修改。

正式站和既有服务器入口均已加入`include /etc/nginx/snippets/sd2-updating.conf;`；两路本机经Nginx健康通过，重读配置和静态文件SHA与实际发布结果一致，Nginx/应用仍active。静态页SHA `5b42b174487bd2a51da024a3cd485b928c367f91bb587ee41e3fd6cc64c4a8a7`，snippet SHA `aa6c30bb20cc4d05d5ec3c5751b351afa42e99628dc788c8eea9f70c6a930476`。

服务端原证与回退配置：`/data/video-api-debugger/release-staging/update-status-page-20261112/attempt01/`，含`engineering-result.json`、`nginx-test.log`、`deployment-started.json`、`deployment-result.json`与两份`*.before.conf`；备份未实际恢复。

必要回退仅还原这两个站点配置，再`nginx -t`通过后`systemctl reload nginx`；不回应用或数据。操作前先核没有其它切版所有者，且当前两份配置SHA仍分别为`9105c11784c627e8d7e9f5be3c117ae396a6233e18a0ec1977e3a12123c27a7e`与`328e62f14d3754ed7c9e9ac193cd1198cd752df2e29073d3eee088753b551869`，避免用本次备份覆盖后续合法更新；备份分别为`sd2.youdooart.com.before.conf`和`sd2-server.youdoodesign.com.before.conf`。新静态页/snippet可保留为未引用文件，无须删除。

本地首次公网读取命中已不可用的本机7898代理，改为本次curl直接访问后正常；这是本机连接问题，不是正式站故障，也未改全局代理。没有浏览器/截图验收，也没有为看提示页而停止生产应用；待用户后续手验。当前范围未新增其它产品线索或问题。

源码提交`b0e1adb71811dbcc78b866c454fe5ab709cd9a9e`仅3个`ops/nginx`文件，父提交为实际已运行771ca；已推送`origin/codex/maintenance-page-20261112`，原分支/index未修改。实际Git回执保本主题资料目录，本单随后独立提交。CodeGraph准备入口本轮因Git枚举`--cached --others`30秒超时失败，未声称索引同步成功；本轮为独立Nginx配置、HTML与隔离工程脚本，无应用调用关系变更，定向源文件/运行配置已核。
