# sd2 回滚到 Mac 手册

本文件只记录无密钥步骤。默认不要回滚；优先修服务器。只有服务器正式站无法恢复，且必须临时回到 Mac 时才执行。

## 硬规则

- 不能直接把 DNS 切回 Mac。切流后服务器数据库已经可能有新任务、新扣点、新结算和新媒体；直接切回 Mac 会让点数和任务记录倒退。
- 回滚前必须先停服务器写入型后台任务，再把服务器数据库和媒体同步回 Mac。
- 回滚时只能有一边写库：服务器或 Mac，不能两边同时跑生成、结算、补偿。

## 回滚步骤

1. 停服务器后台补偿，避免回滚同步期间继续写库。

```bash
ssh root@42.193.221.253 'systemctl disable --now sd2-finalize-pending.timer sd2-video-delivery.timer'
```

2. 在服务器做回滚前数据库快照。

```bash
ssh root@42.193.221.253 '/usr/local/bin/sd2-backup.sh'
```

3. 确认 Mac 仍处于停机备用状态，并备份 Mac 当前数据库。

```bash
uid="$(id -u)"
launchctl bootout "gui/${uid}" /Users/gouki-youdoo/Library/LaunchAgents/com.youdoo.site.sd2.plist 2>/dev/null || true
launchctl bootout "gui/${uid}" /Users/gouki-youdoo/Library/LaunchAgents/com.youdoo.sd2.finalize-pending-videos.plist 2>/dev/null || true
launchctl bootout "gui/${uid}" /Users/gouki-youdoo/Library/LaunchAgents/com.youdoo.sd2.video-delivery-worker.plist 2>/dev/null || true
cp /Volumes/Data/Projects/video-api-debugger-v12-full-todo/prisma/dev.db "/Volumes/Data/Projects/video-api-debugger-v12-full-todo/prisma/dev.db.mac-before-rollback.$(date '+%Y%m%d-%H%M%S')"
```

4. 把服务器数据库和媒体同步回 Mac 本地项目。

```bash
rsync -az --delete root@42.193.221.253:/var/lib/video-api-debugger/uploads/ /Volumes/Data/Projects/video-api-debugger-v12-full-todo/public/uploads/
rsync -az --delete root@42.193.221.253:/var/lib/video-api-debugger/videos/ /Volumes/Data/Projects/video-api-debugger-v12-full-todo/public/videos/
rsync -az --delete root@42.193.221.253:/var/lib/video-api-debugger/storage/ /Volumes/Data/Projects/video-api-debugger-v12-full-todo/storage/
scp root@42.193.221.253:/var/lib/video-api-debugger/dev.db /tmp/sd2-server-dev.db
sqlite3 /tmp/sd2-server-dev.db 'pragma integrity_check;'
cp /tmp/sd2-server-dev.db /Volumes/Data/Projects/video-api-debugger-v12-full-todo/prisma/dev.db
```

5. 解除 Mac standby lock，并启用 Mac 三个 LaunchAgent。

```bash
rm -f /Users/gouki-youdoo/.youdoo/runtime/sd2-mac-standby.lock
uid="$(id -u)"
launchctl enable "gui/${uid}/com.youdoo.site.sd2"
launchctl bootstrap "gui/${uid}" /Users/gouki-youdoo/Library/LaunchAgents/com.youdoo.site.sd2.plist || true
launchctl kickstart -k "gui/${uid}/com.youdoo.site.sd2"
launchctl enable "gui/${uid}/com.youdoo.sd2.finalize-pending-videos"
launchctl bootstrap "gui/${uid}" /Users/gouki-youdoo/Library/LaunchAgents/com.youdoo.sd2.finalize-pending-videos.plist || true
launchctl enable "gui/${uid}/com.youdoo.sd2.video-delivery-worker"
launchctl bootstrap "gui/${uid}" /Users/gouki-youdoo/Library/LaunchAgents/com.youdoo.sd2.video-delivery-worker.plist || true
```

6. 确认 Mac 本地站可用后，再切 DNS route 回 Mac tunnel。

```bash
curl http://127.0.0.1:3000/api/config
cloudflared tunnel route dns --overwrite-dns codex-mobile-youdoodesign sd2.youdoodesign.com
```

7. 验证公网不再带服务器识别头，且登录/生成链路只写 Mac 这一套库。

```bash
curl -sS -D - -o /dev/null https://sd2.youdoodesign.com/api/health
```

## 回滚后恢复服务器

服务器修复后，重新做最终 Mac 数据库备份、媒体增量同步、服务器导入、Cloudflare route 切回 `seedance2-server`，再重新启用服务器 timer。
