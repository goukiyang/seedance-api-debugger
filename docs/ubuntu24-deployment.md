# Ubuntu 24 部署文档

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
