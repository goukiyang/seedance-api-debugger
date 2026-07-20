# 审核001 固定只读审查记录

固定审核线程：`审核001 - sd2 固定只读审查`

Thread ID：`019f44c6-64d3-7753-acd0-f31fc16763fb`

项目路径：`/Volumes/Data/Projects/video-api-debugger-v12-full-todo`

## 固定规则

- 该线程只负责审核、验收、只读复查和目标对齐检查。
- 不改源码、不改配置、不改数据库、不提交 Git、不推送、不打 tag、不部署、不补实现。
- 审核发现的问题统一追加到本文档。
- 每次审核完成后，回到发起线程同步结果，并以 `审核完成，等待推进` 收尾。

## 记录格式

```markdown
### YYYY-MM-DD 审查对象

- 结论：通过 / 不通过
- 阻塞问题：
- 非阻塞风险：
- 证据：
- 建议下一步：
```

## 审查记录

暂无正式审查记录。

### 2026-07-09 Seedream 5.0 Pro 图片生成 API 接入现场只读审核

- 结论：通过。
- 审查对象：执行分支 `codex/seedream-5-pro-image-provider` 中 Seedream 5.0 Pro 图片生成 Provider、后台配置、生成入口、无线画布 bootstrap、固定审核线程规则和 smoke 脚本。
- 阻塞问题：无。
- 非阻塞风险：
  - `tasks/todo.md` 当前同一工作区 diff 里还包含一段非 Seedream 的“用户 Bug 反馈自动通知与 Codex 修复链路规划”，后续形成聚焦 Seedream 版本时建议拆分提交或明确同批原因，避免版本范围混杂。
  - `src/app/api/assets/generate/route.ts` 的本地 `/uploads/...` 路径校验已经能阻止跳出 `public/uploads` 主目录，但当前用字符串 `startsWith` 判断，后续可改成 `path.relative` 或补尾部分隔符校验，降低相邻前缀目录误通过风险。
  - 审核线程按只读边界未重跑 `npm run build`，因为 build 会写构建产物；本次独立复查只重跑不写构建产物的 smoke、typecheck、lint 和 diff 检查。执行线程报告的 build 通过仍需由执行线程保留原始证据。
- 证据：
  - 分支和工作区：`git status --short --branch` 显示当前分支为 `codex/seedream-5-pro-image-provider`，改动集中在本轮指定源码、todo、审核文档和 3 个新增 smoke 脚本。
  - Provider：`src/lib/integrations/image-generation.ts` 增加 `seedream` 和默认模型 `doubao-seedream-5-0-pro-260628`；Seedream URL 拼到 `/images/generations`，请求头使用 `Authorization: Bearer ...`。
  - Payload：Seedream 请求体只构造 `model`、`prompt`、`size`、`output_format`、`response_format`、`watermark` 和可选 `image`；未发送 `n`、`stream`、`tools`、`sequential_image_generation`。
  - 单张和参考图：Seedream 配置归一化 `max_outputs_per_request=1`，返回结果只取单张；`/api/assets/generate` 对 Seedream 使用 10 张参考图上限，并能把本地 `/uploads/...` 图片转成 data URL。
  - 后台配置：`/admin/integrations` 可区分 `Seedream 5.0 Pro` 与 `Gemini Image (Musk)`，展示 Seedream 的 `1K/2K`、`单张输出`、`最多 10 张参考图` 等限制；后台配置接口返回并记录 `default_size`、`output_format`、`response_format`、`watermark`，不回显 API Key。
  - 生成返回和日志：`/api/assets/generate` 成功响应包含 `source_model_label`、`size`、`output_format`、`response_format`、`reference_image_count`，operation log detail 包含 `model_label`、`size`、`output_format`、`response_format`、`reference_image_count`。
  - 无线画布：bootstrap 的 image capability 返回可读 `label`、`size`、`output_format`、`response_format`、`watermark` 和 Seedream 能力限制。
  - 固定审核规则：`AGENTS.md` 和本文档已写入审核线程只读边界、唯一允许追加文档、记录格式和固定收尾语。
  - 独立复跑通过：`npx tsx scripts/seedream-image-generation-smoke.ts`、`npx tsx scripts/seedream-admin-settings-smoke.ts`、`npx tsx scripts/seedream-generate-route-smoke.ts`、`npx tsc --noEmit --pretty false`、`git diff --check`、`npm run lint`；lint 仅输出既有 `<img>` 和 hook dependency warning，命令退出码为 0。
- 建议下一步：执行线程先处理非阻塞风险，尤其是聚焦提交范围和是否补更严路径校验；随后再按 sd2 规则做提交、远端版本、部署和公网验收。

