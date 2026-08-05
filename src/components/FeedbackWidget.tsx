'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { uploadFileAsAsset } from '@/lib/http/file-upload';

type UploadItem = {
  id: string;
  file: File;
  previewUrl: string;
  assetId?: string;
  imageUrl?: string;
  uploading: boolean;
  error?: string;
};

const MAX_IMAGES = 3;
const MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export default function FeedbackWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const uploadsRef = useRef<UploadItem[]>([]);

  const hidden = useMemo(() => pathname === '/login' || pathname.startsWith('/admin'), [pathname]);

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  useEffect(() => () => {
    uploadsRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  }, []);

  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  if (hidden) return null;

  const removeUpload = (id: string) => {
    setUploads((current) => {
      const target = current.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  };

  const uploadFile = async (item: UploadItem) => {
    try {
      const asset = await uploadFileAsAsset(item.file, {
        invalidJsonMessage: '反馈截图上传服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。',
      });
      const imageUrl = asset.originalUrl;
      if (!asset.id || !imageUrl) {
        throw new Error('图片上传成功，但没有返回可提交的图片地址。');
      }
      setUploads((current) => current.map((upload) => (
        upload.id === item.id
          ? { ...upload, uploading: false, assetId: asset.id, imageUrl, error: asset.warning || undefined }
          : upload
      )));
    } catch (err) {
      setUploads((current) => current.map((upload) => (
        upload.id === item.id
          ? { ...upload, uploading: false, error: err instanceof Error ? err.message : '图片上传失败，请移除后重试。' }
          : upload
      )));
    }
  };

  const onFiles = (files: FileList | null) => {
    setError('');
    if (!files) return;
    const remaining = MAX_IMAGES - uploads.length;
    if (remaining <= 0) {
      setError('最多上传 3 张图片');
      return;
    }

    const next = Array.from(files).slice(0, remaining);
    const validItems: UploadItem[] = [];
    for (const file of next) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        setError('仅支持 jpg、jpeg、png、webp 图片');
        continue;
      }
      if (file.size > MAX_SIZE) {
        setError('单张图片不能超过 5MB');
        continue;
      }
      validItems.push({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
        uploading: true,
      });
    }

    if (validItems.length) {
      setUploads((current) => [...current, ...validItems]);
      validItems.forEach(uploadFile);
    }
  };

  const retryUpload = (id: string) => {
    const item = uploads.find((upload) => upload.id === id);
    if (!item) return;
    setUploads((current) => current.map((upload) => (
      upload.id === id ? { ...upload, uploading: true, error: undefined } : upload
    )));
    uploadFile(item);
  };

  const submit = async () => {
    setError('');
    setMessage('');
    const imageUrls = uploads.filter((item) => item.imageUrl).map((item) => item.imageUrl as string);
    const uploadedAssetIds = uploads.filter((item) => item.assetId).map((item) => item.assetId as string);
    if (!content.trim()) {
      setError('请输入反馈内容');
      return;
    }
    if (uploads.some((item) => item.uploading)) {
      setError('图片仍在上传，请稍候');
      return;
    }
    if (uploads.some((item) => !item.imageUrl)) {
      setError('有图片上传失败，请移除或重试后再提交');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          imageUrls,
          uploadedAssetIds,
          pageUrl: window.location.href,
          pathname: window.location.pathname,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '提交失败，请稍后重试。');
      setMessage('已收到反馈，谢谢。');
      setContent('');
      uploads.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      setUploads([]);
      window.setTimeout(() => {
        setMessage('');
        setOpen(false);
      }, 1500);
    } catch (err) {
      const reason = err instanceof Error ? err.message : '提交失败，请稍后重试。';
      setError(imageUrls.length > 0 ? `截图已上传成功，但反馈提交失败：${reason}` : reason);
    } finally {
      setSubmitting(false);
    }
  };

  const retrySubmitUploadedAssets = () => {
    void submit();
  };

  return (
    <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 60 }}>
      {open && (
        <section style={{
          width: 360,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 520,
          overflowY: 'auto',
          marginBottom: 12,
          padding: 16,
          borderRadius: 8,
          background: '#111318',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 18px 48px rgba(0,0,0,0.32)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>反馈</h2>
              <p style={{ margin: '6px 0 0', color: 'rgba(255,255,255,0.62)', fontSize: 13 }}>
                告诉我们哪里不好用，支持截图上传。
              </p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="收起反馈" style={iconButtonStyle}>×</button>
          </div>

          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="请输入你的反馈"
            rows={5}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              marginTop: 14,
              padding: 12,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: '#fff',
              resize: 'vertical',
              fontSize: 14,
            }}
          />

          <label style={{
            display: 'block',
            marginTop: 12,
            padding: 14,
            textAlign: 'center',
            border: '1px dashed rgba(255,255,255,0.22)',
            borderRadius: 8,
            color: 'rgba(255,255,255,0.72)',
            cursor: uploads.length >= MAX_IMAGES ? 'not-allowed' : 'pointer',
          }}>
            上传图片（最多 3 张）
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={uploads.length >= MAX_IMAGES}
              onChange={(event) => {
                onFiles(event.target.files);
                event.currentTarget.value = '';
              }}
              style={{ display: 'none' }}
            />
          </label>

          {uploads.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 }}>
              {uploads.map((item) => (
                <div key={item.id} style={{ position: 'relative' }}>
                  <img src={item.previewUrl} alt="反馈图片预览" style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 8 }} />
                  <button type="button" onClick={() => removeUpload(item.id)} aria-label="移除图片" style={{ ...iconButtonStyle, position: 'absolute', top: 4, right: 4 }}>×</button>
                  <div style={{ marginTop: 4, minHeight: 18, color: item.error ? '#fca5a5' : 'rgba(255,255,255,0.58)', fontSize: 11 }}>
                    {item.uploading ? '上传中' : item.error ? item.error : '已上传'}
                  </div>
                  {item.error && !item.uploading && !item.imageUrl && (
                    <button type="button" onClick={() => retryUpload(item.id)} style={linkButtonStyle}>重试</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {(message || error) && (
            <div style={{
              marginTop: 12,
              color: error ? '#fca5a5' : '#86efac',
              fontSize: 13,
            }}>
              {error || message}
            </div>
          )}
          {error.startsWith('截图已上传成功，但反馈提交失败') && (
            <button type="button" onClick={retrySubmitUploadedAssets} disabled={submitting} style={{ ...linkButtonStyle, marginTop: 8 }}>
              重新提交反馈
            </button>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button type="button" onClick={() => setOpen(false)} style={secondaryButtonStyle}>取消</button>
            <button type="button" onClick={submit} disabled={submitting} style={primaryButtonStyle}>
              {submitting ? '提交中' : '提交'}
            </button>
          </div>
        </section>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="反馈"
        title="反馈"
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          border: '1px solid rgba(255,255,255,0.2)',
          background: open ? '#4f46e5' : '#181b22',
          color: '#fff',
          boxShadow: '0 10px 24px rgba(0,0,0,0.24)',
          cursor: 'pointer',
          fontSize: 24,
          lineHeight: '56px',
        }}
        onMouseEnter={(event) => { event.currentTarget.style.transform = 'scale(1.06)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.transform = 'scale(1)'; }}
      >
        ?
      </button>
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(0,0,0,0.42)',
  color: '#fff',
  cursor: 'pointer',
};

const primaryButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 8,
  padding: '10px 16px',
  background: '#4f46e5',
  color: '#fff',
  fontWeight: 700,
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 8,
  padding: '10px 16px',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
  cursor: 'pointer',
};

const linkButtonStyle: React.CSSProperties = {
  border: 'none',
  padding: 0,
  background: 'transparent',
  color: '#c7d2fe',
  cursor: 'pointer',
  fontSize: 12,
};
