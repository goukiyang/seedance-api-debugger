'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { GenerationMode } from '@/types';
import { GENERATION_MODE_LABELS } from '@/types';
import { ThumbnailCard } from '@/components/ThumbnailCard';

interface VideoTask {
  id: string;
  provider: string;
  model: string;
  generation_mode: GenerationMode;
  prompt: string;
  ratio: string | null;
  duration: number | null;
  resolution: string | null;
  seed: number | null;
  generate_audio: boolean | null;
  return_last_frame: boolean | null;
  watermark: boolean | null;
  reference_image_urls: string | null;
  reference_video_urls: string | null;
  reference_audio_urls: string | null;
  first_frame_url: string | null;
  last_frame_url: string | null;
  frame_image_urls: string | null;
  callback_url: string | null;
  execution_expires_after: number | null;
  local_status: string;
  provider_task_id: string | null;
  provider_status: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  raw_create_response: string | null;
  raw_status_response: string | null;
  error_message: string | null;
  reference_images_json: string | null;
  provider_payload_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ============================================================================
// ReferenceImageDebug — 参考图调试信息区块
// ============================================================================

interface RefImageDebugEntry {
  index: number;
  label: string;
  originalUrl: string;
  resolvedUrl: string | null;
  fileSize: number;
  mimeType: string;
  status: 'resolved' | 'skipped' | 'failed';
}

interface ProviderPayloadDebug {
  model?: string;
  generation_mode?: string;
  resolved_mode?: string;
  prompt?: string;
  content_item_count?: number;
  reference_images_count?: number;
  first_frame_base64_status?: string;
  last_frame_base64_status?: string;
  ratio?: string;
  duration?: number;
  resolution?: string;
  content?: Array<Record<string, unknown>>;
}

interface ReferenceImageDebugProps {
  task: VideoTask;
  refImagesDebug: RefImageDebugEntry[];
  providerPayload: ProviderPayloadDebug;
}

function ReferenceImageDebug({ task, refImagesDebug, providerPayload }: ReferenceImageDebugProps) {
  const [showDebug, setShowDebug] = useState(false);

  const hasRefImages = refImagesDebug.length > 0;
  const hasPayload = Object.keys(providerPayload).length > 0;

  if (!hasRefImages && !hasPayload) {
    return null;
  }

  const referenceImages = parseJsonArray(task.reference_image_urls);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-title mb-0">
          参考图调试信息
          {refImagesDebug.length > 0 && (
            <span className={`ml-2 text-xs px-2 py-0.5 rounded ${
              refImagesDebug.some(i => i.status === 'resolved')
                ? 'bg-green-100 text-green-700'
                : 'bg-yellow-100 text-yellow-700'
            }`}>
              {refImagesDebug.filter(i => i.status === 'resolved').length}/{refImagesDebug.length} 已解析
            </span>
          )}
        </h2>
        <button
          className="text-sm text-blue-500"
          onClick={() => setShowDebug(!showDebug)}
        >
          {showDebug ? '收起' : '展开'}
        </button>
      </div>

      {showDebug && (
        <div className="space-y-4">

          {/* 1. 前端输入 — Workspace 中的参考图 */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs">1</span>
              前端输入 — Workspace 参考图 ({referenceImages.length} 张)
            </h3>
            <div className="flex flex-wrap gap-2">
              {referenceImages.map((url, i) => (
                <div key={i} className="flex-shrink-0">
                  <ThumbnailCard
                    thumbnailUrl={url}
                    originalUrl={url}
                    fileName={`图${i + 1}`}
                    type="image"
                    index={i}
                    isDragging={false}
                    isDragOver={false}
                  />
                </div>
              ))}
              {referenceImages.length === 0 && (
                <span className="text-xs text-gray-400 py-2">无</span>
              )}
            </div>
          </div>

          {/* 2. 后端接收 — base64 解析状态 */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs">2</span>
              后端接收 — 图片解析状态
            </h3>
            <div className="space-y-1">
              {refImagesDebug.map((img) => (
                <div key={img.index} className={`text-xs p-2 rounded ${
                  img.status === 'resolved' ? 'bg-green-50' :
                  img.status === 'failed' ? 'bg-red-50' : 'bg-gray-50'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{img.label}</span>
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      img.status === 'resolved' ? 'bg-green-200 text-green-800' :
                      img.status === 'failed' ? 'bg-red-200 text-red-800' : 'bg-gray-200 text-gray-600'
                    }`}>
                      {img.status === 'resolved' ? '✓ base64 已解析' :
                       img.status === 'failed' ? '✗ 解析失败' : '跳过'}
                    </span>
                    <span className="text-gray-500">{img.mimeType}</span>
                    {img.fileSize > 0 && (
                      <span className="text-gray-500">{(img.fileSize / 1024).toFixed(1)} KB</span>
                    )}
                  </div>
                  <div className="text-gray-400 mt-0.5 truncate" title={img.originalUrl}>
                    原始路径: {img.originalUrl}
                  </div>
                  {img.resolvedUrl && img.resolvedUrl !== img.originalUrl && (
                    <div className="text-green-600 mt-0.5 truncate" title={img.resolvedUrl}>
                      已解析: {img.resolvedUrl}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 3. Provider 请求 — resolved mode + content array */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs">3</span>
              Provider 请求 — 最终 Payload
            </h3>

            <div className="bg-gray-50 p-3 rounded text-xs space-y-1 mb-2">
              <div><span className="text-gray-500">resolved_mode:</span> <span className="font-medium">{providerPayload.resolved_mode || task.generation_mode}</span></div>
              <div><span className="text-gray-500">content items:</span> <span className="font-medium">{providerPayload.content_item_count ?? 0}</span></div>
              <div><span className="text-gray-500">reference_images_count:</span> <span className="font-medium">{providerPayload.reference_images_count ?? 0}</span></div>
              <div><span className="text-gray-500">first_frame:</span> <span className="font-medium">{providerPayload.first_frame_base64_status ?? 'none'}</span></div>
            </div>

            {/* 渲染后的 Prompt */}
            {providerPayload.prompt && (
              <div className="mb-2">
                <div className="text-xs text-gray-500 mb-1">Prompt (渲染后):</div>
                <div className="bg-gray-50 p-3 rounded text-xs text-gray-700 whitespace-pre-wrap break-all">
                  {providerPayload.prompt}
                </div>
              </div>
            )}

            {/* Content Array 详情 */}
            {providerPayload.content && providerPayload.content.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Content Array ({providerPayload.content.length} 项):</div>
                <div className="space-y-1">
                  {providerPayload.content.map((item, i) => {
                    const itemWithUnknown = item as Record<string, unknown>;
                    return (
                      <div key={i} className="bg-gray-50 p-2 rounded text-xs">
                        <span className="font-medium text-gray-700">[{i + 1}]</span>{' '}
                        <span className="text-blue-600">{String(itemWithUnknown.type || '')}</span>
                        {itemWithUnknown.role ? <span className="ml-1 text-gray-500">({String(itemWithUnknown.role)})</span> : null}
                        {itemWithUnknown.text ? <span className="ml-1 text-gray-600 truncate max-w-xs">"{String(itemWithUnknown.text).slice(0, 60)}..."</span> : null}
                        {itemWithUnknown.image_url ? <span className="ml-1 text-green-600 break-all">{String((itemWithUnknown.image_url as Record<string, unknown>).url || '').slice(0, 80)}</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* 4. Provider 返回 */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs">4</span>
              Provider 返回
            </h3>
            {task.raw_create_response ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-blue-500 mb-1">raw_create_response</summary>
                <pre className="bg-gray-900 text-green-400 p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap break-all">
                  {JSON.stringify(JSON.parse(task.raw_create_response || '{}'), null, 2)}
                </pre>
              </details>
            ) : (
              <span className="text-xs text-gray-400">暂无</span>
            )}
          </div>

        </div>
      )}
    </div>
  );
}

function getStatusClass(status: string) {
  const statusMap: Record<string, string> = {
    draft: 'status-draft',
    submitted: 'status-submitted',
    running: 'status-running',
    succeeded: 'status-succeeded',
    failed: 'status-failed',
    cancelled: 'status-cancelled',
  };
  return statusMap[status] || 'status-draft';
}

function getStatusText(status: string) {
  const textMap: Record<string, string> = {
    draft: '草稿',
    submitted: '已提交',
    running: '生成中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return textMap[status] || status;
}

function formatJson(str: string | null): string {
  if (!str) return '{}';
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function parseJsonArray(str: string | null): string[] {
  if (!str) return [];
  try {
    return JSON.parse(str);
  } catch {
    return [];
  }
}

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.id as string;

  const [task, setTask] = useState<VideoTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [autoPoll, setAutoPoll] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // 下载状态
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState('');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState('');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  
  // 视频预览错误状态
  const [videoError, setVideoError] = useState(false);
  const [copied, setCopied] = useState(false);

  // 显示原始响应
  const [showCreateResponse, setShowCreateResponse] = useState(false);
  const [showStatusResponse, setShowStatusResponse] = useState(false);

  const fetchTask = useCallback(async () => {
    try {
      const res = await fetch(`/api/video/status/${taskId}`);
      const data = await res.json();
      if (res.ok) {
        setTask(data);
        setVideoError(false);
      }
    } catch (error) {
      console.error('Failed to fetch task:', error);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchTask();
  }, [fetchTask]);

  // Auto polling
  useEffect(() => {
    if (!autoPoll) return;

    const interval = setInterval(() => {
      fetchTask();
    }, 5000);

    return () => clearInterval(interval);
  }, [autoPoll, fetchTask]);

  // Stop polling when task is terminal
  useEffect(() => {
    if (task && ['succeeded', 'failed', 'cancelled'].includes(task.local_status)) {
      setAutoPoll(false);
    }
  }, [task]);

  const queryStatus = async () => {
    setQuerying(true);
    await fetchTask();
    setQuerying(false);
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/video/retry/${taskId}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        router.push(`/tasks/${data.id}`);
      } else {
        alert(`重试失败: ${data.message}`);
      }
    } catch (error) {
      alert(`重试失败: ${error}`);
    } finally {
      setRetrying(false);
    }
  };

  // 后端下载视频（支持进度追踪）
  const handleDownloadToLocal = async () => {
    if (!task) return;
    
    setDownloading(true);
    setDownloadProgress('正在下载视频...');
    setDownloadPercent(0);
    setDownloadSpeed('');
    setDownloadError(null);
    
    const startTime = Date.now();
    let lastUpdateTime = startTime;
    let lastBytes = 0;
    
    try {
      const res = await fetch(`/api/video/download/${taskId}`, {
        method: 'POST',
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const fileSizeMB = (data.file_size / 1024 / 1024).toFixed(2);
        
        setDownloadProgress(`✅ 下载完成! 文件大小: ${fileSizeMB} MB，耗时: ${elapsed}s`);
        setDownloadPercent(100);
        setDownloadSpeed('');
        
        // 如果文件已存在，提示用户
        if (data.already_exists) {
          setDownloadProgress(`✅ 视频已存在于本地: ${fileSizeMB} MB`);
        }
        
        await fetchTask();
      } else {
        const errorMsg = data.message || data.error || '未知错误';
        setDownloadError(errorMsg);
        setDownloadProgress(`❌ 下载失败: ${errorMsg}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setDownloadError(errorMsg);
      setDownloadProgress(`❌ 下载失败: ${errorMsg}`);
    } finally {
      setDownloading(false);
    }
  };

  // 复制视频 URL
  const handleCopyUrl = () => {
    if (task?.result_video_url) {
      navigator.clipboard.writeText(task.result_video_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // 直接打开视频 URL
  const handleOpenUrl = () => {
    if (task?.result_video_url) {
      window.open(task.result_video_url, '_blank');
    }
  };

  // 获取视频播放源
  const getVideoSrc = () => {
    if (!task) return '';
    if (task.local_video_path) {
      return task.local_video_path;
    }
    return task.result_video_url || '';
  };

  if (loading) {
    return (
      <div className="card">
        <p className="text-gray">加载中...</p>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="card">
        <p className="text-red">任务不存在</p>
        <Link href="/tasks" className="btn btn-secondary mt-4">
          返回列表
        </Link>
      </div>
    );
  }

  const referenceImages = parseJsonArray(task.reference_image_urls);
  const referenceVideos = parseJsonArray(task.reference_video_urls);
  const referenceAudios = parseJsonArray(task.reference_audio_urls);
  const frameImages = parseJsonArray(task.frame_image_urls);
  const videoSrc = getVideoSrc();
  const hasLocalVideo = !!task.local_video_path;
  
  // 从 provider_payload_json 解析 resolved_mode
  const resolvedMode = (() => {
    if (!task.provider_payload_json) return null;
    try {
      const payload = JSON.parse(task.provider_payload_json);
      return payload.resolved_mode || null;
    } catch {
      return null;
    }
  })();

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">任务详情</h1>
        <p className="page-description">查看任务详细信息和生成结果</p>
      </div>

      {/* 基本信息 */}
      <div className="card">
        <h2 className="section-title">基本信息</h2>
        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">本地任务 ID</span>
            <span className="info-value">{task.id}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Provider 任务 ID</span>
            <span className="info-value">{task.provider_task_id || '-'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">模型</span>
            <span className="info-value">Seedance 2.0</span>
          </div>
          <div className="info-item">
            <span className="info-label">生成模式</span>
            <span className="info-value">{GENERATION_MODE_LABELS[task.generation_mode] || task.generation_mode}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Resolved 模式</span>
            <span className="info-value">
              {(() => {
                if (!resolvedMode || resolvedMode === task.generation_mode) return '-';
                return (
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    resolvedMode === 'text_to_video' ? 'bg-gray-100 text-gray-600' :
                    resolvedMode === 'all_in_one_reference' ? 'bg-blue-100 text-blue-700' :
                    'bg-purple-100 text-purple-700'
                  }`}>
                    {resolvedMode}
                  </span>
                );
              })()}
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">本地状态</span>
            <span className="info-value">
              <span className={`status-badge ${getStatusClass(task.local_status)}`}>
                {getStatusText(task.local_status)}
              </span>
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">Provider 状态</span>
            <span className="info-value">{task.provider_status || '-'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">创建时间</span>
            <span className="info-value">
              {new Date(task.created_at).toLocaleString('zh-CN')}
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">更新时间</span>
            <span className="info-value">
              {new Date(task.updated_at).toLocaleString('zh-CN')}
            </span>
          </div>
          {task.completed_at && (
            <div className="info-item">
              <span className="info-label">完成时间</span>
              <span className="info-value">
                {new Date(task.completed_at).toLocaleString('zh-CN')}
              </span>
            </div>
          )}
          
          {/* Provider 返回的扩展字段 */}
          {task.local_status === 'succeeded' && (
            <>
              <div className="info-item">
                <span className="info-label">Provider 模型</span>
                <span className="info-value font-mono text-xs">{task.model || '-'}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Provider 分辨率</span>
                <span className="info-value">{task.resolution || '-'}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Provider 比例</span>
                <span className="info-value">{task.ratio || '-'}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Provider 时长</span>
                <span className="info-value">{task.duration ? `${task.duration}秒` : '-'}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 提交参数 */}
      <div className="card">
        <h2 className="section-title">提交参数</h2>
        <div className="info-grid">
          <div className="info-item" style={{ gridColumn: '1 / -1' }}>
            <span className="info-label">提示词</span>
            <span className="info-value" style={{ whiteSpace: 'pre-wrap' }}>
              {task.prompt}
            </span>
          </div>
          
          {/* 生成参数 */}
          <div className="info-item">
            <span className="info-label">比例</span>
            <span className="info-value">{task.ratio || '-'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">时长</span>
            <span className="info-value">{task.duration ? `${task.duration}秒` : '-'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">分辨率</span>
            <span className="info-value">{task.resolution || '-'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">随机种子</span>
            <span className="info-value">{task.seed === -1 ? '随机' : task.seed || '-'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">生成音频</span>
            <span className="info-value">{task.generate_audio ? '是' : '否'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">返回尾帧</span>
            <span className="info-value">{task.return_last_frame ? '是' : '否'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">水印</span>
            <span className="info-value">{task.watermark ? '是' : '否'}</span>
          </div>

          {/* 全能参考素材 */}
          {task.generation_mode === 'all_in_one_reference' && referenceImages.length > 0 && (
            <div className="info-item" style={{ gridColumn: '1 / -1' }}>
              <span className="info-label">参考图片 ({referenceImages.length})</span>
              <div className="space-y-1 mt-1">
                {referenceImages.map((url, i) => (
                  <div key={i} className="text-sm">
                    <span className="text-gray">@图片{i + 1}:</span>{' '}
                    <a href={url} target="_blank" rel="noopener noreferrer" className="table-link">
                      {url.substring(0, 60)}...
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {task.generation_mode === 'all_in_one_reference' && referenceVideos.length > 0 && (
            <div className="info-item" style={{ gridColumn: '1 / -1' }}>
              <span className="info-label">参考视频 ({referenceVideos.length})</span>
              <div className="space-y-1 mt-1">
                {referenceVideos.map((url, i) => (
                  <div key={i} className="text-sm">
                    <span className="text-gray">@视频{i + 1}:</span>{' '}
                    <a href={url} target="_blank" rel="noopener noreferrer" className="table-link">
                      {url.substring(0, 60)}...
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {task.generation_mode === 'all_in_one_reference' && referenceAudios.length > 0 && (
            <div className="info-item" style={{ gridColumn: '1 / -1' }}>
              <span className="info-label">参考音频 ({referenceAudios.length})</span>
              <div className="space-y-1 mt-1">
                {referenceAudios.map((url, i) => (
                  <div key={i} className="text-sm">
                    <span className="text-gray">@音频{i + 1}:</span>{' '}
                    <a href={url} target="_blank" rel="noopener noreferrer" className="table-link">
                      {url.substring(0, 60)}...
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 首尾帧素材 */}
          {task.generation_mode === 'first_last_frame' && task.first_frame_url && (
            <div className="info-item" style={{ gridColumn: '1 / -1' }}>
              <span className="info-label">首帧图片</span>
              <a href={task.first_frame_url} target="_blank" rel="noopener noreferrer" className="table-link">
                {task.first_frame_url}
              </a>
            </div>
          )}

          {task.generation_mode === 'first_last_frame' && task.last_frame_url && (
            <div className="info-item" style={{ gridColumn: '1 / -1' }}>
              <span className="info-label">尾帧图片</span>
              <a href={task.last_frame_url} target="_blank" rel="noopener noreferrer" className="table-link">
                {task.last_frame_url}
              </a>
            </div>
          )}

          {/* 智能多帧素材 */}
          {task.generation_mode === 'smart_multi_frame' && frameImages.length > 0 && (
            <div className="info-item" style={{ gridColumn: '1 / -1' }}>
              <span className="info-label">多帧图片 ({frameImages.length})</span>
              <div className="space-y-1 mt-1">
                {frameImages.map((url, i) => (
                  <div key={i} className="text-sm">
                    <span className="text-gray">第{i + 1}帧:</span>{' '}
                    <a href={url} target="_blank" rel="noopener noreferrer" className="table-link">
                      {url.substring(0, 60)}...
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 操作 */}
      <div className="card">
        <h2 className="section-title">操作</h2>
        <div className="flex items-center gap-4 mb-4">
          <button
            className="btn btn-primary"
            onClick={queryStatus}
            disabled={querying}
          >
            {querying ? (
              <>
                <span className="loading" style={{ marginRight: 8 }}></span>
                查询中...
              </>
            ) : (
              '查询状态'
            )}
          </button>

          <label className="flex items-center gap-2">
            <span className="text-sm">自动轮询 (5秒)</span>
            <div className="toggle-switch">
              <input
                type="checkbox"
                checked={autoPoll}
                onChange={(e) => setAutoPoll(e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </div>
          </label>

          {task.local_status === 'failed' && (
            <button
              className="btn btn-danger"
              onClick={handleRetry}
              disabled={retrying}
            >
              {retrying ? '重试中...' : '重新生成'}
            </button>
          )}
        </div>
      </div>

      {/* 生成结果 */}
      {task.local_status === 'succeeded' && (task.result_video_url || task.local_video_path) && (
        <div className="card">
          <h2 className="section-title">生成结果</h2>
          
          {/* 视频播放器 */}
          <div className="video-preview mb-4">
            <video
              key={videoSrc}
              controls
              playsInline
              style={{ width: '100%', borderRadius: 8 }}
              src={videoSrc}
              onError={() => setVideoError(true)}
              onCanPlay={() => setVideoError(false)}
            >
              您的浏览器不支持视频播放
            </video>
          </div>

          {/* 预览失败提示 */}
          {videoError && (
            <div className="alert alert-warning mb-4">
              <p className="mb-2">⚠️ 视频预览可能失败，请尝试以下操作：</p>
              <div className="flex gap-2 flex-wrap">
                <button className="btn btn-secondary" onClick={handleOpenUrl}>
                  直接打开视频链接
                </button>
                <button className="btn btn-secondary" onClick={handleCopyUrl}>
                  {copied ? '已复制!' : '复制视频 URL'}
                </button>
              </div>
            </div>
          )}

          {/* 尾帧图片 */}
          {task.result_last_frame_url && (
            <div className="mb-4">
              <span className="info-label">尾帧图片</span>
              <div className="mt-2">
                <img 
                  src={task.result_last_frame_url} 
                  alt="Last Frame" 
                  style={{ maxWidth: '100%', borderRadius: 8 }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
            </div>
          )}

          {/* 本地视频状态 */}
          {hasLocalVideo ? (
            <div className="alert alert-success mb-4">
              ✅ 本地视频已保存: {task.local_video_path}
            </div>
          ) : (
            <div className="alert alert-info mb-4">
              💡 提示: 建议转存到本地以便长期保存
            </div>
          )}

          {/* 下载按钮 */}
          <div className="flex gap-2 flex-wrap">
            <button 
              className="btn btn-secondary" 
              onClick={handleOpenUrl}
              disabled={!task.result_video_url}
            >
              直接打开远程视频
            </button>

            <button 
              className="btn btn-secondary" 
              onClick={handleCopyUrl}
              disabled={!task.result_video_url}
            >
              {copied ? '✅ 已复制' : '复制视频 URL'}
            </button>

            <button 
              className="btn btn-primary" 
              onClick={handleDownloadToLocal}
              disabled={downloading || hasLocalVideo}
            >
              {downloading ? '下载中...' : hasLocalVideo ? '已保存到本地' : '转存到本地'}
            </button>

            {downloadError && (
              <button 
                className="btn btn-secondary" 
                onClick={handleDownloadToLocal}
              >
                重试下载
              </button>
            )}
          </div>

          {/* 下载进度条 */}
          {(downloading || downloadProgress) && (
            <div className="mt-4">
              {/* 进度条容器 */}
              <div className="mb-2">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>{downloading ? '下载中...' : '下载状态'}</span>
                  <span>{downloadPercent}%{downloadSpeed && ` · ${downloadSpeed}`}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                  <div 
                    className={`h-full rounded-full transition-all duration-300 ${
                      downloadError ? 'bg-red-500' : downloading ? 'bg-blue-500 animate-pulse' : 'bg-green-500'
                    }`}
                    style={{ width: `${downloadPercent}%` }}
                  />
                </div>
              </div>
              
              {/* 状态文字 */}
              <div className={`text-sm ${downloadError ? 'text-red-500' : 'text-gray-600'}`}>
                {downloadProgress}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 错误信息 */}
      {task.local_status === 'failed' && task.error_message && (
        <div className="card">
          <h2 className="section-title">错误信息</h2>
          <div className="alert alert-error">
            {task.error_message}
          </div>
        </div>
      )}

      {/* ===== 参考图调试信息区块 ===== */}
      {(() => {
        const refImagesDebug: RefImageDebugEntry[] = [];
        if (task.reference_images_json) {
          try {
            const parsed = JSON.parse(task.reference_images_json);
            if (Array.isArray(parsed)) refImagesDebug.push(...parsed);
          } catch {}
        }

        const providerPayload: ProviderPayloadDebug = {};
        if (task.provider_payload_json) {
          try { Object.assign(providerPayload, JSON.parse(task.provider_payload_json)); } catch {}
        }

        return (
          <ReferenceImageDebug
            task={task}
            refImagesDebug={refImagesDebug}
            providerPayload={providerPayload}
          />
        );
      })()}

      {/* 原始响应 */}
      <div className="card">
        <h2 className="section-title">原始响应</h2>

        <div className="collapsible mb-4">
          <div
            className="collapsible-header"
            onClick={() => setShowCreateResponse(!showCreateResponse)}
          >
            <span>创建任务响应 (raw_create_response)</span>
            <span>{showCreateResponse ? '▼' : '▶'}</span>
          </div>
          {showCreateResponse && (
            <div className="collapsible-content">
              <div className="json-viewer">
                {formatJson(task.raw_create_response)}
              </div>
            </div>
          )}
        </div>

        <div className="collapsible">
          <div
            className="collapsible-header"
            onClick={() => setShowStatusResponse(!showStatusResponse)}
          >
            <span>状态查询响应 (raw_status_response)</span>
            <span>{showStatusResponse ? '▼' : '▶'}</span>
          </div>
          {showStatusResponse && (
            <div className="collapsible-content">
              <div className="json-viewer">
                {formatJson(task.raw_status_response)}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-4 mt-4">
        <Link href="/tasks" className="btn btn-secondary">
          返回列表
        </Link>
        <Link href="/generate" className="btn btn-primary">
          创建新任务
        </Link>
      </div>
    </div>
  );
}
