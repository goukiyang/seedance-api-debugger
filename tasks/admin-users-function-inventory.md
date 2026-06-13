# 用户管理页功能盘点

更新时间：2026-06-09

用途：重构 `/admin/users` 前，先固定现有功能、接口、约束和风险边界。重构默认不得删功能，只能做入口归位、显隐分层、交互优化和代码拆分。

## 代码入口

- 页面入口：`src/app/admin/users/page.tsx` 的 `AdminUsersPage`
  - 未登录跳 `/login`。
  - 非管理员跳 `/generate`。
  - 管理员进入 `AdminUsersClient`。
- 前端主组件：`src/app/admin/users/AdminUsersClient.tsx` 的 `AdminUsersClient`
- 用户数据模型：`prisma/schema.prisma` 的 `User`、`CreditAccount`、`CreditBucket`、`CreditLedger`、`OperationLog`
- 用户类型配置：`src/lib/users/profiles.ts`
- 点数策略：`src/lib/credits/policy.ts`
- 登录约束：`src/lib/auth/session.ts`、`src/lib/auth/feishu.ts`

## 页面整体结构

### 顶部与状态反馈

- 顶部 `PageBanner` 显示“用户与点数管理”、当前管理员姓名和邮箱。
- 页面统一显示成功消息或错误消息。
- 初始化会并行加载：
  - `/api/admin/users`
  - `/api/admin/credits/ledger`
  - `/api/admin/credits/policy`

### 用户列表

用户列表是页面左侧主区域，支持筛选、选择、分页和单行操作。

显示字段：

- 用户姓名。
- 账号、邮箱。
- 账号来源：内部 / 外部。
- 系统身份：管理员 / 普通用户。
- 飞书绑定标记。
- 用户类型。
- 能力档案。
- 点数：
  - 可用点数 = 长期可用 + 每日剩余额度。
  - 长期余额。
  - 冻结点数，包含长期冻结和每日冻结。
  - 今日额度剩余 / 今日额度总量。
- 账号状态：启用、禁用、待开通、已过期。
- 最近登录时间。

筛选能力：

- 关键词搜索：姓名 / 账号 / 邮箱。
- 账号来源：全部 / 内部 / 外部。
- 用户类型。
- 能力档案。
- 状态：全部 / 启用 / 禁用 / 待开通 / 已过期。
- 筛选变化后用户分页回到第一页。

选择能力：

- 单行勾选。
- 全选当前筛选结果。
- 取消当前筛选结果。
- 清空选择。
- 每页 20 人分页。

单行操作：

- `编辑`：打开右侧账户属性面板。
- `只选`：只选择当前用户，并同步到单人点数操作的用户选择。
- `启用/禁用`：按当前状态切换。
- `删除`：软删除用户；当前登录账号不能删除。

## 右侧管理功能

### 点数策略

来源：`AdminUsersClient.saveCreditPolicy` -> `PUT /api/admin/credits/policy`

功能：

- 新用户初始点数：
  - 开关。
  - 内部新用户默认点数。
  - 外部新用户默认点数。
  - 是否应用到注册用户。
  - 是否应用到飞书首次登录自动创建。
  - 是否应用到管理员创建用户默认值。
- 每日固定额度：
  - 开关。
  - 内部默认额度。
  - 外部默认额度。
  - 有效小时数，范围 1-168。
  - 每个用户类型的覆盖额度。
- 说明文案明确：任务消费优先用每日额度，再用长期余额。

后端约束：

- `saveCreditPolicy` 写入 `PlatformSetting`，key 为 `credit_policy_v1`。
- 策略会归一化，负数和非法数字归零。
- 每日额度时区固定为 `Asia/Shanghai`。
- 管理员不获得初始点数和每日额度。

### 账户属性编辑

来源：`AdminUsersClient.saveEditedUser` -> `PATCH /api/admin/users/[id]`

可编辑字段：

- 姓名。
- 账号。
- 邮箱。
- 账号来源：内部 / 外部。
- 系统身份：普通用户 / 管理员。
- 用户类型。
- 能力档案。
- 状态：启用、禁用、待开通、已过期。
- 过期日期。
- 修改原因，必填。

前端行为：

