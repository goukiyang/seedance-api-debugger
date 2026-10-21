# Ubuntu 24 部署文档

## sd2 现网发布入口（2026-10-21）

`sd2.youdooart.com` 已有生产数据与持久启动屏障，**只走本节保护流程**。下方从零安装示例不是现网更新、迁移、回退或删目录命令，不得直接执行。所有候选、日志与发布材料沿真实挂载的 `/data`；只回程序，不回业务数据库、价格、媒体、账本、回执或历史证书。

固定准备入口为 `ops/sd2-release-prepare.mjs`，控制来源由同目录 `sd2-release-profile.json` 锁定。它先逐字核实正式根私有 `docs/materials/2026-10-19-upload-unknown-recovery/release-r16/` 的36个成功控制模块及原成功证据；ADMIN-USAGE另封新控制包，经profile的promotion精确锁定新增及允许变动文件，其余原模块逐字保留，不另建发布引擎、不上传私有材料到Git。r16及其原run只读，禁止复制旧run/PID/价格修订冒新鲜现场。根因及原附件见正式根费率工单§24.5。

```bash
node ops/sd2-release-prepare.mjs check-template /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-19-upload-unknown-recovery
ssh -o BatchMode=yes root@42.193.221.253 'node --input-type=module' < ops/sd2-release-live-capture.mjs > /ABSOLUTE/PRIVATE/live.json 2> /ABSOLUTE/PRIVATE/live-proof.json
node ops/sd2-release-prepare.mjs prepare /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-19-upload-unknown-recovery /ABSOLUTE/PRIVATE/plan.json
```

本机准备只读Git与原证，并独占创建私有新目录；不连服务器、不登记窗口、不上传、不停站。输入为 `sd2-release-plan.v1`，字段仅 `schema/repoRoot/outputRoot/liveCapture/contract/reuseBuilds`：

- `contract` 使用原控制 `MV_DIRECT` 的完整字段，按本次已审源码填写，不能自动套用旧批准范围。`sourceBase`只管Git祖先；`baselineSource/version/build/starts`只管当前运行；原证书身份留在未改动的历史校验模块。main/guard必须不同且均以真实完整SHA、精确变更集合、真实版本及固定ref锁定。
- `liveCapture` 为五分钟内只读实际捕获的 `observedAt/source/version/build/starts/pricingRevision/allowedSha256`，六角色启动身份必须齐全并与contract相等。`pricingRevision`明确取`pricing_policy_v1.revision`，不是`pricing_authoring_v1.revision`；薄只读入口`sd2-release-live-capture.mjs`沿该字段及真实units读取，并拒绝角色同源的未受管进程，不读Environment/env正文。本机格式校验不证明服务器仍未变化，stage及切换前原控制必须重新核对。合法guard来源不能误填退役清单，但它的旧PID和整个进程组仍须自然排尽。
- `reuseBuilds: null` 表示新源码完整构建；只有同main/guard整对已成功时才传 `{sourceRun,directory}` 指向两份原 `*-immutable-success.json`。入口生成完整reuse schema和两份原证SHA。服务器仍必须核源、依赖、环境、Node、工程输入、compiled/check字节及metadata不变，另出fresh准入；不改原构建时间、不混新旧pair，不因复用失败自动重编译掩盖漂移。
- `outputRoot` 必须是私有资料目录下不存在的新目录；失败保留原run，不能新建run来清零累计失败。输出 `run.mjs`、`control/` 和 `preparation.json`。其 `localPreparationOnly` 不是发布许可或功能验收。

正常后续只用新目录 `run.mjs package/window/stage` 接原控制的 `control-preflight`、prepare/build/verify、Review和保护switch。先整批跑原九组控制及新增role控制工程检查、维护前真实配置/证书/回退/HD准入，再决定是否构建；可变连接/在途/权限条件在切换时仍重核。维护批准依旧五分钟有效，并绑定原manifest、窗口、控制和候选回执SHA；复用时 `candidateEvidenceKind` 必须取 `preparation.json` 的 `sd2-candidate-build-reuse.v1`，不能漏字段或拿旧批准续签。本机生成器不代签维护批准。

本站独立无缓冲日志、精确nginx配置指纹、合法运行目录别名与root控制文件分读、fixture真实helper绑定、HD闭合缓存精确表、保留证书两条恢复路径均来自锁定控制。发现新现场不在精确表或控制变更时，先只读集中复盘，必要修正另封新包、统一原生验证和Review后更新profile；不得放宽门、删证书、改历史文件或一边停站一边补检查。价格全字段前后相等、原进程自然排空、启动屏障、相容guard和公网产物核对不减少。

