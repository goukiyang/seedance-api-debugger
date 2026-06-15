# 工具上传 Git 交接说明

这份说明用于把你做的工具上传到我们的 Git 仓库，方便我们 review、测试、合并和后续回退。

核心原则：不要直接改主分支，不上传密钥，不上传大文件，不影响现有项目运行。

## 1. 仓库和分支

请先拉取仓库：

```bash
git clone <仓库地址>
cd <仓库名>
```

不要直接在 `main` / `master` / 线上发布分支提交。

请新建一个功能分支：

```bash
git checkout -b feature/<你的工具名>
```

示例：

```bash
git checkout -b feature/video-batch-helper
```

## 2. 推荐目录

如果这个工具是独立工具，建议放到：

```text
tools/<你的工具名>/
```

示例：

```text
tools/video-batch-helper/
```

如果这个工具已经是一个完整独立项目，也可以先单独建新仓库；但如果它要配合我们现有网站或后端使用，优先放到现有仓库的 `tools/` 目录下，方便一起 review。

## 3. 需要提交的内容

工具目录里建议至少包含：

```text
tools/<你的工具名>/
├── README.md
├── .env.example
├── package.json / requirements.txt / pyproject.toml
├── src/ 或 main.py / index.ts / app.py
├── examples/
└── scripts/ 或 tests/
```

其中：

- `README.md`：说明工具用途、安装方式、运行命令、输入输出、注意事项。
- `.env.example`：只写环境变量字段名，不写真实值。
- 依赖文件：例如 `package.json`、`requirements.txt`、`pyproject.toml`。
- 示例：放 1-2 个最小可运行示例，方便我们快速验证。
- 测试或脚本：如果有 smoke test、demo 命令、检查脚本，请一起放进去。

## 4. 禁止上传的内容

不要上传任何敏感信息，包括：

- token
- cookie
- API key
- 密码
- 账号凭据
- `.env`
- 私有证书
- 私有下载链接
- 带签名的临时 URL

不要上传可重新生成或过大的内容，包括：

- `node_modules/`
- `venv/`
- `.venv/`
- `dist/`
- `build/`
- `.next/`
- 日志文件
- 缓存文件
- 大视频、大图片、大压缩包、大模型、大数据集

如果工具必须依赖大文件，请只提交下载说明或样例小文件，不要直接把大文件塞进 Git。

## 5. 提交前自查

提交前请先看状态：

```bash
git status --short
```

确认只包含你的工具相关文件。

再检查是否误带敏感信息：

```bash
git diff --cached
```

如果还没有暂存，可以先看：

```bash
git diff
```

建议至少跑一次你自己的最小验证命令，例如：

```bash
npm install
npm run test
npm run lint
```

或 Python 项目：

```bash
pip install -r requirements.txt
python main.py --help
python scripts/smoke_test.py
```

没有测试也可以，但请提供一个能证明工具能跑起来的命令。

## 6. 提交和推送

只暂存你的工具目录：

```bash
git add tools/<你的工具名>/
```

提交信息要写清楚：

```bash
git commit -m "feat: 上传 <你的工具名> 工具"
```

推送到远端分支：

```bash
git push -u origin feature/<你的工具名>
```

不要 force push，除非我们明确约定。

## 7. 推送后发回这些信息

推送完成后，请把下面信息发回来：

```text
分支名：
工具目录：
工具入口文件：
安装依赖命令：
本地运行命令：
最小验证命令：
需要哪些环境变量：
是否依赖外部服务：
是否会产生费用：
是否会写数据库/写文件/调用线上接口：
你本地测试通过的结果：
```

示例：

```text
分支名：feature/video-batch-helper
工具目录：tools/video-batch-helper/
工具入口文件：tools/video-batch-helper/src/index.ts
安装依赖命令：npm install
本地运行命令：npm run dev
最小验证命令：npm run smoke
需要哪些环境变量：VIDEO_API_BASE_URL、VIDEO_API_KEY
是否依赖外部服务：是，调用视频生成 API
是否会产生费用：测试模式不会，真实生成会
是否会写数据库/写文件/调用线上接口：会写本地 output/，会调用接口
你本地测试通过的结果：已跑 npm run smoke，通过 3 个用例
```

## 8. Review 和合并规则

你推上来后，我们会先做这些检查：

- 目录结构是否清晰。
- 是否能按 README 跑起来。
- 是否有敏感信息。
- 是否会误改现有项目。
- 是否有最小验证命令。
- 是否需要补充配置说明。
- 是否需要拆成独立仓库。

确认没有问题后，再合并到主分支。

如果工具会调用付费接口、写线上数据库、批量请求外部服务，默认先用 dry-run 或测试模式验证，不直接跑真实任务。

## 9. 推荐 README 模板

你可以在工具目录里的 `README.md` 使用这个结构：

````markdown
# <工具名>

## 用途

说明这个工具解决什么问题。

## 安装

```bash
<安装命令>
```

## 配置

复制环境变量模板：

```bash
cp .env.example .env
```

需要配置：

- `XXX`
- `YYY`

## 运行

```bash
<运行命令>
```

## 最小验证

```bash
<验证命令>
```

## 输入输出

输入：

```text
示例输入
```

输出：

```text
示例输出
```

## 注意事项

- 是否会产生费用。
- 是否会写数据库。
- 是否会上传文件。
- 是否会调用线上接口。
````

## 10. 一句话版

新建 `feature/<工具名>` 分支，把工具放进 `tools/<工具名>/`，补齐 README、依赖文件、`.env.example` 和最小验证命令，不上传密钥和大文件，推送后把分支名、入口文件、运行命令和测试结果发回来。
