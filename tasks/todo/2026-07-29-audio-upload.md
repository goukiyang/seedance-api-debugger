# 音频素材上传统一链路

## 1. 大白话目标复述

用户想在正式网站里上传音频素材，并把音频作为视频生成的参考素材使用。现在底层已经支持 `audio`，生成页也已经能带 `reference_audio_urls`，但资产管理页、筛选、文案和用户提示还没有统一到音频，用户会感觉“音频上传没有入口 / 上传后找不到 / 不知道怎么用”。

这次要做到：音频素材走和图片、视频同一条上传链路；资产管理页能上传、查看、筛选音频；生成页能选择音频作为参考素材；只上传音频时给清楚提示，告诉用户音频需要配图片或视频一起用；所有限制用大白话说明清楚。

完成标准：用户在 `/assets` 和 `/generate` 都能上传 2-15 秒、15MB 以内的 MP3/WAV/OGG 音频；上传成功后能看到音频素材；重复上传复用同一份后台素材；加入生成工作台后任务提交参数里包含 `reference_audio_urls`；音频单独提交时前端先拦截并提示，不消耗点数。

最短实现原则：不新建上传接口、不新增依赖、不改数据库结构、不拆出第二套音频上传系统；全部复用 `uploadFileAsAsset`、`/api/assets/upload-ticket`、`/api/assets/upload-complete`、`/api/assets/history` 和 `/api/workspace/assets` 这条现有链路。

## 2. 具体可执行任务

- [x] T1. 开工前确认范围和当前状态
  - 检查对象：`/Volumes/Data/Projects/video-api-debugger-v12-full-todo`。
  - 执行命令：`git status --short --branch`。
  - 完成标准：确认本轮只处理音频素材上传统一链路；不混入无关改动；如果工作区已有旧改动，按文件或 hunk 隔离本轮改动。

- [x] T2. 资产管理页支持音频分类和音频上传
  - 修改文件：`src/app/assets/page.tsx`。
  - 具体改动：
    - 把 `AssetType` 从 `all | video | image | reference` 扩展为 `all | video | image | audio | reference`。
    - `typeTabs` 增加“音频”。
    - `assetUploadTypeLabel()` 识别 `audio/*` 并显示“音频”。
    - `assetLibraryTypeFromFile()` 识别 `audio/*` 并在上传成功后切到音频筛选。
    - 上传 input 从 `accept="image/*,video/*"` 改为 `accept="image/*,video/*,audio/*"`。
    - 上传说明改为“支持图片、2-15 秒视频、2-15 秒音频，音频最大 15MB。”
  - 完成标准：用户在资产管理页点“选择文件”时可以选择 MP3/WAV/OGG；上传成功后自动切到音频列表并看到素材。

- [x] T3. 资产管理接口返回和筛选音频素材
  - 修改文件：`src/app/api/assets/library/route.ts`。
  - 具体改动：
    - `ITEM_TYPES` 增加 `audio`。
    - `LibraryItemKind` 增加 `audio`。
    - `serializeAsset()` 对 `asset.type === 'audio'` 返回 `kind: 'audio'`，音频没有缩略图时允许前端稳定占位。
    - `loadAssetItems()` 允许 `type=audio`，`type=all` 时包含 `image/video/audio`。
  - 完成标准：`/api/assets/library?type=audio&scope=history` 能返回当前用户的音频资产；`type=all` 不漏掉音频。

- [x] T4. 生成页参考素材文案统一，避免用户误以为只能传图片
  - 修改文件：
    - `src/components/ReferenceStrip.tsx`
    - `src/components/AddReferenceCard.tsx`
    - `src/components/PromptEditor.tsx`
    - `src/components/ModeSelector.tsx`
    - `src/components/GenerationComposer.tsx`
  - 具体改动：
    - “最多 9 张”改成“最多 9 个”。
    - “添加参考图”改成“添加参考素材”。
    - “历史图片”改成“历史素材”。
    - 保留即梦官方图片引用规则 `@图片1`，但补清楚：音频会自动作为参考音频传给生成接口，不要求用户在提示词里 `@音频`。
  - 完成标准：生成页从第一眼看上去就是图片、视频、音频都可作为参考素材，不再出现明显只支持图片的入口文案。