- 外部账号不能选管理员。
- 选择管理员时，如果当前是外部账号，前端自动切回内部账号。
- 外部账号强制用户类型为 `other`，能力档案为 `external_limited`。
- 用户类型变化时，能力档案可走自动建议。
- 保存前会弹窗确认，角色、状态、账号来源变化会列入敏感变更摘要。
- 账户属性变化不会自动改点数。

后端约束：

- `reason` 必填。
- 可编辑状态只允许 `active`、`disabled`、`pending`、`expired`。
- 用户名和邮箱保持唯一。
- 管理员必须是内部账号。
- 绑定飞书的账号设为管理员时，后端会把账号来源兜底为内部账号。
- 启用账号的过期时间必须晚于当前时间。
- 不允许让当前登录管理员失去后台访问权限。
- 不允许移除最后一个可用管理员。
- 写入 `OperationLog`，action 为 `update_user_role` 或 `update_user_account_attributes`。

### 批量修改用户类型

来源：`AdminUsersClient.bulkUpdateProfiles` -> `POST /api/admin/users/bulk-profile`

功能：

- 对已选用户批量设置用户类型。
- 能力档案可自动建议，也可手动指定。
- 修改原因必填。
- 前端二次确认。

后端约束：

- 单次最多 200 个用户。
- 必须 `confirm=true`。
- 不处理已删除用户。
- 外部账号强制 `user_profile=other`、`feature_profile_id=external_limited`。
- 每个用户写 `bulk_update_user_profile` 日志。
- 批次写 `bulk_update_user_profile_batch` 日志。

### 合并重复账号

来源：`AdminUsersClient.mergeUsers` -> `POST /api/admin/users/merge`

前端功能：

- 左侧勾选源账号。
- 右侧选择最终保留账号。
- 保留账号只允许选择启用状态用户。
- 源账号不能包含管理员。
- 显示源账号数量。
- 预览将转入的长期余额和冻结点数。
- 合并原因必填。
- 提交前二次确认，说明源账号会软删除、业务数据会迁移、点数会用合并流水转入。

后端约束：

- 必须 `confirm=true`。
- 单次最多合并 20 个源账号。
- 保留账号必须存在、未删除、启用。
- 源账号必须存在、未删除。
- 管理员不能作为源账号，只能作为保留账号。

后端迁移范围：

- 点数账户：
  - 源账号 `balance`、`frozen_credits`、`monthly_used`、`total_used` 汇总到保留账号。
  - 保留账号写 `account_merge_in` 流水。
  - 源账号写 `account_merge_out` 流水。
  - 源账号点数账户清零。
- 视频任务：
  - `VideoTask.user_id` 迁移到保留账号。
  - `VideoTask.owner_user_id` 迁移到保留账号。
  - 源账号和保留账号的 `idempotency_key` 冲突时，先清空源任务冲突 key。
- 项目和协作：
  - `Project.owner_user_id` 迁移。
  - `ProjectMember` 按状态、角色、加入时间选最优成员关系。
  - 已有保留账号成员关系时，源成员关系置为 `removed`。
- 创作资产：
  - `CanvasDocument.owner_user_id`
  - `ReferenceAlbum.owner_user_id`
  - `ReferenceImage.owner_user_id`
  - `Workspace.owner_id`
  - `Asset.owner_id`
  - `AssetCollection.owner_id`
- 图集分享：
  - `AlbumShare` 按状态和创建时间选最优分享关系。
  - 权限 JSON 合并；布尔 `true` 权限优先保留。
  - 冗余分享置为 `revoked`。
- Provider 和成本：
  - `ProviderApiRequest.user_id`
  - `CostLedger.user_id`
  - `CostAllocation.user_id`
  - allocation 类型为 user 时，`allocation_id` 也迁移。
- 反馈：
  - `Feedback.user_id`
- 飞书身份：
  - 从保留账号和源账号中挑一个主飞书身份。
  - 评分优先级：最近同步时间、是否有 `feishu_user_id`、是否有 `feishu_open_id`。
  - 主飞书身份写入保留账号。
  - 源账号飞书字段、手机号、头像等清空。
- 源账号最终 `status=deleted`。
- 写 `merge_users` 操作日志，包含源/目标账号、飞书身份迁移、点数迁移、各类迁移计数。

重构风险：