本次ADMIN-USAGE联合批已证的四类准入适配须沿用，不重新试停站：价格修订只取上面的policy key；退役HD恢复VM须提供实际`restoreOriginalUsageRole`绑定，不能仅加允许清单；本机prepare完成退出0且preparation/manifest均已存在后才顺序package/window/stage，不并发消费未生成目录；e01的闭合缓存例外只认已核源码、tsx/esbuild/Node及实际编译字节，原inode/owner/mode/时序、锁与进程组排尽检查均保留，不清缓存或用哈希相同代生命周期结束。四类失败及范围变更后的旧成功main证据保留，不能靠新run号清零；用户扩范围后需新main/相容guard整对完整构建，不复用旧业务产物。

统一离线工程检查：`node ops/sd2-release-prepare.test.mjs /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-19-upload-unknown-recovery`。仅检查工具、原证与生成接线，不运行任何服务器动作或功能验收。新入口首次真实发布效果须在下一次获授权发布时记录；不能把本轮离线检查说成又一次上线成功。

### 使用归属增量表（ADMIN-USAGE）

`0.101.0`新增`UsageAttribution`只读统计归属能力，首次启用新writer前必须单独完成以下增量准备，不运行`db:push`或自动回填，不改旧业务行、配置、账本或回执。它不是降级正常发布门的故障恢复通道。

1. 新main及相容guard必须各完成真实完整构建与内置工程门，再由同一lead完成源码Review。新reader允许归属表或旧行缺失；guard须保留新后台合同，不混用旧成功pair。原程序无需该表，新增空表不改变其查询。
2. 从本次冻结main候选内运行`ops/sd2-usage-attribution-migrate.py`，传本次私有manifest及已核manifest/SQL SHA256；脚本默认仅预检，显式`--apply`才写。它核真实`/data`挂载与空间，生成同一时点的SQLite备份并做完整性/原schema及数量核对，留独占恢复点后仅执行一张表及三个索引。
3. 迁移回执须证明原schema/原业务行未改变、新表为空、无历史回填，且绑定同run/main/guard/manifest/SQL；同run重复检查还须核新表/索引定义与原备份SHA。缺回执、半成品、结构变化或空间/挂载异常都停止，保留备份及失败证据，不覆盖重试或改用系统盘。
4. 旧程序仍运行时确认增量表兼容及迁移回执，再沿原控制重新取得正常fresh准入，排尽原进程并保护切换。迁移不替代原九组控制、价格全字段、HD/上传、数据/权限和公网健康检查。后续相容程序回退保留此表及已写归属，不恢复备份、不删除新表或重写业务数据。
5. 独立角色coordinator也首建文字Attempt，必须与Web/image/HD同批纳入：真实unit与TasksMax128保持、原配置只做不输出正文的指纹保护，临时禁止强杀且SIGTERM等待完整进程组退出；正常切换及相容guard恢复都实际启动同批角色writer。新持久启动门核确切pair源码/BUILD/归属helper和新表定义，runtime核实际PID与已加载源码。作品渲染和模板提示词后台不首建本批事实，保留原进程，不能用“都重启过”代覆盖证据。

迁移schema、备份/恢复与旧reader兼容在同一候选的内置隔离工程门记录；它不访问应用数据库，也不是U01–U13功能验收。首次真实迁移/切换证据登记正式根ADMIN-USAGE工单§13，未取得真实回执前不得称已迁移或已部署。

本文档用于将 `video-api-debugger` 部署到 Ubuntu 24.04 LTS 单机环境。当前项目使用 Next.js 14、Prisma、SQLite，并存在运行时上传文件，因此推荐先使用带持久磁盘的 VPS / 云服务器部署；不要直接把当前形态部署到无持久文件系统的 Serverless 平台。

## 1. 部署结论

- 推荐环境：Ubuntu 24.04 LTS + Node.js 20 LTS + Nginx + systemd。
- 推荐数据库：短期使用 SQLite 绝对路径，例如 `file:/var/lib/video-api-debugger/prod.db`。
- 推荐上传闭环：生产必须配置 Cloudflare R2 或火山引擎 TOS，确保上传素材能被 Seedance 从公网访问。
- 不建议生产使用 `db:push`；生产数据库迁移只使用 `npx prisma migrate deploy`。
- 不把 `.env`、SQLite 数据库、本地上传目录、`.next`、`node_modules` 打进发布包。

## 2. 上线前检查

在本地发布前先完成：

```bash
npm ci
npx prisma generate
npm run build
```

如需 lint，当前项目的 `npm run lint` 会触发 Next.js 交互式 ESLint 初始化提示，说明仓库尚未固化 ESLint 配置。上线前不能把这个交互提示当成 lint 通过。

确认发布包不包含以下内容：