### 2026-07-09 Seedream 5.0 Pro `/uploads/` 路径边界小修复只读复核

- 结论：通过。
- 审查对象：`src/app/api/assets/generate/route.ts` 的本地 `/uploads/...` 路径校验小修复，以及 `scripts/seedream-generate-route-smoke.ts` 的回归检查。
- 阻塞问题：无。
- 非阻塞风险：
  - 本次只读复核未重跑 `npm run build`，因为 build 会写构建产物；执行线程报告 build 通过，需要由执行线程保留原始构建证据。
  - 上一轮提到的 `tasks/todo.md` 聚焦提交范围风险不属于本次小修范围，若工作区仍混有非 Seedream 规划改动，提交前仍建议拆清或说明同批原因。
- 证据：
  - `src/app/api/assets/generate/route.ts` 当前 `localUploadPath()` 先固定 `uploadsRoot = path.join(publicRoot, 'uploads')`，再计算 `relativePath = path.relative(uploadsRoot, filePath)`，并用 `relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)` 决定是否允许返回本地文件路径。
  - 该校验能拒绝 `/uploads/../uploads_evil/...` 这类规范化后落到相邻前缀目录的路径，因为相对 `uploadsRoot` 会变成 `..` 开头；相比旧的 `filePath.startsWith(path.join(publicRoot, 'uploads'))`，已解决相邻前缀误通过风险。
  - `scripts/seedream-generate-route-smoke.ts` 已增加对 `path.relative(uploadsRoot, filePath)` 和 `!path.isAbsolute(relativePath)` 的检查，能防止该路径边界逻辑退回简单字符串前缀判断。
  - 独立复跑通过：`npx tsx scripts/seedream-generate-route-smoke.ts`、`npx tsx scripts/seedream-image-generation-smoke.ts`、`npx tsx scripts/seedream-admin-settings-smoke.ts`、`npx tsc --noEmit --pretty false`、`git diff --check -- src/app/api/assets/generate/route.ts scripts/seedream-generate-route-smoke.ts`、`npm run lint`；lint 仅输出既有 warning，命令退出码为 0。
- 建议下一步：执行线程可继续收口提交；提交前确认是否拆分或说明非 Seedream todo 规划改动，并按原计划保留 build、Git、部署和公网验收证据。

### 2026-07-15 WallVerse 第一组「世界迁移」24 秒预演片只读验收

- 结论：通过。
- 审查对象：
  - 第一段任务 `cmrlrjwo300g4ygdljfoflyiy`：`storage/generated-tests/sd2-video-cmrlrjwo300g4ygdljfoflyiy.mp4`、`storage/generated-tests/sd2-video-cmrlrjwo300g4ygdljfoflyiy-contact.jpg`
  - 第二段任务 `cmrlrvb2u00h3ygdl7220dcuv`：`storage/generated-tests/sd2-video-cmrlrvb2u00h3ygdl7220dcuv.mp4`、`storage/generated-tests/sd2-video-cmrlrvb2u00h3ygdl7220dcuv-contact.jpg`
  - 24 秒成片：`storage/generated-tests/wallverse-migration-20260715/wallverse-世界迁移-第一组-24s-480p-preview.mp4`、`wallverse-世界迁移-第一组-24s-480p-contact.jpg`、`final-tagline-frame.jpg`
- 阻塞问题：无。
- 非阻塞风险：
  - 第一段“断电”动作主要依赖手部操作、旧屏变暗和世界离屏来表达，能看懂迁移，但如果后续做正式广告片，可以把断电瞬间再强化一点。
  - 成片 `ffprobe` 显示 `color_space=bt709`，但 `color_transfer` 和 `color_primaries` 标签为 `unknown`；实际 H.264/yuv420p/BT.709 色彩空间和解码播放均正常，如需严格交付母版可补完整色彩标签。
  - 同一 workspace 下 `ReferenceImage` 表仍有历史 active 参考图 15 条；但本次验收口径里的工作台活动挂载参考数 `WorkspaceAsset` 为 0，未发现当前工作台活动参考残留。
