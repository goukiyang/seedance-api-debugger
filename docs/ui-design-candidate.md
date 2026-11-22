# UI 界面设计 API02 v1.1 支线候选

**当前上线前补验见[原工单§13](../tasks/todo/2026-11-22-uiux-art-integration-assessment.md#uiux-art-release-acceptance)。** AUDIT01 五项已修。Linux x64 构建、同机隔离的 x64 私有工作台和原生 PDF、真实供应商原号恢复均通过。实体机和正式无感相容准入待完成。故障提示实页、标题屏视觉和小屏浏览器触摸证据见[原工单§12](../tasks/todo/2026-11-22-uiux-art-integration-assessment.md#uiux-art-branch-validation)。恢复 Mac 候选时使用 `delivery/AUDIT01-fixed` 的最终包及回执，见[原工单§11](../tasks/todo/2026-11-22-uiux-art-integration-assessment.md#uiux-art-audit01-fixed)。

本支线在现有 SD2 内部账号、模型目录、项目、素材权限、报价、原请求和 Asset 链上接入完整 ART 工作台。用户本轮已授权自测：真实分析、单屏返图、刷新显示、PNG/ZIP及测试账本结算跑通；源码已推支线，未合主线或部署。临时桥接的异步回调需修复接续，不当作正式自动恢复验收；完整结果和剩余边界见原工单§9。

## 本机候选

工作树：`/Volumes/Data/HomeRelocated/gouki-youdoo/.codex/worktrees/uiux-art-api/video-api-debugger`。

```sh
cd /Volumes/Data/HomeRelocated/gouki-youdoo/.codex/worktrees/uiux-art-api/video-api-debugger
bash .private/ui-design/start-candidate.sh
```

入口：`http://127.0.0.1:3316/tools/ui-design`。首次打开沿本站 `/login`。当前进程已用独立会话脱离工具启动（父进程 PPID 1，PID在忽略目录candidate.pid），健康接口 HTTP 200、私有 runtime 匿名读取 HTTP 401；这不是功能验收。

候选使用独立系统临时SQLite及工程账号，登录说明只在忽略的 `.private/ui-design/candidate-login.txt`。自测使用200个合成点，4任务结算20、余180、冻结0；其中3个为协议图、1个为真实上游返图。临时桥接调用服务器现有受保护API，真实密钥留在服务器，未复制业务账号或改生产账本。自测结束已停用本地合成供应商配置、停止临时桥接，无常驻worker；历史结果与导出保留，再生成需要正常配置可用模型。

`node_modules` 仅软链到本任务 `/private/tmp/sd2-ui-design-deps.lcLYu3/node_modules`；安装和 Prisma generate 均在这份独立依赖。临时目录被系统清理后，按原 package/lock 在本工作树重新 `npm ci --no-audit --no-fund`、`npx prisma generate`，不要借共享工作树执行 generate。恢复一个新本地空库时沿现有 `prisma db push` 与 `npm run seed:admin`，为 `ADMIN_PASSWORD` 自行设置私有环境值，不覆盖已有业务数据库。

## 私有交付与重建

公开 Git 只含本站原创 adapter、importer 和工程检查。原 ART、修改后的原文件、规范、结构、图片和 PDF 依赖全部在忽略目录，不能加入公开提交。

最终有效运行包：`.private/ui-design/ec22430289417474f6a64710bb58f8a261f901493af89ffc6053c3209444561a/`，共 1519 个受清单记录的文件，另有 `manifest.json`。内容摘要：

```text
4e61d76fd6d8426b887bd034a3ee2df098c395aedb85daf442c237e89cd113c7
```

此摘要按 importer 对排序后的「相对路径→SHA256」清单做 SHA256；不是目录压缩文件摘要。保留 7 套库、191 原画板、181 可选画板、565 张图。

最终私有 overlay：`.private/ui-design/overlays/API02-v1/`，10 文件：`index.html`、`studio.js`、`sd2-adapter.js`、`sd2.css`、`generation-provider.js`、`lovart-workflow.js`、`design-standards.js`、`structure-images.js`、`requirements-source.cjs`、`visual-reference-source.cjs`。排序文件清单摘要：

```text
99d639a10eeb1df0628a6d346f3e53ef24de91e9b5fc98ced97f101fd00e57ab
```

最终运行包、10文件适配、重建脚本和无账号原证已独立保存在 `/Volumes/Data/Downloads/uiux-art-20261122/delivery`；运行布局为 `runtime/`、`overlays/API02-v1/`、`delivery-inputs.json` 和 `rebuild-private.sh`。压缩备份 `ui-design-api02-v1.1-private-darwin-arm64-4e61d76fd6d8.tar.gz` 为365199281B，SHA256 `2328994bfa80192460ea974702367fbc3fe07d144e4a14b8210e821c538b3717`，1534文件流式逐项校验通过。临时env／登录说明／数据库／日志不在包内；db7旧备份留存，0af中间版不归档。

保留原 `UIUX-ART-2026-11-22-complete.zip`，其 SHA256 为 `ec22430289417474f6a64710bb58f8a261f901493af89ffc6053c3209444561a`。稳定归档已完成，可执行：

```sh
bash /Volumes/Data/Downloads/uiux-art-20261122/delivery/rebuild-private.sh \
  /path/to/authorized/checkout
```

重建使用原 ZIP、同版 overlay，以及稳定 runtime 中的最小 `node_modules` 作为依赖输入；不依赖原工作树或 Codex 缓存。基线已从原ZIP独立完整重建。本次两项覆盖变更沿同一importer组装，10个覆盖文件与最终清单一致，归档1534文件逐项SHA核对；没有再次全量新建独立副本。PDF 为 pdfjs-dist 5.6.205（Apache-2.0）、canvas 0.1.100 与 canvas-darwin-arm64 0.1.100（MIT），含必要字体、cmaps、元数据和许可；没有打包 Node/Codex/浏览器。

本机 PDF 真正文字提取的首失败（缺 canvas、DOMMatrix 未定义）保留；补闭包后合法单页 PDF 提取 `UI design parser smoke` exit 0。最终 parser/依赖 hash 相同，复用该证。Linux importer 按真实 libc 选择 `canvas-linux-x64-gnu` 或 musl，并核 0.1.100 optionalDependencies；本轮 Linux 仅构建公开宿主源码，没有组装私有包，不声称 Linux PDF 可用。

## 运行和数据约定

- 工作区、个人库、分析、批次和逐屏映射按本人 `PlatformSetting` 命名空间分行保存，使用 revision/原 value CAS；无新表或新业务数据库。历史列表分页与详情分开，不以未加载记录当删除。删除为归档，独立受理映射、任务、费用和 Asset 保留。
- 原图及 runtime 均登录核权、private/no-store。登记后的图片只保存 Asset 引用；上传结构重开仍可选屏并进入原分析，base64 不永久写数据库。素材文件沿现有 `/uploads`、`_next/image` → `upload-access` 的会话/owner/显式共享核权，不另造公开读取口。
- 共享素材仅 use 授权不能通过本工具复制/下载原件；分析和报价/受理时重核来源。原 LLM 图片读取的 owner-only 默认没有放宽。
- 分析逐三屏调用原合同、校验和有界补漏，保留每轮原输入与答复；后批保持同一共享方向。中断留实际部分成果，可按原分析 ID 继续。生图字符上限 20000，原 ART 30000 合同不全局修改，不截断输入冒通过。
- 逐屏原号先存，真实报价汇总确认后 CAS 派发；未知只查原号，明确拒绝或安全结束沿原耐久回执。停止只封未领取项；已受理/未知不重发、不重扣。精修只处理选中屏，旧满意结果保留。
- HTML/ZIP 导出只读本人当次有权取得的实际成品，内嵌字节可离线使用，缺项报真实数量，不带 Cookie、令牌、签名 URL 或服务路径。旧外部历史保原来源和原号，只读；显式导入写新工作区并保已有个人库/历史。
- 网址没有真实截图引擎时明确提示粘贴截图；离线库和本人交互图完整可用。在线 Figma、作者 Lovart 连接和个人 OpenAI Key 不在本站生成流程，不启动作者机器。

## 工程证据和手验

`tsc`、`lint`、`test:ui-account-boundaries` exit 0；原结构/规范/预算/选屏/结构图 50 PASS、2 SKIP；原分析结构图、上一版、错 schema 和定向补漏 6 PASS。新增 `node --import tsx scripts/check-ui-design.mjs` 使用独立 SQLite，调用实际 store/serializer/SI/分析转换/素材权限/共享 helper，验证 CAS、分页、导入保留、撤权、单次领取、未知/封口、20000/20001 和普通默认行为。该工程脚本不请求真实供应商或扣费；用户另行授权的实际调用见原工单§9。

Mac 原标准构建被必须真实 Linux 的 pricing 门拒绝，首失败保留；未跳 prebuild、未伪造平台。Linux 使用登记工程机 `/data/video-api-debugger/build-work/ui-design-api02-20261122-7bd4a4aa3`，独立依赖、gouki 1004 和原 `bootstrap-root.sh` 工程 fixture，再运行原 `npm run build`。首轮发现原多视图夹具另要求专用private fixture及canonical源码路径；随后直接flock probe定位root解包源码0664触发原sourceBytes拒绝，仅本候选源码去group/other写权，原证保留。最终宿主修正提交为`99db202c3177dbb1f2fa9b78acf784b1673af5dd`，对应未激活隔离候选`/data/video-api-debugger/managed-releases/99db202c3177dbb1f2fa9b78acf784b1673af5dd`；该路径只是原工程夹具要求，不操作任何current链接/服务/切流。最终构建结果以原工单 §8 实际回执为准，7bd旧源码产物不能冒最终通过。

用户手验仍为原工单 A01–A07：7 库选择；文档/参考/结构图分析；真实单屏费用与返图；多屏部分完成/未知恢复；单屏精修；重开/CAS/账号/分页/归档/导出；手机和键盘。本轮按用户明确授权执行自测，最终视觉与正式环境启用仍待用户验收；各项实际证据和未验边界见原工单§9。

实际Next编译曾将动态createRequire转换为undefined，现由运行时getBuiltinModule加载原生module（真实Node20.20.2支持）。独立工程账号调用编译后私有TXT解析HTTP200、正文匹配；Origin门沿本站既有Origin.host/Host匹配并拒cross-site，避免Next内部URL归一化误拒本站请求。该次loader修正未改私有包；原PDF解析器/依赖实证沿相同hash复用。


Linux历史基线99db的17＋17原门及pricing通过；原门复核后4GB Next接续exit0，BUILD_ID `GIUvF14tnqi2tbps1Z_a0`，105页／13个UI入口。外层npm0但worker内存溢出且无BUILD_ID的首失败保留，不当通过。生产bundle原生loader已核。费用确认仅取当前prepared项，冻结确认payload及历史原号不变，实际adapter四场景通过。

网络恢复后已普通推送并核远端；当前应用源为25dfb3c43，最新文档与Git bundle回执沿[原工单](../tasks/todo/2026-11-22-uiux-art-integration-assessment.md#8-api02-实施记录)。稳定原证见同目录 `linux-build-evidence.json`、`compiled-runtime-evidence.json`、`confirm-copy-evidence.json`；最终视觉与正式环境仍待用户手验，本轮自测见原工单§9。
