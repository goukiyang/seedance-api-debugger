# 工具上传 Git 极简交接说明

这份说明用于让同事把本地工具文件夹上传到指定 Git 仓库。

核心做法：我们提供仓库地址、账号、邮箱和上传密码/Token；密码/Token 单独发送，不写进文档，不写进 prompt，不提交到 Git。

## 1. 发给同事的信息

可以直接把下面这段发给同事：

```text
请把你的工具文件夹上传到这个 Git 仓库：
https://gitlab.youdoogo.com/ai/requirements_pool.git

Git 账号：yangbo
Git 邮箱：yangbo@youdoogo.com

密码/Token 我会单独发给你，不要把密码/Token 写进任何文件、README、脚本、Git remote URL、commit message 或聊天总结。

请不要直接推 main/master。请新建分支上传：
upload/<工具名或文件夹名>

上传完成后，把分支名、commit id、工具目录、运行方式发回来。
```

## 2. 如果让 AI 帮他上传，给 AI 的 prompt

让同事把下面这段发给他的 AI：

```text
帮我把本地这个文件夹的内容上传到 Git 仓库：
<这里填本地文件夹路径>

仓库地址：
https://gitlab.youdoogo.com/ai/requirements_pool.git

Git 账号：yangbo
Git 邮箱：yangbo@youdoogo.com

要求：
1. 不要直接推 main/master。
2. 新建分支：upload/<工具名或文件夹名>
3. 提交信息写清楚，例如：feat: 上传 XXX 工具。
4. 提交前检查不要上传密码、Token、cookie、.env、node_modules、venv、dist、build、日志、大文件。
5. 如果需要密码或 Token，请单独向我索要一次，只用于本次 git push。
6. 不要把密码或 Token 写入文件、Git remote URL、commit message、README、脚本或最终总结。
7. 上传完成后告诉我：分支名、commit id、上传的文件夹、运行方式和你做过的检查。

如果 push 失败，请把报错原文发我，不要反复猜密码。
```

## 3. 密码/Token 怎么发

密码/Token 不要写在上面的说明里。

推荐单独发一条：

```text
本次 Git 上传密码/Token：<单独发送的密码或 Token>

只允许用于这次上传，不要保存，不要写进任何文件，不要写进 Git remote URL，不要在总结里复述。
```

如果条件允许，优先使用专用的临时 Token，而不是长期主账号密码。

## 4. 同事或 AI 可以执行的命令

下面是标准流程，路径和分支名按实际情况替换：

```bash
cd <工具文件夹的上级目录>
git clone https://gitlab.youdoogo.com/ai/requirements_pool.git
cd requirements_pool
git checkout -b upload/<工具名或文件夹名>
```

把工具文件夹复制进仓库后：

```bash
git status --short
git add <工具文件夹>
git commit -m "feat: 上传 XXX 工具"
git push -u origin upload/<工具名或文件夹名>
```

如果 Git 提示输入用户名和密码：

```text
Username: yangbo
Password: 使用我们单独发送的密码或 Token
```

## 5. 提交前不要上传这些

必须排除：

- `.env`
- token、cookie、密码、API key
- 私钥、证书、签名 URL
- `node_modules/`
- `venv/`、`.venv/`
- `dist/`、`build/`
- 日志文件
- 缓存文件
- 大视频、大图片、大压缩包、大模型、大数据集

如果工具依赖大文件，只写下载说明，不要直接塞进 Git。

## 6. 上传完成后回传

上传完成后，让他发回：

```text
仓库： https://gitlab.youdoogo.com/ai/requirements_pool.git
分支名：
commit id：
工具目录：
入口文件：
安装命令：
运行命令：
验证命令：
是否需要环境变量：
是否会产生费用或调用线上接口：
```

## 7. 最短版

给他仓库地址、账号和邮箱；密码/Token 单独发。让他或他的 AI 新建 `upload/<工具名>` 分支，把文件夹传上去。不要把密码写进任何地方，上传完回传分支名和 commit id。
