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

### 2026-08-13 Seedance 2.5 视频模型入口规划风险项只读审查

- 结论：不通过。
- 审查对象：`tasks/todo/2026-08-13-seedance-25-video-model.md`，主题为“Seedance 2.5 视频模型入口规划的出错风险项是否闭环”。
- 阻塞问题：
  - 线上部署链路未闭环，且与当前项目规则冲突。规划 T8 仍要求执行 Mac 本地 `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`、`restart sd2`，并检查 `sd2.youdoodesign.com`、`youdoo-sites status sd2`、LaunchAgent `runs`。但当前 `AGENTS.md` 明确规定正式生产入口是 `https://sd2.youdooart.com`，长期使用腾讯云 Ubuntu 服务器版，旧 `sd2.youdoodesign.com` / Mac Cloudflare Tunnel 不再作为生产入口；部署必须走本地 commit / rollback tag -> `git archive` -> 上传服务器 -> `/srv/video-api-debugger/releases/<commit>` -> `rsync` 到 `/srv/video-api-debugger/app` -> `NEXT_DIST_DIR=.next-prod-candidate npm run build` -> 切换 `.next-prod` -> 重启 `sd2-gray.service` -> 验证 `127.0.0.1:3302` 和公网 `sd2.youdooart.com`。当前规划没有按该服务器版规则写部署和验收，因此不能作为执行依据。
- 已闭环风险项：
  - 模型 ID 风险：规划写明新增模型 `dreamina-seedance-2-5-260628`，并保留稳定默认 `dreamina-seedance-2-0-260128`。
  - 2.0 / 2.5 选择透传风险：T2/T3 要求 `/api/tasks/create`、`VideoTask.model`、`providerInput.model`、`ProviderApiRequest.requestPayload`、`taskParams`、返回 JSON 和 provider payload 使用同一个 `selectedModel`。
  - 未知模型透传风险：T1/T7/R2 要求白名单解析，未知 `body.model` 回退默认或返回清晰 400，且 smoke 覆盖“未知模型不会透传”。
  - 前端入口位置风险：T4/R1 明确入口必须放在 `/generate` 底部参数栏当前 `Seedance 2.0` chip 的下拉里，不新增页面、不新增顶部大按钮。
  - `/api/config` / 无线画布同步风险：T6 要求 `/api/config` 返回 `model_options`，无线画布 `capabilities.video` 同步默认模型和允许模型列表，外部 API 说明也同步 2.0 / 2.5 白名单模型。
  - 真实付费生成停止条件：T9 明确没有用户授权前不跑真实 Seedance 2.5 生成；授权后才用最小 4 秒、480p 样例并核对点数和成本闭环。
  - Git 脏改隔离风险：T8 明确保护当前已有 `tasks/todo.md`、`tasks/todo/hygiene-log.md` 脏改，本轮改动用精确暂存、清晰 commit 并 push。
  - 独立审核风险：R4 要求派给固定审核线程只读审查，并追加到 `tasks/audit-001-review.md` 后回执。
- 未闭环或需修正风险项：
  - 必须删除或改写 T8/R3 中旧 Mac `youdoo-sites`、`sd2.youdoodesign.com`、LaunchAgent `runs` 作为生产部署/验收依据的内容，改成当前服务器版 `sd2.youdooart.com`、`42.193.221.253`、`sd2-gray.service`、`/srv/video-api-debugger/app`、`.next-prod-candidate` 和公网资源/DOM 验证。
  - 规划第 7 行同时写 `sd2.youdoodesign.com` / `sd2.youdooart.com` 当前生产服务，容易让执行线程把旧域名当生产入口；应改为只以 `sd2.youdooart.com` 为正式生产入口，旧域名最多作为迁移/停用状态确认。
  - 服务器部署验收还缺明确的候选构建失败回滚条件和排除运行期产物清单引用；应在 T8 或 R3 中直接引用项目 `AGENTS.md` 的服务器部署规则，避免部署时覆盖 `.env`、`storage`、`public/uploads`、数据库和 `.next-prod`。
- 非阻塞风险：
  - 文档依据来自用户提供的动态文档链接，本轮只读审查未联网复核该文档当前内容；执行前如模型 ID 或接口字段有时效风险，应再由执行线程用官方/一手来源确认一次。
  - T1 允许“未知模型自动回退默认或返回清晰 400”两种行为，安全性都可接受，但体验和测试期望应在实现前选定一种，避免前后端错误提示和 smoke 断言不一致。
