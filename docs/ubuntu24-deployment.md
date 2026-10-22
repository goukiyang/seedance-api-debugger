# Ubuntu 24 部署文档

## sd2 现网发布入口（2026-10-21）

`sd2.youdooart.com` 已有生产数据与持久启动屏障，**只走本节保护流程**。下方从零安装示例不是现网更新、迁移、回退或删目录命令，不得直接执行。所有候选、日志与发布材料沿真实挂载的 `/data`；只回程序，不回业务数据库、价格、媒体、账本、回执或历史证书。

固定准备入口为 `ops/sd2-release-prepare.mjs`，控制来源由同目录 `sd2-release-profile.json` 锁定。它先逐字核实正式根私有 `docs/materials/2026-10-19-upload-unknown-recovery/release-r16/` 的36个成功控制模块及原成功证据；ADMIN-USAGE另封新控制包，经profile的promotion精确锁定新增及允许变动文件，其余原模块逐字保留，不另建发布引擎、不上传私有材料到Git。r16及其原run只读，禁止复制旧run/PID/价格修订冒新鲜现场。根因及原附件见正式根费率工单§24.5。

DESIGN03/04于2026-10-22T10:33:12.763Z正常保护发布v0.102.2，实际四writer源4fb7f841、BUILD`qwBCyuUR2RcM8M-vL8KoV`，相容guard4b1adbba/BUILD`oNhpz_gPaennYmwMTqTBf`。当前profile晋升私有`release-projects-design-r03`49模块，历史r08/r01/r02及失败run均不改。新增精确分流仅认原e6044ae3未发布整对4fb/4b，pin原manifest与两+i成功证SHA/source/version/BUILD；完整核source/lock/deps/env/Node/artifact/check metadata和字节，原封存在原30分钟内，后续原时间不改、另发30分钟fresh，不接受任意过期pair或伪造拒绝进入v2。

来源provenance核对与正常维护前runtime/保护/schema鲜核必须分层：schema后续reader也需要读原来源，不得让底层来源核对反调schema/保护入口导致互递归。整批正反fixture及原16组控制完成后才晋升；实际原run无switch/stop/503/fence/pair、候选/别名未运行及原身份/配置/权限/备份均须真实核对。原exit0/完整cgroup、费用/租约/未知保护、backup、启动屏障、fence与guard不放宽；现场不稳定则保拒绝原证、原站与累计次数，待原因/状态有新证再鲜准入。只回程序不回数据，后续发布/回退需新窗口/批准，不能借本次已过期批准。原单§9.7及固定todo保完整私有证据；56唯一公网资源及服务健康不是A01–A10用户手验。

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

维护前瞬时连接等只读准入拒绝，不能重开号来重置或手补成功回执。新控制把完整原生用例的原退出状态/日志SHA/manifest与控制源码锁存为同run `native-control-preflight/batch.json`；只有完整且未变的成功批可复用，缺失/部分/失败或任何漂移继续拒绝。每次后续仅在新的受限只读子目录重新捕获全部真实配置、进程、连接为0、同步请求为0、原证书/上传与HD准入，失败另留原时点记录，成功才首次写最终receipt。原用例时间/日志和已完成receipt不改，不把只读工程续查当维护批准；真正切换仍要另取五分钟fresh准入并自然排尽旧writer。

整对成功构建重新取鲜准入时，包装控制若已经采用`sourceBase`且字节完全未变，属于原已审输入，不必再次套用旧`BASELINE_SOURCE`到`sourceBase`的升级差异。r05仅补完全相等的幂等检查；不相等仍只允许原来精确的一处祖先判断替换，运行来源、完整变更集合、配置及其他控制漂移继续拒绝。原构建与封存时间不改，新run沿同一失败链记录，不把客户端SSH清理退出255冒为构建失败。