- 证据：
  - 视觉叙事：第一段接触表显示旧电视中的家庭世界被唤起、发光纪念树出现、完整浮岛从旧屏离开，并通过水流连接到右侧新电视；第二段接触表从第一段尾部构图续上，浮岛和水流进入新电视，家庭成员在新电视前观看，家庭地标继续存在。
  - 记忆点：成片和两段接触表都能清楚看到发光纪念树、完整浮岛、连接两台电视的水流；整体明显区别于普通动态屏保。
  - 续接：第一段尾部和第二段开头都保持旧电视、右侧新电视、浮岛、发光树和水流的相近位置，续接自然。
  - 结尾卖点字：`final-tagline-frame.jpg` 中“换的是电视，不是这个家的世界。”位于底部深色半透明条上，文字清楚、无遮挡。
  - 视频参数：成片 `ffprobe` 为 `codec_name=h264`、`width=864`、`height=496`、`pix_fmt=yuv420p`、`color_space=bt709`、`r_frame_rate=24/1`、`avg_frame_rate=24/1`、`duration=24.083333`、`nb_frames=578`；文件大小约 4.6MB，码率约 1608337。
  - 解码：`ffmpeg -v error -i <成片> -f null -`、两段原片同样命令均无错误输出，完整解码通过。
  - 两段原片参数：两段均为 864x496、24fps、H.264、yuv420p、约 12.041667 秒、289 帧。
  - 数据库任务状态：只读查询 `VideoTask` 显示两条任务均 `local_status=succeeded`、`provider_status=succeeded`、有结果视频、`actual_cost=36.0`、`frozen_cost=0.0`、`provider_cost_status=official_confirmed`；两条合计 `actual_cost_sum=72.0`、`frozen_cost_sum=0.0`、`official_confirmed_count=2`。
  - 点数流水：只读查询 `CreditLedger` 显示两条任务各有 `task_freeze -36` 和 `task_success_deduct -36`，合计冻结 72 点、成功扣除 72 点，完成后冻结归 0。
  - 供应商成本证据：只读查询 `CostLedger` 显示两条任务均有 `official_charge`，`cost_source=provider_usage`、`confidence=confirmed`，并有 `Provider getResult 上报实际扣费` 记录。
  - 引用链路：第一段 `referenceImageIds` 为空；第二段 `referenceImageIds=["cmrlrvanp00h0ygdl9o84tf9r"]`。该参考图记录对应文件名 `sd2-video-cmrlrjwo300g4ygdljfoflyiy-last.jpg`，尺寸 864x496，来源是第一段真实尾帧上传图，未发现旧素材污染。
  - 工作台活动参考：只读查询 `WorkspaceAsset` 对两条任务所属 workspace 的计数为 0。
- 缺口：无阻塞缺口；只有上述断电表达可加强、色彩完整标签可补、历史参考图与活动挂载参考图口径需继续区分这三个非阻塞点。
- 建议下一步：可以进入执行线程的交付收口；若后续用于正式投放，建议额外做一版更明显的断电脉冲/黑屏过渡，并在最终导出时补全 BT.709 primaries/transfer 标签。

### 2026-07-15 WallVerse 第一组「世界迁移」24 秒带声预演版只读复验

- 结论：通过。
- 审查对象：工单 `wallverse-migration-audio-v1`；无声源片 `storage/generated-tests/wallverse-migration-20260715/wallverse-世界迁移-第一组-24s-480p-preview.mp4`；带声版 `storage/generated-tests/wallverse-migration-20260715/wallverse-世界迁移-第一组-24s-480p-preview-audio-v1.mp4`；声音设计 `audio-v1/wallverse-sound-design-v1.wav`、`sound-design-waveform.png`、`sound-design-spectrogram.png`、`timeline-1fps.jpg`。
- 阻塞问题：无。
- 非阻塞风险：
  - 本轮只做技术复验和画面/声音节点抽查；正式投放仍需要真人听感确认、品牌音乐/旁白策略和授权审查。
  - 带声版和无声版继承了上一轮视频的 `color_space=bt709`，但 `color_transfer`、`color_primaries` 仍为 `unknown`；不影响本轮预演复验，正式母版可补完整色彩标签。
  - 本次声音设计是后期合成音效，不是 Provider 原生带声生成；这正好规避了 `OutputAudioSensitiveContentDetected`，但后续如果恢复原生音频生成，仍要单独处理敏感内容失败风险。