- 证据：
  - `tasks/todo/2026-08-13-seedance-25-video-model.md:13-16` 写入模型白名单、2.0 默认、2.5 可选和未知模型不得透传。
  - `tasks/todo/2026-08-13-seedance-25-video-model.md:18-26` 写入 `/api/tasks/create` 到 provider payload 的 `selectedModel` 一致性要求。
  - `tasks/todo/2026-08-13-seedance-25-video-model.md:28-40` 写入底部模型 chip 入口、`/api/config`、无线画布和外部 API 同步要求。
  - `tasks/todo/2026-08-13-seedance-25-video-model.md:42-56` 写入 mock smoke、未知模型不透传、保护脏改、真实付费生成需单独授权。
  - `tasks/todo/2026-08-13-seedance-25-video-model.md:47-51` 仍写旧 Mac `youdoo-sites` 构建/重启、`sd2.youdoodesign.com`、LaunchAgent `runs`；`tasks/todo/2026-08-13-seedance-25-video-model.md:72-75` 的 R3 也仍以 `youdoo-sites build/restart/status sd2` 作为线上部署验收对象。
  - `AGENTS.md:31-53` 明确当前生产链路为服务器版：`sd2.youdooart.com`、`42.193.221.253`、`sd2-gray.service`、`/srv/video-api-debugger/app`、`.next-prod-candidate` 构建和公网 `sd2.youdooart.com` 验证，并说明不再用 Mac `youdoo-sites` 当生产部署链路。
  - `AGENTS.md:71-74` 再次要求用户可见页面/服务器版 sd2 改动必须按服务器生产托管规则完成，并用公网静态资源、DOM、截图或 API 响应证明新构建已加载。
  - `git status --short --branch` 显示当前分支 `codex/video-delivery-fast-path...origin/codex/video-delivery-fast-path`，已有脏改为 `tasks/todo.md`、`tasks/todo/hygiene-log.md`；这与规划 T8 提到的脏改隔离对象一致。
- 建议下一步：
  - 先修正规划 T8/R3 和目标复述中的生产入口与部署链路，统一为服务器版 `sd2.youdooart.com`。
  - 将部署步骤改为：本地形成 commit / rollback tag、`git archive` 上传服务器、解压 release、排除运行期产物 `rsync` 到 app、服务器候选构建 `.next-prod-candidate`、切换 `.next-prod`、重启 `sd2-gray.service`、验证服务器本地 `127.0.0.1:3302` 和公网 `https://sd2.youdooart.com`。
  - 修正后再进入实现；实现完成后按 R1/R2/R3/R4 做只读复审，真实 2.5 付费生成继续等用户单独授权。

### 2026-08-13 Seedance 2.5 视频模型入口实现与上线只读审核

- 结论：不通过。
- 审查对象：video-api-debugger / sd2 公开视频生成平台；代码审核路径 `/Volumes/Data/Projects/video-api-debugger-worktrees/seedance-25-video-model`；分支 `codex/seedance-25-video-model`；目标提交 `1889e015f1d5fb59686e99d7bb9ac0497e39fe82`；线上域名 `https://sd2.youdooart.com`。
- 阻塞问题：
  - 当前公网线上不可用，不能通过上线审核。只读复查时 `https://sd2.youdooart.com/api/config`、`https://sd2.youdooart.com/login`、`https://sd2.youdooart.com/generate` 均返回 `502 Bad Gateway`，响应头带 `X-SD2-Origin: server-42-193`，说明请求已到服务器入口但 nginx 上游不可用或服务未正常响应。该结果直接推翻“公网 `/api/config` 200、`/login` 200、`/generate` 静态 chunk 可验证”的上线证据。
  - 本线程无法用 SSH 复核服务器本机状态：`ssh gouki@42.193.221.253 ...` 返回 `Permission denied (publickey)`，因此无法独立确认 `sd2-gray.service`、服务器 `.next-prod/BUILD_ID`、`127.0.0.1:3302` 和 live 静态资源状态。结合公网 502，线上证据不足以通过。