```text
.env
.env.local
.env.*.local
*.db
*.sqlite
*.sqlite3
.next/
.vercel/
node_modules/
storage/
public/uploads/assets/
public/uploads/thumbs/
test-api.sh
*.tsbuildinfo
```

本轮已生成的本地发布包示例：

```text
/tmp/video-api-debugger-20260515184052.tar.gz
sha256: e341ab6daebb7f78caafe9289574232c0660f92ad87903e181ae306691308fde
```

如果后续重新打包，应以最新包为准。

## 3. 服务器基础准备

以具备 sudo 权限的用户登录服务器：

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg nginx sqlite3 unzip
```

安装 Node.js 20 LTS：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

创建运行用户和目录：

```bash
sudo useradd --system --create-home --home-dir /var/lib/video-api-debugger --shell /usr/sbin/nologin videoapi
sudo mkdir -p /opt/video-api-debugger/releases
sudo mkdir -p /opt/video-api-debugger/shared
sudo mkdir -p /var/lib/video-api-debugger/public/uploads
sudo mkdir -p /var/lib/video-api-debugger/public/videos
sudo chown -R videoapi:videoapi /opt/video-api-debugger /var/lib/video-api-debugger
```

## 4. 上传并解压发布包

在本地上传发布包：

```bash
scp /tmp/video-api-debugger-20260515184052.tar.gz ubuntu@YOUR_SERVER_IP:/tmp/
```

在服务器解压：

```bash
release=20260515184052
sudo mkdir -p /opt/video-api-debugger/releases/$release
sudo tar -xzf /tmp/video-api-debugger-$release.tar.gz -C /opt/video-api-debugger/releases/$release --strip-components=1
sudo cp -an /opt/video-api-debugger/releases/$release/public/videos/. /var/lib/video-api-debugger/public/videos/ 2>/dev/null || true
sudo rm -rf /opt/video-api-debugger/releases/$release/public/uploads
sudo rm -rf /opt/video-api-debugger/releases/$release/public/videos
sudo ln -s /var/lib/video-api-debugger/public/uploads /opt/video-api-debugger/releases/$release/public/uploads
sudo ln -s /var/lib/video-api-debugger/public/videos /opt/video-api-debugger/releases/$release/public/videos
sudo chown -R videoapi:videoapi /opt/video-api-debugger/releases/$release
sudo chown -R videoapi:videoapi /var/lib/video-api-debugger
sudo ln -sfn /opt/video-api-debugger/releases/$release /opt/video-api-debugger/current
```

这里必须把 `public/uploads` 和 `public/videos` 指向持久目录：

- 上传接口会在运行时写入 `public/uploads`。
- 视频下载接口会在运行时写入 `public/videos`。
- 如果不做 symlink，重新发布或清理 release 目录后，本地文件会丢失。

## 5. 生产环境变量

创建服务端环境文件：

```bash
sudo install -o root -g videoapi -m 0640 /dev/null /etc/video-api-debugger.env
sudo nano /etc/video-api-debugger.env
```

参考模板：

```env
NODE_ENV=production
PORT=3000

DATABASE_URL="file:/var/lib/video-api-debugger/prod.db"
SESSION_SECRET="replace-with-a-long-random-secret"
REGISTRATION_SECRET="replace-with-a-long-random-secret"

NEXT_PUBLIC_BASE_URL="https://your-domain.example.com"

SEEDANCE_API_KEY="replace-with-provider-key"
SEEDANCE_BASE_URL="https://etc.seedance-api.net/server/api"

# 注册邮件验证按需开启
REGISTER_EMAIL_VERIFICATION="false"
REGISTER_EMAIL_DEBUG="false"
RESEND_API_KEY=""
AUTH_EMAIL_FROM=""
EMAIL_FROM=""

# Cloudflare R2，推荐生产配置
R2_ACCOUNT_ID=""
R2_ACCESS_KEY_ID=""
R2_SECRET_ACCESS_KEY=""
R2_BUCKET=""
R2_PUBLIC_BASE_URL=""

# 或火山引擎 TOS，二选一
TOS_REGION=""
TOS_BUCKET=""
TOS_ENDPOINT=""
TOS_ACCESS_KEY=""
TOS_SECRET_KEY=""
TOS_PUBLIC_BASE_URL=""
```

注意：

- `SESSION_SECRET` 和 `REGISTRATION_SECRET` 必须使用强随机值。
- `NEXT_PUBLIC_BASE_URL` 必须是正式公网 HTTPS 域名。
- R2/TOS 至少配置一套，否则上传素材会回退本地路径，Seedance 可能无法访问。
- 不要把 `/etc/video-api-debugger.env` 放入代码仓库或发布包。

## 6. 安装依赖与迁移数据库

在服务器执行：

```bash
cd /opt/video-api-debugger/current
sudo -u videoapi npm ci
sudo -u videoapi npx prisma generate
sudo -u videoapi bash -lc 'set -a; source /etc/video-api-debugger.env; set +a; npx prisma migrate deploy'
sudo -u videoapi bash -lc 'set -a; source /etc/video-api-debugger.env; set +a; npm run build'
```

上述命令会从 `/etc/video-api-debugger.env` 加载变量，避免把密钥展开到命令行参数里。

如果需要创建管理员账号，必须在确认生产环境变量和初始密码策略后再执行种子脚本。该脚本会写数据库，不应作为默认部署步骤自动执行。

## 7. systemd 服务

创建服务文件：

```bash
sudo nano /etc/systemd/system/video-api-debugger.service
```

写入：

```ini
[Unit]
Description=video-api-debugger Next.js service
After=network.target