r06正常续接仅用于维护前零副作用拒绝：新run的`contract.normalContinuation`锁定前次manifest/before/批准/原错误/lineage及原迁移回执、备份证明SHA，重新鲜核原六角色、配置/原价格和全部数据保护；任何503、fence、stop或writer等副作用不接受普通续接。`release.mjs adopt`只读验证同一DB文件身份、原空表/索引/SQL、原备份完整性与SHA，独占写`operation: ADOPT`的新证，原run/时间/回执及备份不改，不执行DDL。角色启动沿统一candidateEvidenceFile读取fresh候选与原迁移的有效证据。HD完整判断先落盘后判门，后续正常run另做完整鲜检查和新批准，原错误不倒填；已发生副作用继续原恢复，不把该路线当故障通道。

r08承接r07的首次运行别名准备，并完整核对首次复用生命周期：原完整构建run须没有任何switch-before/发布/排空/启动记录，当前候选无活跃进程且不在运行角色中，全部原封存与输入已验证，才可首次新建`.next-prod`到原固定编译目录并另留原构建时间不变的记录。已有正确别名也必须核上述来源/未运行条件；fresh回执固定其dev/inode/owner/metadata，后续verify、切换和固定guard恢复均核同一对象，准备后换为同目标也拒绝。错误、损坏、普通文件或先前已发布后缺失均拒绝，不覆盖修复。维护批准的数字毫秒/严格UTC时间由同一解析器供正常入口与固定guard准备使用，五分钟/来源/窗口/控制SHA门不变。临时停机策略、部分nginx安装或已撤回安装的记录也算已发生副作用，只走原恢复，不能普通重试。

完整原生控制批须含`candidate-lifecycle-engineering.mjs`：隔离合成现场串联实际原成功输入核对、跨run复用、首次别名、维护批准、guard准备、自然退出、整对许可发布、启动/角色合同、首次上线/收口、普通相容回退与故障恢复；前序真实生成的回执由后序直接读取，不能在测试里预造缺失后置回执。系统服务/网络/DB观察由显式隔离适配器提供，不是生产回退演练或功能验收。全部关联修正与完整批次统一Verify、同lead Review后才可生产鲜准入，不靠逐次现场试切发现下一处旧假设。业务/编译字节、旧运行目录和原immutable证据不改。

统一离线工程检查：`node ops/sd2-release-prepare.test.mjs /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-19-upload-unknown-recovery`。仅检查工具、原证与生成接线，不运行任何服务器动作或功能验收；离线检查不冒上线成功。

首次真实发布已完成：2026-10-21T14:58:50.364Z，联合ADMIN-USAGE＋PROJECTS-USAGE＋C01由r08正常run `a6deeb1c-1a4a-40da-bfa2-2c611b494b27`切换并收口，未借故障恢复。实际Web/image/HD/role同源`9c39aeb7de06c3c9e676477febf214c089cb9727`、v0.101.0、BUILD`wbv8uoX8-xBv0cpbUkY1I`；role保持TasksMax128，原四类writer自然退出、整组排空，两只读辅助服务未重启。相容guard为`0adc2bcfb164d8d189cfaed17b4eb2ab176e6840`、v0.101.0+admin-usage-guard.1、BUILD`K00Q-koXcFAuheX6emKtc`，保本批新事务、scope/token、CAS/active与role writer合同；仅回程序、不回数据/归属/配置/媒体/账本/回执/屏障。原整对完整构建与封存时间不改，本run仅ADOPT原13:19成功迁移，无重复DDL/回填。13组Linux控制、16项隔离完整生命周期、22项固定入口检查和同lead Review完成后才正常fresh准入；原价格全字段/原业务行/DB身份、18页61编译资源及8匿名边界均有真实发布证据。正式根ADMIN-USAGE工单§13.18及资料索引保存私有原件；旧run/失败/备份/时间保留，不公开原图、提示词或私有控制资料。已部署，待用户手动验收：两单U01–U13、实际旧客户端更新弹窗和C01操作未自动执行；合成回退用例不是生产回退演练。当前应用运行源不随文档HEAD变化，文档收口不另构建、升版本或重启。

### 视频批次增量表（LibTV）

