#!/bin/bash
# API 联调测试脚本
# 用于验证火山方舟/即梦视频生成 API

set -e

API_KEY="ak-7c3ea7ee9fa640e59e36092a55f41f77"
BASE_URL="https://ark.cn-beijing.volces.com/api/v3"

echo "============================================"
echo "  火山方舟/即梦视频生成 API 联调测试"
echo "============================================"
echo ""
echo "配置信息:"
echo "  - Base URL: $BASE_URL"
echo "  - API Key: ${API_KEY:0:8}...${API_KEY: -4}"
echo "  - Model: Doubao-Seedance-2.0"
echo ""

# 测试 1: 列出任务（验证认证）
echo "--------------------------------------------"
echo "测试 1: 验证 API 认证 (GET /videos)"
echo "--------------------------------------------"
RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "${BASE_URL}/videos" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json")

BODY=$(echo "$RESPONSE" | head -n -1)
HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)

echo "HTTP Status: $HTTP_CODE"
echo "Response: $BODY"
echo ""

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "✅ 认证成功"
else
  echo "❌ 认证失败"
  echo ""
  echo "可能的原因:"
  echo "  1. API Key 格式不正确 (需要 ark- 开头)"
  echo "  2. API Key 已过期或被禁用"
  echo "  3. 视频生成功能未开通"
  echo "  4. Base URL 不正确"
  echo ""
  echo "建议:"
  echo "  - 登录 https://console.volcengine.com/ark 获取正确的 ARK API Key"
  echo "  - ARK API Key 通常以 'ark-' 开头"
fi

echo ""
echo "============================================"
echo "  测试完成"
echo "============================================"