- 这是用户管理页最高风险功能。UI 重构不能把“源账号选择”和“保留账号选择”做得模糊。
- 合并前必须明确哪个账号最终可登录，尤其是飞书身份会转移到谁。
- 合并后如果保留账号不是 `active` 或过期，飞书登录会返回不可登录类错误。

### 一键发放点数

来源：`AdminUsersClient.bulkGrantCredits` -> `POST /api/admin/credits/bulk-grant`

功能：

- 对已选用户每人发放固定点数。
- 发放原因必填。
- 前端二次确认，展示前几个用户和总发放点数。
- 禁用用户也可入账，但启用前不能登录使用。

后端约束：

- 单次最多 200 个用户。
- `amount` 必须为正数。
- 必须 `confirm=true`。
- 不存在点数账户时自动创建。
- 每个用户写 `admin_grant` 点数流水。
- 每个用户写 `credit_bulk_grant` 操作日志。
- 批次写 `credit_bulk_grant_batch` 操作日志。

### 创建用户

来源：`AdminUsersClient.createUser` -> `POST /api/admin/users`

可输入字段：

- 姓名。
- 账号。
- 邮箱。
- 初始密码。
- 系统身份。
- 账号来源。
- 用户类型。
- 能力档案。
- 初始点数。
- 原因。

前端行为：

- 管理员必须是内部账号。
- 外部账号会自动切成普通用户，用户类型为 `other`，能力档案走外部受限。
- 初始点数可手动填写，也可一键套用当前策略建议。
- 创建成功后清空表单并刷新列表。

后端行为：

- `name`、`username`、`email`、`password` 必填。
- 用户名和邮箱唯一。
- 管理员必须是内部账号。
- 外部账号强制 `user_profile=other`、`feature_profile_id=external_limited`。
- 创建用户，创建 `CreditAccount`。
- 通过 `grantInitialCredits` 写初始点数。
- 自动创建个人默认项目和项目成员。
- 写 `create_user` 和 `project_create_default` 操作日志。

### 单人点数操作

来源：`AdminUsersClient.adjustCredits` -> `POST /api/admin/credits/adjust`

功能：

- 选择用户。
- 操作类型：
  - 发放。
  - 扣减。
  - 修正为某个长期余额。
- 输入点数。
- 原因必填。
- 前端二次确认。

后端约束：

- 只影响长期余额，不直接改每日额度。
- `grant` 和 `deduct` 的 amount 必须大于 0。
- `adjust` 的 amount 可为 0。
- `deduct` 只允许扣长期可用余额，即 `balance - frozen_credits`。
- `adjust` 后的长期余额不能低于已冻结点数。
- 写 `CreditLedger`：
  - `admin_grant`
  - `admin_deduct`
  - `system_adjust`
- 写 `credit_adjust` 操作日志。

### 点数流水

来源：`AdminUsersClient.loadLedger` -> `GET /api/admin/credits/ledger`

功能：

- 表格显示点数流水。
- 每页 50 条。
- 显示时间、用户、类型、变动、余额变化、冻结变化、原因。
- 支持分页。

接口能力：

- 支持 `page`、`page_size`。
- 支持按 `user_id` 查询。
- 支持按 `type` 查询。
- 返回 `records`、`total`、`page`、`page_size`。

## 用户启用、禁用、删除

### 禁用用户

来源：`AdminUsersClient.toggleUser` -> `POST /api/admin/users/[id]/disable`

- 当前登录账号不能禁用。
- 不存在或已删除用户不可禁用。
- 不能禁用最后一个可用管理员。
- 写 `disable_user` 操作日志。

### 启用用户

来源：`AdminUsersClient.toggleUser` -> `POST /api/admin/users/[id]/enable`

- 不存在用户不可启用。
- 已删除用户不可启用。
- 已过期用户必须先调整过期时间。
- 写 `enable_user` 操作日志。

### 删除用户

来源：`AdminUsersClient.deleteUser` -> `DELETE /api/admin/users/[id]`

- 前端禁用当前登录账号删除按钮。
- 后端再次校验不能删除当前登录管理员账号。
- 不存在或已删除用户返回用户不存在。
- 不能删除最后一个可用管理员。
- 实际是软删除：`status=deleted`。
- 不删除历史任务和点数流水。
- 写 `delete_user` 操作日志。