- 已通过的代码层证据：
  - 模型 ID 和白名单：`src/lib/provider/seedance-models.ts` 定义 `dreamina-seedance-2-0-260128` 为默认，`dreamina-seedance-2-5-260628` 为 2.5 选项；`parseSeedanceVideoModel` 对未知模型返回错误，不透传任意字符串。
  - 入口位置：`GeneratePageClient` 对普通生成页传入 `SEEDANCE_VIDEO_MODEL_OPTIONS`，IP 页继续传入 `VOLCENGINE_IP_MODEL_OPTIONS`；`GenerationComposer` 将 `selectedModel` 放入提交参数；`ComposerActionBar` 在既有模型 chip 上渲染下拉选项，显示 label 和 detail。
  - 后端校验和传递：`/api/tasks/create` 调用 `parseSeedanceVideoModel(body.model)`，将 `selectedModel` 写入 `providerInput.model`、snapshot `providerPayloadJson`、`taskParams.model`、`VideoTask.model`、`ProviderApiRequest.requestPayload` 和创建响应 `model`。
  - Provider payload：`src/lib/provider/jimeng.ts` 使用 `resolveSeedanceVideoModel(input.model)` 构造 payload 的 `model`，不再固定只发 2.0；`getProviderConfig` 暴露默认模型和 `model_options`。
  - 配置同步：`/api/config` 返回 `model_options`；ultimate-canvas bootstrap 的 `capabilities.video` 和 `interaction` 都暴露 `model_options`。
  - 计费快照：`calculateEstimatedCost` 支持传入模型显示名，创建任务侧使用 `seedanceVideoModelLabel(selectedModel)`。
- 已通过的本地只读验证：
  - `npx tsx scripts/seedance-model-select-smoke.ts` 通过，输出 provider payload `Model: dreamina-seedance-2-5-260628`，并确认 2.5 options、未知模型拒绝、provider payload.model。
  - `npx tsx scripts/volcengine-ip-generate-model-select-smoke.ts` 通过，说明火山 IP 生成页模型选项未被 Seedance 选项覆盖。
  - `npx tsx scripts/provider-create-error-smoke.ts` 通过，保留 Provider 创建错误解析能力。
  - `git diff --check` 通过。
  - 本地 `.next-prod-candidate` 中能 grep 到 `Seedance 2.5` 与 `dreamina-seedance-2-5-260628`，但本地 candidate `BUILD_ID=7wzL5qsuw8gQnN5_H-bYJ`，不是工单给出的线上 `V4bDqseASHnQksHCbut8h`，不能替代 live 证据。
- 版本和回滚证据：
  - 当前 worktree HEAD 为 `55ea3926518a80bb2fa14875afa43aaee09307cc`，远端 `origin/codex/seedance-25-video-model` 也指向 `55ea392`，不是工单列出的目标提交 `1889e015...`。`1889e015` 仍是当前分支历史中的 Seedance 2.5 功能提交，后续 `55ea392` 是资产兼容修复提交。
  - `rollback/2026-08-13-before-seedance-25-video-model^{}` 解析到 `7e82e80c1fe8b2c97dcfd0b1dea2a6b105de8042`，回滚点本地可见；远端 tag 也可见。
  - `/Volumes/Data/Projects/project-version-registry.md` 记录了 Seedance 2.5 v0.9.59 和后续另一个同版本号的历史上传资源兼容修复版，版本登记存在同日同版本号复用，易造成定位混淆。
- 缺口/风险：
  - 线上 `502` 是阻塞缺口，必须先恢复服务并重新验证公网 `/api/config`、`/login`、`/generate`。
  - 审核时 SSH 权限不可用，无法独立复核服务器 BUILD_ID、`sd2-gray.service`、3302 监听和服务器本机 `/api/config`；需要执行线程提供可复核输出或恢复审核线程 SSH 只读访问。
  - 工单给的提交/BUILD_ID 与当前分支/本地 candidate/版本登记后续状态不一致；后续回执应明确当前线上到底审核 `1889e015` 还是包含 `55ea392` 的 HEAD，避免把旧证据冒充当前 live 状态。
  - 未做真实付费生成本身不构成不通过；规划和 smoke 已证明不消耗点数的停止条件，真实扣费生成可继续等用户明确授权。
- 建议下一步：
  - 执行线程先修复服务器 502，确认 `sd2-gray.service` active、`NRestarts`、`/srv/video-api-debugger/app/.next-prod/BUILD_ID`、`127.0.0.1:3302/api/config` 和公网 `https://sd2.youdooart.com/api/config` 均正常。
  - 重新提供当前 live HEAD、BUILD_ID、静态 chunk、rollback tag 和版本登记，明确是否以 `55ea392` 为最终审核版本。
  - 恢复后再发固定只读复审；复审重点只需补线上可用性、BUILD_ID/静态 chunk 与当前 HEAD 对齐、`/api/config` model_options 和 `/generate` 入口可见。

### 2026-08-13 Seedance 2.5 视频模型入口最终线上 HEAD 复核