- 证据：
  - 根因：只读查询 `VideoTask` 显示成功任务 `cmrlrjwo300g4ygdljfoflyiy`、`cmrlrvb2u00h3ygdl7220dcuv` 的 `generate_audio=0`，两条源片和原 24 秒合成片 `ffprobe` 均只有 video stream，无 audio stream，证明不是后期合成丢失音轨。
  - 失败任务：只读查询 `VideoTask` 显示 `cmrlkiw8u00a9ygdlm79jsgfu` 的 `generate_audio=1`、`local_status=failed`、`provider_status=failed`，错误信息含 `[OutputAudioSensitiveContentDetected] The request failed because the output audio may contain sensitive information`，`actual_cost=0.0`、`frozen_cost=0.0`、`refund_amount=36.0`。
  - 冻结退回：只读查询 `CreditLedger` 显示失败任务先 `task_freeze -36`，后 `task_failed_refund 36`，`frozen_after` 从 36 回到 0。
  - 带声版媒体参数：`ffprobe` 显示视频流 `h264`、`864x496`、`yuv420p`、`24/1`、`duration=24.083333`、`nb_frames=578`；音频流 `aac`、`48000 Hz`、`stereo`、`duration=24.083000`。
  - 声音设计文件：`wallverse-sound-design-v1.wav` 为 `pcm_s24le`、`48000 Hz`、双声道、`duration=24.083333`；波形图 1600x400、频谱图 1884x628 均存在。
  - 完整解码：`ffmpeg -v error -i wallverse-世界迁移-第一组-24s-480p-preview-audio-v1.mp4 -f null -` 无错误输出。
  - 画面未重生成：无声版和带声版视频流按 `ffmpeg -map 0:v:0 -c copy -f md5 -` 得到相同 MD5：`db57e827c7aeaaad6a6323915faaafd9`，符合预期；按 rawvideo 解码帧 MD5 也一致为 `2a3f754b86c4c952b7b0c752d7435e9a`。
  - 静音和响度：`silencedetect=n=-50dB:d=1` 无输出，未发现超过 1 秒、低于 -50dB 的完全静音段；`ebur128=peak=true` 汇总为 Integrated loudness `-17.9 LUFS`、True Peak `-5.6 dBFS`。
  - 声画节点：`timeline-1fps.jpg` 与 `sound-design.filter` 对上，约 3 秒有 `switch_click/power_down` 断电节点，4-8 秒有 `tree_chime/lift_rumble` 世界唤醒升起，8-13 秒有 `travel_whoosh/water_flow` 跨屏迁移，12-17 秒有 `portal_pulse/portal_shimmer/resolve` 进入新电视，21 秒后 `final_chime` 对应结尾落点。
  - 原无声版本保留：无声源片仍存在，大小约 4.6MB；带声版为新增文件，大小约 5.2MB。
  - 无新增 Provider / 点数：以两条源片最后一条扣点流水时间 `1784101574747` 为切点，只读查询 `VideoTask`、`CreditLedger`、`ProviderApiRequest` 均无新增记录；本轮后期合成没有重新调用 Provider，也没有新增点数扣除。
- 缺口：无阻塞缺口；正式投放前仍需真人听感、品牌音乐/旁白和授权审查，不能把本轮预演复验冒充最终投放验收。
- 建议下一步：执行线程可将带声预演版作为技术验收通过版本收口；如进入正式片阶段，补真人听感确认、品牌音频授权审查和最终母版色彩标签。

### 2026-07-16 审核002 WallVerse 第二至第四组带声预演片只读验收

- 结论：通过。
- 审查对象：
  - 六条 12 秒源片：`cmrm7thb000kdygdlzpqdse74`、`cmrm8o32l00ldygdlywdctikn`、`cmrm945eb00maygdlbn7h16f3`、`cmrm9fodu000ilciqnmblwy3o`、`cmrm9omdt001glciqrg30mhjj`、`cmrm9x5us002flciqe3gs27ok`
  - 三条 24 秒带声片：第二组 `wallverse-记忆地貌-第二组-24s-480p-preview-audio-v1.mp4`、第三组 `wallverse-家是法则-第三组-24s-480p-preview-audio-v1.mp4`、第四组 `wallverse-今夜成真-第四组-24s-480p-preview-audio-v1.mp4`
  - 三组 `final-contact.jpg` 与四组合辑 `wallverse-四组完整预演-96s-480p-audio-v1.mp4`、`four-groups-contact.jpg`
- 阻塞问题：无。
- 非阻塞风险：
  - 本轮为预演片技术和叙事验收；正式投放仍需真人听感确认、品牌音乐/旁白策略和授权审查。
  - 六条 Provider 源片自身仍是无音轨、色彩标签 `unknown` 的原始结果；三组最终片和四组合辑已补完整 BT.709 标签，正式母版应继续以最终片/合辑为准。
  - 四组合辑可连贯展示四组卖点，但正式传播时仍建议按投放节奏决定是否拆成单条素材，避免 96 秒长片影响完播。