- [x] T5. 生成提交前拦截“只有音频”的情况
  - 修改文件：`src/components/GenerationComposer.tsx`。
  - 具体改动：
    - 在 `handleSubmit` 前统计当前工作台里图片、视频、音频数量。
    - 如果有音频但没有图片和视频，前端直接提示：`音频参考需要配合图片或视频一起使用，请再添加 1 个图片或视频参考素材。`
    - 不发起任务创建请求，不冻结点数。
  - 完成标准：用户只放音频点击生成时，页面直接给出清楚原因；不会创建任务、不会消耗点数。

- [x] T6. 音频展示保持稳定，不做复杂播放器
  - 修改文件：
    - `src/components/ReferenceThumb.tsx`
    - `src/components/UploadedImagePicker.tsx`
    - 如资产管理卡片渲染在 `src/app/assets/page.tsx` 内，也同步处理。
  - 具体改动：
    - 工作区和历史素材弹窗里音频继续用稳定占位，不拿图片缩略图伪装。
    - 资产管理页音频卡片显示“音频”、文件名、上传时间和大小；预览时能打开或播放音频地址。
    - 图片放大能力只作用于图片；音频不进入图片放大弹窗。
  - 完成标准：音频素材不会出现破图、空白卡片或错误图片预览；卡片尺寸不跳动。

- [x] T7. 补齐自动化验证
  - 修改文件：`scripts/reference-media-chain-smoke.ts`。
  - 具体改动：
    - 增加资产管理页 `accept="image/*,video/*,audio/*"` 断言。
    - 增加资产管理页 `AssetType`、`typeTabs`、`assetLibraryTypeFromFile()` 支持 `audio` 的断言。
    - 增加资产库接口 `ITEM_TYPES`、`LibraryItemKind`、`loadAssetItems()` 支持 `audio` 的断言。
    - 保留现有音频时长 2-15 秒、15MB 上限校验。
  - 验证命令：
    - `npm run test:reference-media`
    - `npm run lint`
    - `npm run build`
  - 完成标准：三个命令通过；失败时先修本任务相关问题，不跳过验证。

- [ ] T8. 真实页面验收
  - 测试素材生成命令：`ffmpeg -v error -y -f lavfi -i sine=frequency=440:duration=3 -c:a libmp3lame /tmp/sd2-audio-ref-3s.mp3`。
  - 验收入口：
    - `https://sd2.youdoodesign.com/assets`
    - `https://sd2.youdoodesign.com/generate`
  - 验收步骤：
    - 在资产管理页上传 `/tmp/sd2-audio-ref-3s.mp3`。
    - 确认上传过程有真实阶段或真实进度显示。
    - 确认上传成功后音频出现在“音频”分类和“全部”分类。
    - 在生成页“添加参考素材”里能看到并选择这条音频。
    - 只选音频点击生成时，页面提示必须配图片或视频，不创建任务。
    - 再配一张图片或一个视频后，确认请求参数包含 `reference_audio_urls`；除非用户明确授权消耗点数，不做真实付费生成。
  - 完成标准：真实页面能走完上传、展示、选择、前端拦截和参数检查闭环。

- [ ] T9. Git、部署和上线验证
  - Git 计划：
    - 分支：沿用当前任务分支；如主线策略不适合直接推送，则新建 `codex/audio-upload-unified-chain`。
    - 只暂存本轮相关文件，不使用 `git add .`。
    - 提交信息要能看懂，例如：`支持音频素材上传统一链路`。
  - 部署命令：
    - `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`
    - `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2`
    - `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites status sd2`
  - 公网验证：
    - `curl http://127.0.0.1:3000/api/config`
    - `curl https://sd2.youdoodesign.com/api/config`
    - `curl https://sd2.youdoodesign.com/login`
    - 等约 70 秒后再次检查 `youdoo-sites status sd2`。
  - 完成标准：commit 已推送，线上加载新构建，公网页面能看到新音频入口和文案。