首次启用视频2/4批次使用profile锁定的`release-libtv-template-r05`，保留原r16/r06、LibTV r01–r04及历史run。`contract.canvasVideoBatchSchema`分别绑定原Prisma、新Prisma、增量SQL、迁移脚本和schema合同SHA；只允许精确插入两个模型及两个表/九个索引，原声明与UsageAttribution原证保持。不允许复用旧业务pair，main/guard各完整构建，guard编译时关闭新批次创建，保读、停止、原号回执与旧writer能力门。

新迁移必须在原Web/image/HD/role自然排尽、固定整对许可已发布后、任何新writer启动前执行。`ops/sd2-canvas-video-batches-migrate.py`核真实/data、空间、同点一致备份与完整性、原schema/业务行，再仅加表索引；新启动及固定guard恢复均核同run回执和备份证明，不回业务数据。缺失/半成品不能造回执补过门。本入口只实现首次增量及同run恢复；后续发布须显式继承已成功批次迁移的绑定证据，不能仍把新表当不存在，也不能移除schema保护来通过。

首次真实完成：2026-10-21T21:46:20Z，run `05d24c02-b3f3-4041-88e3-464b98ecac22`加2表9索引，业务行写入0、历史回填false；同run `/data/video-api-debugger/release-staging/05d24c02-b3f3-4041-88e3-464b98ecac22/canvas-video-batches-migration/consistent-backup.sqlite`与原回执已核可读、完整性及SHA。21:46:52Z正常发布main `86dc32f2e1dcf3b038e23e7702afcc82bb526a5c`、v0.102.0、BUILD `144JweHixHdObEov_wdAS`，guard `c25663b582193dbc9f06ed56238a19b737109d73`、v0.102.0+libtv-guard.1、BUILD `LmZt_MmqI-TLpm8cz7t35`；两份完整构建原时间保留，16组Linux控制/同lead Review/8页53资源通过，21:47Z窗口正常收口。原Usage只采用原证，四服务同源、角色TasksMax128、两辅助服务未重启。正式根LibTV原单§14.1和资料索引记录完整证据；A01–A22、旧客户端更新弹窗待用户手验，无真实回退演练、浏览器或收费生成。文档提交不改变运行源。

发布输入的`publicationRun`必须对应实际运行版本最近一次成功正常发布，原`migrationRun`仍对应最初加Usage表与备份；两者不能因为沿用历史资料而混填。16组原生控制包含新迁移生产者/消费者隔离检查，直接从已锁定main/guard源码包取真实SQL与迁移函数，在临时SQLite实际产生备份和回执，再由真实控制读取；检查原writer未停时拒绝、缺回执拒绝、同run不重写时间及坏回执/备份拒绝。它不是生产迁移或回退演练。整流程VM必须显式绑定新增schema helper，不能靠修改计数或假成功返回代接线；失败批/历史源码保持不变，另封新输入并重新取得正常鲜准入。

隔离VM装载模块统一沿现有TypeScript语法解析器识别真实import/export节点，不用行首正则剥离；模块可能包含嵌入Python的`import`文字，错误剥离会破坏真实探针。r03只修此隔离装载，不改迁移函数、生产控制或任何原始回执。

r04另登记现网e00已完成高清任务实际观察的三份缓存精确字节；源码、编译器及配置SHA与已核验e01相同，仅路径归一后字节相同，原只读证明见LibTV资料`hd-cache-equivalence-r03b.stdout`。保留旧白名单且逐次重核来源、终态、原进程组消失、原时间/权限与读取稳定性；不删除缓存、不修改原任务或放宽未知缓存。新增该原件的隔离正反例检查，原r03b十六组通过不冒充正式准入。

r05在候选隔离空库的既有`db push`阶段生成当前Prisma客户端，不再沿用现网node_modules中的旧模型。仍只对候选私有空库执行，不是生产迁移；用同一Prisma格式器格式化私有源码副本，再逐字核对生成schema，避免把格式化差异冒源码差异。原源码不改，正式DDL仍只在自然排空后由绑定迁移执行。r03的三个prebuild失败完整保留：两个前端隔离消费者的登录/数量/新批次只读接线未同步，另一个实际新表delegate缺失由候选生成时序造成；不删除断言或放宽业务门。

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
