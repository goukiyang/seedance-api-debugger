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
