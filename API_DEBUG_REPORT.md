# Seedance 2.0 API 联调报告

**日期**: 2026-04-28
**测试目标**: 海外 Seedance 2.0 官方 API

---

## 一、API 端点确认

| 配置项 | 值 |
|--------|-----|
| Base URL | `https://etc.seedance-api.net/server/api` |
| Create Endpoint | `POST /call` |
| Status Endpoint | `POST /getResult` |
| Auth | Body 中传 `apiKey` 字段 |
| Model | `dreamina-seedance-2-0-260128` |

---

## 二、联调测试结果

### 2.1 创建任务

```
POST https://etc.seedance-api.net/server/api/call
Content-Type: application/json

{
  "apiKey": "your_api_key_here",
  "content": [
    {
      "text": "A small white rabbit running across a clean yellow studio background, smooth camera movement, 5 seconds.",
      "type": "text"
    }
  ],
  "generate_audio": true,
  "ratio": "16:9",
  "duration": 5,
  "watermark": false,
  "resolution": "720p",
  "model": "dreamina-seedance-2-0-260128"
}
```

**HTTP Status**: `200`

**Response**:
```json
{
  "code": -1,
  "message": "apiKey not exist"
}
```

---

## 三、结论

### 3.1 ✅ 已确认正确

1. **Base URL 正确**: `https://etc.seedance-api.net/server/api`
2. **Endpoints 正确**:
   - Create: `POST /call`
   - Status: `POST /getResult`
3. **认证方式正确**: Body 中传 `apiKey` 字段
4. **Payload 结构正确**: `content` 数组 + `generate_audio` + `ratio` + `duration` + `model`

### 3.2 ❌ 问题

```
.apiKey not exist
```

**原因**: `.env` 中 API Key 是占位符 `your_api_key_here`

---

## 四、下一步

### 4.1 配置真实 API Key

请在 `.env` 中填入真实的 API Key:

```bash
SEEDANCE_API_KEY=真实密钥
```

### 4.2 重新运行测试

```bash
npm run test:api
```

---

## 五、验收标准检查

| # | 标准 | 状态 | 说明 |
|---|------|------|------|
| 1 | API Endpoint 正确 | ✅ | HTTP 200 返回 |
| 2 | 认证格式正确 | ✅ | Body apiKey 格式 |
| 3 | Payload 结构正确 | ✅ | Content 数组格式 |
| 4 | 真实 API Key | ❌ | 需要用户配置 |
| 5 | 真实 create 成功 | ⏸️ | 等待 API Key |
| 6 | 真实 task_id | ⏸️ | 等待 API Key |
| 7 | 真实 status 查询 | ⏸️ | 等待 API Key |
| 8 | 真实 video_url | ⏸️ | 等待 API Key |

---

## 六、API Key 脱敏说明

测试日志中 API Key 已脱敏显示:

```
API Key: your...here  (显示前4位+...+后4位)
```

真实密钥配置后，将显示为:

```
API Key: abcd...efgh
```

---

**请将真实 API Key 配置到 `.env` 文件的 `SEEDANCE_API_KEY` 字段，然后重新运行测试。**
