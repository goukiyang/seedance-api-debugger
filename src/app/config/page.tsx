'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Config {
  provider: string;
  base_url: string;
  model: string;
  api_key_configured: boolean;
}

export default function ConfigPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      setConfig(data);
    } catch (error) {
      console.error('Failed to fetch config:', error);
    } finally {
      setLoading(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch('/api/config', {
        method: 'GET',
        cache: 'no-store',
      });

      const data = await res.json();

      if (res.ok) {
        if (data?.api_key_configured) {
          setTestResult({ success: true, message: `API 配置可用，当前 Provider: ${data.provider} / ${data.model}` });
        } else {
          setTestResult({ success: false, message: 'API Key 未配置，无法发起生成任务' });
        }
      } else {
        setTestResult({ success: false, message: `API 配置异常: ${data.message || data.error}` });
      }
    } catch (error) {
      setTestResult({
        success: false,
        message: `连接失败: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="card">
        <p className="text-gray">加载中...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">API 配置</h1>
        <p className="page-description">当前 API 配置状态（API Key 不会完整显示）</p>
      </div>

      <div className="card">
        <h2 className="section-title">当前配置</h2>

        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">Provider</span>
            <span className="info-value">{config?.provider || '-'}</span>
          </div>

          <div className="info-item">
            <span className="info-label">Base URL</span>
            <span className="info-value">{config?.base_url || '-'}</span>
          </div>

          <div className="info-item">
            <span className="info-label">Model</span>
            <span className="info-value">{config?.model || '-'}</span>
          </div>

          <div className="info-item">
            <span className="info-label">API Key</span>
            <span className="info-value">
              {config?.api_key_configured ? (
                <span className="text-green">已配置 ✅</span>
              ) : (
                <span className="text-red">未配置 ❌</span>
              )}
            </span>
          </div>
        </div>

        <div className="mt-4">
          <button
            className="btn btn-primary"
            onClick={testConnection}
            disabled={testing}
          >
            {testing ? (
              <>
                <span className="loading" style={{ marginRight: 8 }}></span>
                测试中...
              </>
            ) : (
              '测试配置可用性'
            )}
          </button>

          {testResult && (
            <div className={`alert ${testResult.success ? 'alert-success' : 'alert-error'} mt-4`}>
              {testResult.message}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="section-title">环境变量说明</h2>
        <p className="text-sm text-gray mb-4">
          请在项目根目录的 <code>.env</code> 文件中配置以下环境变量：
        </p>
        <div className="json-viewer">
{`# 数据库
DATABASE_URL="file:./dev.db"

# Provider 配置
PROVIDER=jimeng
MODEL=jimeng-video-v2
BASE_URL=https://jimeng.jianying.com

# API Key（必填）
JIMENG_API_KEY=your_api_key_here`}
        </div>
      </div>

      {/* 资产接口文档 */}
      <div className="card">
        <h2 className="section-title">资产接口 (Asset API)</h2>
        <p className="text-sm text-gray mb-4">
          官方 Asset API 支持上传和管理图片/视频/音频素材。Base URL: <code>https://etc.seedance-api.net/server/asset</code>
        </p>

        {/* 创建资产 */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-700 mb-2">1. 创建资产 (CreateAsset)</h3>
          <p className="text-xs text-gray mb-2">
            <code>AssetType</code> 有效值: <strong>Image</strong>, <strong>Video</strong>, <strong>Audio</strong>
          </p>
          <div className="json-viewer">
{`curl -X POST "https://etc.seedance-api.net/server/asset/create" \\
  -H "Content-Type: application/json" \\
  -d '{
    "apiKey": "YOUR_API_KEY",
    "AssetType": "Image",
    "URL": "https://example.com/image.jpg",
    "Name": "my-asset"
  }'

# 响应示例:
{
  "ResponseMetadata": {
    "RequestId": "2026042300403287EB21C4B3EEC35187FE",
    "Action": "CreateAsset",
    "Version": "2024-01-01",
    "Service": "ark",
    "Region": "ap-southeast-1"
  },
  "Result": {
    "Id": "asset-20260423005034-afdj8"
  }
}`}
          </div>
        </div>

        {/* 更新资产 */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-700 mb-2">2. 更新资产 (UpdateAsset)</h3>
          <div className="json-viewer">
{`curl -X POST "https://etc.seedance-api.net/server/asset/update" \\
  -H "Content-Type: application/json" \\
  -d '{
    "apiKey": "YOUR_API_KEY",
    "Id": "asset-20260423005034-afdj8",
    "Name": "updated-name"
  }'

# 响应示例:
{
  "ResponseMetadata": {
    "RequestId": "202604230055396B7D676B6D90E1549167",
    "Action": "UpdateAsset",
    "Version": "2024-01-01",
    "Service": "ark",
    "Region": "ap-southeast-1"
  },
  "Result": {
    "Id": "asset-20260423005034-afdj8"
  }
}`}
          </div>
        </div>

        {/* 查询资产 */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-700 mb-2">3. 查询资产 (GetAsset)</h3>
          <div className="json-viewer">
{`curl -X POST "https://etc.seedance-api.net/server/asset/get" \\
  -H "Content-Type: application/json" \\
  -d '{
    "apiKey": "YOUR_API_KEY",
    "Id": "asset-20260423005034-afdj8"
  }'

# 响应示例:
{
  "ResponseMetadata": {
    "RequestId": "202604230055396B7D676B6D90E1549167",
    "Action": "GetAsset",
    "Version": "2024-01-01",
    "Service": "ark",
    "Region": "ap-southeast-1"
  },
  "Result": {
    "Id": "asset-20260423005034-afdj8",
    "Name": "asset2",
    "URL": "https://ark-media-asset-ap-southeast-1.tos-ap-southeast-1.volces.com/...jpg?X-Tos-Algorithm=...&X-Tos-Expires=43200&X-Tos-Signature=...",
    "AssetType": "Image",
    "GroupId": "group-20260423000634-agbr5",
    "Status": "Active",
    "CreateTime": "2026-04-23T16:40:34Z",
    "UpdateTime": "2026-04-23T16:55:39Z",
    "ProjectName": "default"
  }
}`}
          </div>
        </div>

        <div className="flex gap-4">
          <Link href="/generate" className="btn btn-primary">
            去生成视频
          </Link>
          <Link href="/tasks" className="btn btn-secondary">
            查看任务列表
          </Link>
        </div>
      </div>
    </div>
  );
}