- 证据：
  - 视觉叙事：第二组无字幕可看懂“家庭旧物长成世界地貌”，旧盒子/小物件进入电视世界，变成海岸、桥、岛屿和家的地貌；第三组可看懂“现实家居状态决定世界自然法则”，扫地机、空气净化器、灯光/夜晚状态映射为世界中的天气、河流和光路；第四组可看懂“孩子当天的画成为今晚只属于这个家的故事”，纸上蓝鲸和皇冠进入电视，变成夜晚城市海面上的霓虹鲸故事。
  - 独占卖点：三组 final-contact 分别围绕旧物地貌、家居法则、当天画作成真，不互相混淆；四组合辑接触表也能清楚分出第一组世界迁移、第二组记忆地貌、第三组家是法则、第四组今夜成真。
  - 连接和镜头边界：第二组 A 段在完整客厅/屏内地貌镜头结束，B 段从同一客厅世界自然接入；第三组 A 段停在夜晚客厅大镜头，B 段从同一夜晚客厅接上并进入光路；第四组 A 段在霓虹鲸屏内成形后结束，B 段从霓虹鲸画面继续。未发现把同一镜头硬拆成两个独立生成结果的问题。
  - 尾板：三组 `final-contact.jpg` 尾帧卖点字均位于画面底部，清楚无遮挡。
  - 媒体参数：六条源片均为单 video stream，无 audio stream；均为 H.264、864x496、24fps、yuv420p、约 12.041667 秒、289 帧。
  - 三组带声片：均为 H.264、864x496、24fps、yuv420p，`color_space=bt709`、`color_transfer=bt709`、`color_primaries=bt709`；均有 AAC、48000 Hz、stereo 音轨，音频约 24.083 秒。
  - 四组合辑：`wallverse-四组完整预演-96s-480p-audio-v1.mp4` 为 H.264、864x496、24fps、yuv420p，BT.709 三标签完整；音频 AAC、48000 Hz、stereo，时长约 96.341 秒。
  - 完整解码：六条源片、三条组片、四组合辑均执行 `ffmpeg -v error -i <file> -f null -`，无错误输出。
  - 静音检查：三条组片和四组合辑执行 `silencedetect=n=-50dB:d=1`，未输出静音段，未发现超过 1 秒完全静音。
  - 声音设计边界：三组 `wallverse-sound-design-v1.wav` 均为 `pcm_s24le`、48000 Hz、stereo、24.083333 秒；三组最终片是后期声音设计合成，不是 Provider 原生音频。
  - 数据库任务状态：只读查询 `VideoTask` 显示六任务全部 `local_status=succeeded`、`provider_status=succeeded`、`generate_audio=0`、每条 `actual_cost=36.0`、`frozen_cost=0.0`、`provider_cost_status=official_confirmed`；汇总为 6 条成功、合计 `actual_cost_sum=216.0`、`frozen_cost_sum=0.0`、`official_confirmed_count=6`。
  - 点数流水：只读查询 `CreditLedger` 显示每条任务都有 `task_freeze -36` 和 `task_success_deduct -36`，共 6 次冻结、6 次成功扣除，冻结点数 216，成功扣除 216，`fail_or_refund_count=0`，冻结均归零。
  - 供应商成本：只读查询 `CostLedger` 显示六任务均有 `official_charge`，`cost_source=provider_usage`、`confidence=confirmed`，并记录 `Provider getResult 上报实际扣费`。
  - 引用链：三条 A 任务 `reference_image_ids` 为空；三条 B 任务分别只引用 `cmrm8niy300laygdlmctbinga`、`cmrm9fmcx000flciqvjdw0v0c`、`cmrm9x5ex002clciqxk7ywp6o`。这三个参考图文件名分别为 `sd2-video-cmrm7thb000kdygdlzpqdse74-last.jpg`、`sd2-video-cmrm945eb00maygdlbn7h16f3-last.jpg`、`sd2-video-cmrm9omdt001glciqrg30mhjj-last.jpg`，均为本组 A 任务真实尾帧，尺寸 864x496。
  - 工作台参考：目标 workspace `b05f8803-f45e-4130-aa83-5401f2c43da2` 的 `WorkspaceAsset` 计数为 0。
  - 后期未新增 Provider / 扣点：以六条源片最后一条扣点流水时间 `1784131818965` 为切点，只读查询 `VideoTask`、`CreditLedger`、`ProviderApiRequest` 均无新增记录，说明后期带声合成和四组合辑没有重新调用 Provider，也没有新增点数扣除。
- 缺口：无阻塞缺口；仅保留正式投放前真人听感、品牌音乐/旁白、授权审查和投放剪辑节奏这几个非阻塞事项。
- 建议下一步：执行线程可将第二至第四组带声预演片和四组合辑作为审核通过版本收口；如进入正式投放，补真人听感确认、品牌音频/旁白授权审查，并按投放渠道决定单条或合辑剪辑版本。
