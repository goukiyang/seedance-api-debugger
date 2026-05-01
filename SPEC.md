# 即梦/Seedance 视频生成 API 调试网页 MVP - 规范文档

## 1. 项目概述

- **项目名称**: video-api-debugger
- **项目类型**: 内部 API 调试工具 (MVP)
- **核心功能**: 通过网页调试即梦/Seedance 视频生成 API，完成视频生成最小闭环
- **目标用户**: 内部开发者和测试人员

## 2. 技术栈

- **框架**: Next.js 14+ (App Router)
- **语言**: TypeScript
- **数据库**: SQLite + Prisma ORM
- **样式**: Tailwind CSS (可选，使用基础 CSS)
- **API**: Next.js API Routes

## 3. 数据库设计

### video_tasks 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (cuid) | 本地任务 ID |
| provider | string | 提供商: jimeng |
| model | string | 模型名称 |
| mode | string | 生成模式: text_to_video / image_to_video |
| prompt | string | 提示词 |
| input_image_url | string? | 输入图片 URL (可选) |
| params_json | string? | 原始参数字段 JSON |
| local_status | string | 本地状态 |
| provider_task_id | string? | Provider 任务 ID |
| provider_status | string? | Provider 返回的原始状态 |
| result_video_url | string? | 生成视频 URL |
| raw_create_response | string? | 创建任务原始返回 JSON |
| raw_status_response | string? | 查询状态原始返回 JSON |
| error_message | string? | 错误信息 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |
| completed_at | datetime? | 完成时间 |

### 本地状态枚举

- `draft` - 草稿
- `submitted` - 已提交
- `running` - 运行中
- `succeeded` - 成功
- `failed` - 失败
- `cancelled` - 已取消

## 4. Provider 适配器

### 文件: src/lib/provider/jimeng.ts

#### 接口函数

```typescript
// 创建视频任务
createVideoTask(params: {
  prompt: string;
  image_url?: string;
  mode: 'text_to_video' | 'image_to_video';
  ratio: '16:9' | '9:16' | '1:1';
  duration: number;
  resolution: string;
}): Promise<{
  provider_task_id: string;
  raw_response: object;
}>

// 查询任务状态
getVideoTaskStatus(providerTaskId: string): Promise<{
  status: string;
  result_video_url?: string;
  error_message?: string;
  raw_response: object;
}>
```

## 5. API 接口设计

### GET /api/config

返回当前配置（不含完整 API Key）。

**响应**:
```json
{
  "provider": "jimeng",
  "base_url": "https://jimeng.jianying.com",
  "model": "jimeng-video-v2",
  "api_key_configured": true
}
```

### POST /api/video/create

创建视频生成任务。

**请求体**:
```json
{
  "prompt": "一只猫在草地上奔跑",
  "image_url": "https://example.com/image.jpg",
  "mode": "text_to_video",
  "ratio": "16:9",
  "duration": 5,
  "resolution": "720p"
}
```

**响应**:
```json
{
  "id": "clx123...",
  "provider_task_id": "123456789",
  "status": "submitted",
  "created_at": "2026-04-28T10:00:00Z"
}
```

### GET /api/video/status/:id

查询任务状态。

**响应**:
```json
{
  "id": "clx123...",
  "provider_task_id": "123456789",
  "local_status": "succeeded",
  "provider_status": "success",
  "result_video_url": "https://...",
  "error_message": null
}
```

### GET /api/video/list

返回任务列表。

**响应**:
```json
{
  "tasks": [
    {
      "id": "clx123...",
      "provider_task_id": "123456789",
      "prompt": "一只猫在草地上奔跑",
      "local_status": "succeeded",
      "created_at": "2026-04-28T10:00:00Z",
      "completed_at": "2026-04-28T10:01:00Z"
    }
  ]
}
```

### POST /api/video/retry/:id

重新提交任务。

**响应**: 同 create

## 6. 页面设计

### 6.1 /config 页面

**功能**: 显示当前 API 配置状态

**字段**:
- Provider: jimeng
- Base URL: https://jimeng.jianying.com
- Model: jimeng-video-v2
- API Key: 已配置 ✅ / 未配置 ❌ (不显示完整 Key)
- 测试连接按钮

**布局**: 居中卡片式

### 6.2 /generate 页面

**功能**: 视频生成调试

**表单字段**:
- prompt: 文本框 (必填)
- image_url: 输入框 (image_to_video 模式必填)
- mode: 下拉选择 text_to_video / image_to_video
- ratio: 单选 16:9 / 9:16 / 1:1
- duration: 下拉 5s / 10s
- resolution: 下拉 720p / 1080p
- submit: 提交按钮

**提交后显示**:
- local_task_id
- provider_task_id
- create response 原始 JSON (可折叠)
- 当前状态

### 6.3 /tasks 页面

**功能**: 任务列表

**表格列**:
- local_task_id (截断显示)
- provider_task_id (截断显示)
- prompt (摘要，truncate)
- local_status (带颜色标签)
- created_at
- completed_at
- 操作 (查看详情)

**功能**:
- 分页 (每页 20 条)
- 点击查看详情跳转到 /tasks/[id]

### 6.4 /tasks/[id] 页面

**功能**: 任务详情

**显示区域**:
1. 基本信息卡片
   - local_task_id
   - provider_task_id
   - local_status
   - created_at
   - completed_at

2. 提交参数
   - mode
   - ratio
   - duration
   - resolution
   - prompt
   - image_url

3. 操作区
   - 查询状态按钮
   - 自动轮询开关 (每 5 秒)

4. 结果区
   - result_video_url
   - 视频预览播放器
   - 下载按钮

5. 原始 JSON
   - create response (可折叠 JSON viewer)
   - status response (可折叠 JSON viewer)

6. 错误信息
   - error_message (如果有)

## 7. 验收标准

1. ✅ 可以打开网页
2. ✅ 可以填写提示词并提交
3. ✅ 后端不会暴露 API Key
4. ✅ 可以拿到 provider_task_id
5. ✅ 可以查询任务状态
6. ✅ 成功后可以预览视频
7. ✅ 失败后可以看到原始错误
8. ✅ 所有请求和返回 JSON 都被保存
9. ✅ 刷新页面后任务记录仍然存在

## 8. 暂时不做

- 用户注册
- 点数系统
- 多模型工作流
- 自动审核
- 自动改提示词
- 飞书接入
- 批量生成
- 复杂权限

## 9. 文件结构

```
video-api-debugger/
├── src/
│   ├── app/
│   │   ├── config/
│   │   │   └── page.tsx
│   │   ├── generate/
│   │   │   └── page.tsx
│   │   ├── tasks/
│   │   │   ├── page.tsx
│   │   │   └── [id]/
│   │   │       └── page.tsx
│   │   ├── api/
│   │   │   ├── config/
│   │   │   │   └── route.ts
│   │   │   └── video/
│   │   │       ├── create/
│   │   │       │   └── route.ts
│   │   │       ├── list/
│   │   │       │   └── route.ts
│   │   │       ├── status/
│   │   │       │   └── [id]/
│   │   │       │       └── route.ts
│   │   │       └── retry/
│   │   │           └── [id]/
│   │   │               └── route.ts
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── lib/
│   │   ├── db.ts
│   │   ├── taskStatus.ts
│   │   └── provider/
│   │       └── jimeng.ts
│   └── types/
│       └── index.ts
├── prisma/
│   └── schema.prisma
├── .env.example
├── package.json
├── tsconfig.json
├── SPEC.md
└── README.md
```
