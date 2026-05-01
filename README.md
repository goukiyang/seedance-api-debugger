# 视频生成 API 调试器

即梦/Seedance 视频生成 API 调试工具 MVP。

## 快速开始

### 1. 安装依赖

```bash
npm install --cache /tmp/npm-cache
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填入你的 API Key
```

### 3. 初始化数据库

```bash
HOME=/tmp npx prisma db push
```

### 4. 启动开发服务器

```bash
npm run dev
```

### 5. 访问页面

- 首页: http://localhost:3000
- 配置页: http://localhost:3000/config
- 生成页: http://localhost:3000/generate
- 任务列表: http://localhost:3000/tasks

## 项目结构

```
src/
├── app/
│   ├── api/              # API Routes
│   │   ├── config/       # 配置接口
│   │   └── video/        # 视频相关接口
│   ├── config/          # 配置页面
│   ├── generate/        # 生成页面
│   ├── tasks/           # 任务列表和详情
│   └── layout.tsx       # 根布局
├── lib/
│   ├── db.ts            # Prisma 客户端
│   ├── taskStatus.ts    # 状态映射
│   └── provider/
│       └── jimeng.ts    # 即梦 API 适配器
├── types/
│   └── index.ts         # 类型定义
└── prisma/
    └── schema.prisma    # 数据库 Schema
```

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/config` | GET | 获取配置（不含完整 API Key） |
| `/api/video/create` | POST | 创建视频任务 |
| `/api/video/list` | GET | 获取任务列表 |
| `/api/video/status/:id` | GET | 查询任务状态 |
| `/api/video/retry/:id` | POST | 重试任务 |

## 环境变量

```env
# 数据库
DATABASE_URL="file:./dev.db"

# Provider 配置
PROVIDER=jimeng
MODEL=jimeng-video-v2
BASE_URL=https://jimeng.jianying.com

# API Key（必填）
JIMENG_API_KEY=your_api_key_here
```

## Provider 适配器

`src/lib/provider/jimeng.ts` 中包含 TODO 标记，需要根据实际 API 文档调整：

1. 请求端点
2. 请求头和认证方式
3. Payload 字段名称
4. 响应字段映射

## 数据库管理

```bash
# 打开 Prisma Studio
HOME=/tmp npx prisma studio

# 重置数据库
HOME=/tmp npx prisma db push --force-reset
```

## 技术栈

- Next.js 14 (App Router)
- TypeScript
- Prisma + SQLite
- React
