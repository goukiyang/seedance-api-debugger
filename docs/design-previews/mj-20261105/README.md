# MJ preview controller

Controller for the existing same-origin SD2 style preview. A opens the authenticated Works page; B opens the authenticated image template workbench. The normal application remains the content and permission source.

Explicit nginx 502/503/504 documents show reconnect feedback and receive at most three read-only readiness probes. Only the failed iframe document is reopened with GET. Healthy pages, drafts, generation and business operations are never retried. Switching pages cancels a pending reconnect.

The controller is published as a versioned compare script with the existing preview HTML/CSS. Source styles remain on the A/B candidate branches; private reference images and incident evidence stay outside the public artifacts.

Authentication is never shown inside the iframe. A user-activated top-level original login preserves the selected sample and viewport in its same-origin return path. Existing CSP and OAuth/state permissions remain unchanged.

C opens the original /generate video generation page. Its route-only candidate stylesheet is scoped by .mj-generation-page, which the comparison controller adds only to that iframe root. Formal app styles, APIs and submission logic are unchanged. A/B styles remain on their original branches. The r05-generation HTML references versioned controller and chrome assets; r04 files remain available to existing open documents.

The r06 C preview additionally loads ux.js/css: a presentation adapter for the resource picker, Feishu notice and project section. It groups duplicate folder names without changing albums, keeps original React-owned controls in place, and adds only its own disclosure buttons and data attributes. Source share records, actual files, permissions and all business handlers remain unchanged. Image generation follows after these two UX work packages.

D opens the current account's real default image workspace after a read-only /api/auth/me lookup. Null sessions use the original top-level login; an unknown response remains retryable, and stale lookups cannot replace a subsequently selected page. No module is created by this controller. D styles the original ImageStudio and GeneratedImageResults, retaining parameters, fees, permissions, drafts and result actions. The r07 C/D samples share the existing presentation adapter with a mobile notice positioning fix; all earlier versioned assets remain available.


## R08：图片生成的结构改版（2026-11-06）

D 页改用真实分支组件构建，入口 `/__style-preview/mj-dna/template-studio`。顶部长输入、当前值参数条、全宽原结果区；模板/预设和素材设置按需展开。D 不再注入旧 d.css，已有素材库与飞书体验适配仍保留。

结构主改动为 `5b62c6cc166fb4bcde659c77f814a61ff4637248`，包含后续图标和缩略图类型修正的应用构建源为 `72f4c5a356ce741c88114d98871a34a782b5fa9f`，基于正式源 d5d77d6e8d19e96fb0b96211ade96b82861d072f / v0.134.8。独立 localhost:3318，Next basePath `/__style-preview/mj-dna`；独立源码目录内沿用 `.next-prod`。原 API、权限、账号和媒体 URL 沿原站；候选 API 和非只读入口由网关关闭。没有修改正式应用，功能与视觉效果待用户手动验收。
