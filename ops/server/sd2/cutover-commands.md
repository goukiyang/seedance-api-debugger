# sd2 server cutover commands

本文件只记录无密钥命令模板。正式切流前，仍需要先做最终数据库备份、最终媒体增量同步和登录态验收。

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

## 必须避免

- 不提交 `.env`、数据库、媒体、`.next`、Cloudflare credential JSON。
- 不在灰度和正式 Mac 同时运行会写库的补偿任务。
- 不在未做最终增量同步前把 `sd2.youdoodesign.com` 切到服务器。