## 登录与权限约束

- 只有 `status=active` 且未过期的用户能形成有效 session。
- 密码登录：
  - `disabled` 返回账号已被禁用。
  - `pending` 返回账号待开通。
  - `expired` 或过期时间已到返回账号已过期。
  - 其他非 active 状态返回账号当前不可用。
- 飞书登录：
  - 会按飞书 userId/openId、邮箱、手机号匹配账号。
  - 多账号冲突会返回身份冲突，需要管理员处理。
  - `disabled`、`expired`、非 active 状态都会拒绝登录。
  - 非 active 状态错误文案为“账号暂不可登录”。
- 飞书自动创建用户：
  - 默认普通用户。
  - 默认内部账号。
  - 用户类型 `other`。
  - 能力档案使用内部默认档案。
  - 自动创建点数账户、初始点数、默认项目、项目成员。

## 重构必须保留的行为

- 管理员后台入口权限。
- 用户列表筛选、选择、分页。
- 单行编辑、只选、启用/禁用、删除。
- 点数策略读取和保存。
- 账户属性编辑和敏感变更确认。
- 用户类型和能力档案自动建议。
- 外部账号强制受限档案。
- 管理员必须内部账号。
- 当前管理员和最后管理员保护。
- 批量修改用户类型。
- 合并重复账号完整迁移和审计日志。
- 批量发放点数。
- 创建用户时默认项目和初始点数。
- 单人点数发放、扣减、修正。
- 点数流水列表与分页。
- 所有危险动作的二次确认和后端 `confirm` 校验。
- 所有关键写操作的 `OperationLog`。

## 重构建议

### 信息架构

- 左侧保留“用户列表 + 筛选 + 选择”作为主工作区。
- 右侧拆成明确标签或分区：
  - 账户属性。
  - 点数操作。
  - 批量操作。
  - 合并账号。
  - 点数策略。
  - 流水。
- 高风险功能不要和普通编辑混在同一折叠面板里，尤其是“合并账号”和“删除用户”。

### 交互改造

- 批量操作区始终显示已选用户摘要，避免选错对象。
- 合并账号需要明确展示：
  - 保留账号。
  - 源账号列表。
  - 飞书身份最终归属。
  - 点数转移预览。
  - 迁移数据范围。
- 账户状态建议用状态徽标，不只用文本。
- 点数建议拆成长期余额、每日额度、冻结、已用四组指标。
- 所有二次确认建议升级为可读的确认弹窗，不再依赖浏览器原生 `window.confirm`。

### 技术拆分

- `AdminUsersClient.tsx` 当前同时承载数据加载、表格、策略、编辑、批量、合并、点数、流水，重构应拆组件。
- 推荐拆分：
  - `AdminUsersPageShell`
  - `UserFilters`
  - `UserTable`
  - `AccountEditorPanel`
  - `CreditPolicyPanel`
  - `BulkProfilePanel`
  - `MergeUsersPanel`
  - `BulkGrantPanel`
  - `CreateUserPanel`
  - `CreditAdjustPanel`
  - `CreditLedgerTable`
- 前端 API 调用建议集中到 `src/app/admin/users/admin-users-api.ts` 或同目录 helper，避免每个 panel 自己拼 fetch。
- `window.confirm` 建议统一替换为项目内 modal，保留“确认前摘要”和后端 `confirm=true`。

## 验收清单

- 管理员能进入 `/admin/users`，普通用户不能进入。
- 筛选、分页、全选筛选结果、清空选择都保持可用。
- 编辑用户属性后列表同步刷新，且后台保留最后管理员保护。
- 禁用、启用、删除的前后端保护仍生效。
- 创建用户后有点数账户、默认项目和项目成员。
- 点数策略保存后注册、飞书自动创建、管理员创建的初始点数仍按策略生效。
- 单人点数操作只影响长期余额，扣减不能超过可用长期余额。
- 批量发放最多 200 人，写入流水和操作日志。
- 批量修改最多 200 人，外部账号仍强制受限档案。
- 合并账号最多 20 个源账号，管理员不能作为源账号，飞书身份归属清晰。
- 合并后源账号软删除，源账号不能登录，保留账号能按 active/过期规则登录。
- 点数流水分页和筛选接口仍可用。