- 日期：2026-08-13
- 审查对象：`video-api-debugger / sd2` Seedance 2.5 视频模型入口；功能提交 `1889e015f1d5fb59686e99d7bb9ac0497e39fe82`，当前最终线上 HEAD `55ea3926518a80bb2fa14875afa43aaee09307cc`
- 结论：通过
- 阻塞问题：无。本轮复核确认此前因公网 502 和线上 HEAD 记录不一致导致的不通过项已闭环；当前公网 API 与登录入口恢复，最终线上 HEAD 与远端分支、版本登记已对齐。
- 非阻塞风险：
  - 本审核线程 SSH 到 `42.193.221.253` 仍返回 `Permission denied (publickey)`，因此未能独立读取服务器本机 `sd2-gray.service`、`.next-prod/BUILD_ID` 和 live 静态 chunk；本结论基于公网 HTTP 证据、Git/registry 证据、当前 HEAD smoke 证据，以及执行线程补充的服务器本机证据综合判断。
  - 未做真实付费生成，符合本轮“不执行真实付费生成”的停止条件；后续若要确认 2.5 官方端真实出片，需要用户单独授权消耗点数。
  - 登录态 `/generate` DOM 自动读取仍不是本审核线程的独立证据；当前以公网 `/api/config`、同源 `/login`、匿名 `/generate` 跳转、smoke 与静态资源命中证据替代。后续如需更强 UI 证据，应补一次真实登录浏览器验收。
  - `/Volumes/Data/Projects/project-version-registry.md` 存在同为 `v0.9.59` 的历史上传资源兼容记录，最新顶部记录已澄清 Seedance 功能提交、最终线上 HEAD 和 BUILD_ID；建议后续版本登记避免复用同一版本号造成审计混淆。
- 证据：
  - Git 本地状态为 `codex/seedance-25-video-model...origin/codex/seedance-25-video-model` 且干净；本地 `HEAD` 为 `55ea3926518a80bb2fa14875afa43aaee09307cc`。
  - 最近提交链为 `55ea392 fix(assets): 兼容服务器域名下的历史上传资源` 在 `1889e01 feat: 接入 Seedance 2.5 视频模型入口` 之后；`git diff --name-status 1889e015...55ea392` 仅涉及资产 URL、历史上传、reference image content、workspace/template 资产兼容与对应 smoke 脚本，未见 Seedance 模型选择、任务创建、provider payload 或 `/api/config` 链路文件被二次改动。
  - 远端 `origin/codex/seedance-25-video-model` 指向 `55ea3926518a80bb2fa14875afa43aaee09307cc`；rollback tag `rollback/2026-08-13-before-seedance-25-video-model^{}` 指向 `7e82e80c1fe8b2c97dcfd0b1dea2a6b105de8042`，远端 tag peeled 结果一致。
  - 当前 HEAD 复跑 `npx tsx scripts/seedance-model-select-smoke.ts` 通过，输出确认 `provider payload.model=dreamina-seedance-2-5-260628`、2.5 options 存在、未知模型拒绝逻辑仍有效。
  - 公网 `https://sd2.youdooart.com/api/config` 返回 `HTTP/1.1 200 OK`，响应头包含 `X-SD2-Origin: server-42-193`，响应 JSON 检查确认包含 `dreamina-seedance-2-5-260628`。
  - 公网 `https://sd2.youdooart.com/login` 返回 `HTTP/1.1 200 OK` 且同样带 `X-SD2-Origin: server-42-193`；匿名访问 `https://sd2.youdooart.com/generate` 返回 `307 Temporary Redirect` 到同域 `/login?next=%2Fgenerate`，符合未登录访问生成页的预期。
  - `/Volumes/Data/Projects/project-version-registry.md` 顶部 v0.9.59 记录已写明 Seedance 功能提交 `1889e015...`、当前最终线上 HEAD `55ea392...`、rollback tag `7e82e80...`、线上 BUILD_ID `xohpDio2xK39wmKoojg8E`、目标域名 `https://sd2.youdooart.com`、服务 `sd2-gray.service`，并保留 Seedance 2.5 模型 ID 与验证摘要。
- 建议下一步：
  - 可以把本轮 Seedance 2.5 模型入口视为“代码链路 + Git/rollback + 公网可用性”审核通过，继续后续产品验收或发布收口。
  - 若进入最终发布证明阶段，建议补一次有登录态的 `/generate` 页面 DOM/截图验收，确认底部模型 chip 在真实页面可见且默认仍为 Seedance 2.0。
  - 若要做真实 2.5 生成闭环，必须另行获得用户明确授权后再消耗点数。
