# sd2 server cutover commands

本文件只记录无密钥命令模板。正式切流前，仍需要先做最终数据库备份、最终媒体增量同步和登录态验收。

## 每次正式发布的强制门禁

当前源码归档、`rsync`、候选构建和 `.next-prod` 切换仍由发布任务按项目规则执行；无论是 image-studio 还是其他 sd2 更新，都必须把下面两次 preflight 当作同一次发布的前后门禁：

1. 源码同步/候选构建前：`bash ops/server/sd2/preflight.sh`
2. 候选切换、重启服务后：`EXPECT_PROD_ON_SERVER=1 bash ops/server/sd2/preflight.sh`

任一次失败都不能继续切换或把发布报为完成；它会检查正式域名、服务器服务、端口、持久运行目录软链、目录权限和数据库/媒体基本状态。

## 安装灰度服务模板

```bash
sudo install -m 0644 sd2-gray.service /etc/systemd/system/sd2-gray.service
sudo install -m 0644 sd2-finalize-pending.service /etc/systemd/system/sd2-finalize-pending.service
sudo install -m 0644 sd2-finalize-pending.timer /etc/systemd/system/sd2-finalize-pending.timer
sudo install -m 0644 sd2-video-delivery.service /etc/systemd/system/sd2-video-delivery.service
sudo install -m 0644 sd2-video-delivery.timer /etc/systemd/system/sd2-video-delivery.timer
sudo systemctl daemon-reload
sudo systemctl enable --now sd2-gray.service
```

## 灰度验证

```bash
bash ops/server/sd2/preflight.sh
```

## 正式观察

```bash
EXPECT_PROD_ON_SERVER=1 bash ops/server/sd2/preflight.sh
bash ops/server/sd2/observe.sh
```

## 安装每日 SQLite 备份

```bash
sudo install -d -o gouki -g gouki -m 0750 /var/lib/video-api-debugger/backups/daily
sudo install -d -o gouki -g gouki -m 0750 /var/log/video-api-debugger
sudo install -m 0755 sd2-backup.sh /usr/local/bin/sd2-backup.sh
sudo install -m 0644 sd2-backup.service /etc/systemd/system/sd2-backup.service
sudo install -m 0644 sd2-backup.timer /etc/systemd/system/sd2-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now sd2-backup.timer
sudo systemctl start sd2-backup.service
```

## 正式切流时才启用后台补偿

```bash
cloudflared tunnel route dns --overwrite-dns seedance2-server sd2.youdoodesign.com
sudo systemctl enable --now sd2-finalize-pending.timer
sudo systemctl enable --now sd2-video-delivery.timer
EXPECT_PROD_ON_SERVER=1 bash ops/server/sd2/preflight.sh
```

## 回滚时停用后台补偿

```bash
cloudflared tunnel route dns --overwrite-dns codex-mobile-youdoodesign sd2.youdoodesign.com
sudo systemctl disable --now sd2-finalize-pending.timer
sudo systemctl disable --now sd2-video-delivery.timer
```

完整回滚步骤见 `ops/server/sd2/rollback-to-mac.md`。不能只切 DNS；必须先把服务器数据库和媒体同步回 Mac，否则点数和任务记录会倒退。

## 必须避免

- 不提交 `.env`、数据库、媒体、`.next`、Cloudflare credential JSON。
- 不在灰度和正式 Mac 同时运行会写库的补偿任务。
- 不在未做最终增量同步前把 `sd2.youdoodesign.com` 切到服务器。
- 不把 `youdoo-sites status sd2` 当作 Mac 本地站健康判断；迁移后它应显示 `launchd=server`、`port=skip`、`local=skip`，并用公网服务器识别头判断正式入口。