- [ ] T10. 停止条件
  - 如果 R2/TOS 上传配置缺失、登录态失效、`ffprobe` 缺失、构建失败、lint 失败、上传接口返回页面内容、需要改数据库结构、需要付费生成或需要破坏性 Git 操作，立即停下说明原因，不继续盲改。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [x] R1. 独立只读审查：代码范围是否对齐
  - 检查对象：`src/app/assets/page.tsx`、`src/app/api/assets/library/route.ts`、`src/components/GenerationComposer.tsx`、`src/components/ReferenceStrip.tsx`、`src/components/AddReferenceCard.tsx`、`src/components/PromptEditor.tsx`、`src/components/ModeSelector.tsx`、`src/components/ReferenceThumb.tsx`、`src/components/UploadedImagePicker.tsx`、`scripts/reference-media-chain-smoke.ts`。
  - 通过标准：只改音频素材上传统一链路相关内容；没有新增上传接口；没有新增依赖；没有改数据库结构；没有改点数、支付、鉴权、Provider 价格等无关高风险逻辑。
  - 证据来源：`git diff --stat`、聚焦 `git diff`、相关文件只读检查。

- [ ] R2. 独立只读审查：用户路径是否达标
  - 检查对象：`/assets` 和 `/generate` 真实页面。
  - 通过标准：资产管理页能选择、上传、展示、筛选音频；生成页能从历史素材选择音频；音频卡片不破图；文案不再误导成只支持图片。
  - 证据来源：真实浏览器截图、上传测试音频、页面 DOM 或网络请求记录。

- [ ] R3. 独立只读审查：任务提交和点数安全
  - 检查对象：生成页提交前校验、`/api/tasks/create`、`/api/ip/tasks/create`。
  - 通过标准：只有音频时前端拦截，不创建任务、不冻结点数；图片/视频 + 音频时请求包含 `reference_audio_urls`；后端仍保留公网 URL 和音频不能单独使用的保护。
  - 证据来源：浏览器 Network、接口响应、代码检查；不要求真实付费生成，除非用户明确授权。

- [ ] R4. 独立只读审查：自动化验证是否覆盖回归
  - 检查对象：`scripts/reference-media-chain-smoke.ts` 和命令输出。
  - 通过标准：`npm run test:reference-media` 覆盖资产页、资产库接口、生成页和后端音频限制；`npm run lint`、`npm run build` 通过。
  - 证据来源：命令输出末尾、失败时的具体报错。

- [ ] R5. 独立只读审查：上线是否真实生效
  - 检查对象：Git 远端、`youdoo-sites` 构建/重启状态、公网 URL。
  - 通过标准：commit 已推送；线上新构建加载；`https://sd2.youdoodesign.com/assets` 和 `/generate` 刷新后能看到音频入口；健康检查跨过一个守护周期。
  - 证据来源：`git status --short --branch`、`git ls-remote --heads`、`youdoo-sites status sd2`、公网 `curl` 和真实页面证据。

## 4. 审查内容是否对齐目标

- [x] A1. R1 是否对齐“只改必要范围”
  - 判断：R1 能证明本任务没有扩大到新上传系统、数据库结构、点数和 Provider 价格等无关范围。

- [ ] A2. R2 是否对齐“用户能上传和找到音频”
  - 判断：R2 检查的是用户实际入口 `/assets`、`/generate`，不是只看代码里有没有 `audio` 字符串。

- [ ] A3. R3 是否对齐“不会误消耗点数”
  - 判断：R3 覆盖只选音频的前端拦截和后端兜底，能证明失败发生在创建任务前。

- [ ] A4. R4 是否对齐“以后不回退”
  - 判断：R4 的 smoke 断言覆盖资产页、接口、生成页和任务创建，不只覆盖其中一段。

- [ ] A5. R5 是否对齐“线上可见”
  - 判断：R5 要求公网页面和健康检查证据，避免只停在本地测试或代码提交。
