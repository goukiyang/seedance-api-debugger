# 项目资料索引

| 接收日期 | 名称与原文件名 | 来源/项目 | 主题与用途 | 路径 | 版本与校验 |
|---|---|---|---|---|---|
| 2026-09-16 | 参考素材缺少选择入口 / codex-clipboard-72580c2d-35f5-46f8-a2b2-23b8f044c765.png | 用户本轮截图 / SD2 | 生成页参考素材弹窗；复现选择入口不明显，核对复选框修复 | [原图](2026-09-16-reference-picker/codex-clipboard-72580c2d-35f5-46f8-a2b2-23b8f044c765.png) | 原始版本，无替代；图像已阅，cmp归档一致 |
| 2026-09-16 | verified-selection-v0.2.1.png | 本轮真实Chrome验收 / SD2 | 两张素材选中、复选框及顺序显示 | [验收截图](2026-09-16-reference-picker/verified-selection-v0.2.1.png) | v0.2.1结果证据，不替代用户原图；已打开核对 |
| 2026-09-23 | 上传接口返回页面内容 / codex-clipboard-50db8914-4c81-4fb9-b90f-6649b40e1047.jpg | 用户本轮截图 / SD2 image-studio | 添加参考素材时普通上传接口失败，记录真实客户端错误表现并用于线上复现 | [原图](2026-09-23-image-studio-upload/codex-clipboard-50db8914-4c81-4fb9-b90f-6649b40e1047.jpg) | 原始版本；SHA256 `62a091c5567654ca7962b0b566fede6e546198399d88311496e37bbbf40b97a3`；已归档，待与真实网络响应对照 |
| 2026-09-23 | verified-upload-v0.12.2.png | 本轮 Xiaobo Chrome 登录态验收 / SD2 image-studio | 普通上传接口返回 JSON 200，参考素材区出现新缩略图并可继续使用；不触发付费生成 | [验收截图](2026-09-23-image-studio-upload/verified-upload-v0.12.2.png) | v0.12.2 线上证据；SHA256 `fd26577c7d8ded31f5c057d1da734130976c23ce62adc8b568d03dc28bb040f7`；已打开核对 |
| 2026-09-24 | 上传目录权限错误 / codex-clipboard-5c9156e6-166d-4226-b1d7-4a03ea6a942e.jpg | 用户本轮截图 / SD2 | 添加参考素材时出现 `EACCES mkdir /srv/video-api-debugger/app/public/uploads/assets`，并伴随缩略图加载失败；用于核对线上持久化目录修复 | [原图](2026-09-24-image-upload-permission/codex-clipboard-5c9156e6-166d-4226-b1d7-4a03ea6a942e.jpg) | 原始版本；SHA256 `15cf67af7da6e5c216fdfc2739ee0b37390fefcdb1c7cfaed1397730b1fe3be2`；已归档，未覆盖 2026-09-23 原图 |