[Service]
Type=simple
User=videoapi
Group=videoapi
WorkingDirectory=/opt/video-api-debugger/current
EnvironmentFile=/etc/video-api-debugger.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable video-api-debugger
sudo systemctl start video-api-debugger
sudo systemctl status video-api-debugger --no-pager
```

查看日志：

```bash
sudo journalctl -u video-api-debugger -n 100 --no-pager
```

本机健康检查：

```bash
curl -I http://127.0.0.1:3000
curl http://127.0.0.1:3000/api/config
```

## 8. Nginx 反向代理

创建站点配置：

```bash
sudo nano /etc/nginx/sites-available/video-api-debugger
```

写入：

```nginx
server {
    listen 80;
    server_name your-domain.example.com;

    client_max_body_size 60m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

启用站点：

```bash
sudo ln -sfn /etc/nginx/sites-available/video-api-debugger /etc/nginx/sites-enabled/video-api-debugger
sudo nginx -t
sudo systemctl reload nginx
```

如使用 UFW：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 9. HTTPS

建议使用 Certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.example.com
```

证书签发后确认：

```bash
curl -I https://your-domain.example.com
```

## 10. 上线后冒烟测试

按以下顺序验证：

1. 打开首页和登录页。
2. 登录管理员账号。
3. 访问 `/api/config`，确认不会泄露完整 API Key。
4. 上传图片，确认返回的是 HTTPS 公网 URL。
5. 使用上传素材创建视频任务。
6. 查询任务状态，确认 provider task id、状态轮询和错误展示正常。
7. 成功后预览与下载视频。
8. 验证点数冻结、扣减、失败退回。
9. 访问后台用户、任务、成本、反馈页面。
10. 重启服务后确认数据库记录和已上传资产仍可用。

重启验证：

```bash
sudo systemctl restart video-api-debugger
sudo journalctl -u video-api-debugger -n 100 --no-pager
```

## 11. 备份与回滚

SQLite 备份：

```bash
sudo systemctl stop video-api-debugger
sudo -u videoapi sqlite3 /var/lib/video-api-debugger/prod.db ".backup '/var/lib/video-api-debugger/prod-$(date +%Y%m%d%H%M%S).db'"
sudo systemctl start video-api-debugger
```

发布目录回滚：

```bash
sudo ln -sfn /opt/video-api-debugger/releases/PREVIOUS_RELEASE /opt/video-api-debugger/current
sudo systemctl restart video-api-debugger
```

注意：

- 如果本次发布执行过数据库迁移，代码回滚不等于数据库回滚。
- 数据库回滚必须基于上线前备份单独执行。

## 12. 常见问题

### 构建成功但上传素材不可用

优先检查 R2/TOS 环境变量和 `NEXT_PUBLIC_BASE_URL`。生产环境不要依赖本地 `/uploads/...` 路径完成 Seedance 闭环。

### `prisma migrate deploy` 失败

确认：

- `DATABASE_URL` 使用 SQLite 绝对路径。
- `/var/lib/video-api-debugger` 对 `videoapi` 用户可写。
- `prisma/migrations` 已包含在发布包中。

### Nginx 413 请求体过大

确认站点配置里存在：

```nginx
client_max_body_size 60m;
```

项目上传接口当前最大允许 50MB，Nginx 应略高于应用限制。

### 服务启动后 502

按顺序检查：

```bash
sudo systemctl status video-api-debugger --no-pager
sudo journalctl -u video-api-debugger -n 100 --no-pager
curl -I http://127.0.0.1:3000
sudo nginx -t
```

## 13. 后续产品化建议

- 将 SQLite 迁移到 PostgreSQL 或 MySQL。
- 将所有运行时文件写入统一改为对象存储。
- 固化 ESLint 配置，让 `npm run lint` 可非交互执行。
- 建立 CI：安装依赖、Prisma generate、lint、build、发布包抽检。
- 补齐 `.env.example`，覆盖源码实际使用的生产变量。
