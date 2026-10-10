'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import { ImagePlus, MessageSquare, X } from 'lucide-react';

type UploadItem = {
  id: string;
  file?: File;
  previewUrl?: string;
  assetId?: string;
  imageUrl?: string;
  uploading: boolean;
  error?: string;
};

const MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const FEEDBACK_DRAFT_PREFIX = 'feedback-widget:draft:v1:';

type FeedbackDraft = {
  content: string;
  uploads: UploadItem[];
};

function revokePreviewUrl(url?: string) {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

function feedbackDraftKey(userId: string | null) {
  return `${FEEDBACK_DRAFT_PREFIX}${userId ? `user:${encodeURIComponent(userId)}` : 'guest'}`;
}

function isRestorableImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('//')) return false;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function readFeedbackDraft(key: string): FeedbackDraft {
  try {
    const value = localStorage.getItem(key);
    if (!value) return { content: '', uploads: [] };
    const parsed = JSON.parse(value) as { version?: unknown; content?: unknown; uploads?: unknown };
    if (parsed.version !== 1) return { content: '', uploads: [] };
    const uploads = Array.isArray(parsed.uploads)
      ? parsed.uploads.flatMap((item: unknown): UploadItem[] => {
        if (!item || typeof item !== 'object') return [];
        const upload = item as { id?: unknown; assetId?: unknown; imageUrl?: unknown };
        if (typeof upload.id !== 'string' || typeof upload.assetId !== 'string' || !isRestorableImageUrl(upload.imageUrl)) return [];
        return [{ id: upload.id, assetId: upload.assetId, imageUrl: upload.imageUrl, previewUrl: upload.imageUrl, uploading: false }];
      })
      : [];
    return { content: typeof parsed.content === 'string' ? parsed.content : '', uploads };
  } catch {
    return { content: '', uploads: [] };
  }
}

export default function FeedbackWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const uploadsRef = useRef<UploadItem[]>([]);
  const contentRef = useRef('');
  const draftKeyRef = useRef<string | null>(null);
  const contentEditedRef = useRef(false);
  const draftIdentityReadyRef = useRef(false);
  const submittingRef = useRef(false);
  const activeUploadsRef = useRef(new Set<string>());
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(''), 3000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const hidden = useMemo(() => pathname === '/login' || pathname.startsWith('/admin'), [pathname]);

  useDialogDismiss({
    open: open && !hidden,
    dialogRef: panelRef,
    branchRefs: [triggerRef],
    modal: false,
    dismissOnOutside: !submitting,
    dismissOnEscape: !submitting,
    onDismiss: () => setOpen(false),
  });

  const replaceUploads = useCallback((update: React.SetStateAction<UploadItem[]>) => {
    const next = typeof update === 'function' ? update(uploadsRef.current) : update;
    uploadsRef.current = next;
    setUploads(next);
  }, []);

  const updateContent = useCallback((value: string) => {
    contentRef.current = value;
    setContent(value);
  }, []);

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  useEffect(() => () => {
    uploadsRef.current.forEach((item) => revokePreviewUrl(item.previewUrl));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    draftIdentityReadyRef.current = false;
    fetch('/api/auth/me', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to resolve feedback draft account');
        return response.json() as Promise<{ user?: { id?: unknown } | null }>;
      })
      .then((data) => {
        draftIdentityReadyRef.current = true;
        const userId = typeof data.user?.id === 'string' ? data.user.id : null;
        const nextKey = feedbackDraftKey(userId);
        if (draftKeyRef.current === nextKey) return;

        const draft = readFeedbackDraft(nextKey);
        const currentUploads = uploadsRef.current;
        if (draftKeyRef.current) {
          currentUploads.forEach((item) => revokePreviewUrl(item.previewUrl));
          replaceUploads(draft.uploads);
          contentEditedRef.current = false;
          updateContent(draft.content);
        } else {
          const currentAssetKeys = new Set(currentUploads.flatMap((item) => [item.assetId, item.imageUrl].filter(Boolean)));
          const restoredUploads = draft.uploads.filter((item) => !currentAssetKeys.has(item.assetId) && !currentAssetKeys.has(item.imageUrl));
          replaceUploads([...restoredUploads, ...currentUploads]);
          if (!contentEditedRef.current) updateContent(draft.content);
        }

        draftKeyRef.current = nextKey;
        setDraftKey(nextKey);
      })
      .catch(() => {
        if (!controller.signal.aborted) draftIdentityReadyRef.current = true;
      });
    return () => controller.abort();
  }, [pathname, replaceUploads, updateContent]);

  useEffect(() => {
    if (!draftKey) return;
    const persistedUploads = uploads.flatMap((item) => (
      item.assetId && item.imageUrl
        ? [{ id: item.id, assetId: item.assetId, imageUrl: item.imageUrl }]
        : []
    ));
    try {
      if (!content && persistedUploads.length === 0) {
        localStorage.removeItem(draftKey);
        return;
      }
      localStorage.setItem(draftKey, JSON.stringify({ version: 1, content, uploads: persistedUploads }));
    } catch {
      // Draft persistence is best-effort; feedback submission remains available.
    }
  }, [content, draftKey, uploads]);

  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  if (hidden) return null;

  const removeUpload = (id: string) => {
    replaceUploads((current) => {
      const target = current.find((item) => item.id === id);
      if (target) revokePreviewUrl(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  };

  const uploadFile = async (item: UploadItem) => {
    if (!item.file || activeUploadsRef.current.has(item.id)) return;
    activeUploadsRef.current.add(item.id);
    try {
      const asset = await uploadFileAsAsset(item.file, {
        invalidJsonMessage: '反馈截图上传服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。',
      });
      const imageUrl = asset.originalUrl;
      if (!asset.id || !imageUrl) {
        throw new Error('图片上传成功，但没有返回可提交的图片地址。');
      }
      replaceUploads((current) => current.map((upload) => (
        upload.id === item.id
          ? { ...upload, uploading: false, assetId: asset.id, imageUrl, error: asset.warning || undefined }
          : upload
      )));
    } catch (err) {
      replaceUploads((current) => current.map((upload) => (
        upload.id === item.id
          ? { ...upload, uploading: false, error: err instanceof Error ? err.message : '图片上传失败，请移除后重试。' }
          : upload
      )));
    } finally {
      activeUploadsRef.current.delete(item.id);
    }
  };

  const onFiles = (files: File[] | FileList | null) => {
    setError('');
    if (!files) return;

    const next = Array.from(files);
    const validItems: UploadItem[] = [];
    let firstValidationError = '';
    for (const file of next) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        firstValidationError ||= '仅支持 jpg、jpeg、png、webp 图片';
        continue;
      }
      if (file.size > MAX_SIZE) {
        firstValidationError ||= '单张图片不能超过 5MB';
        continue;
      }
      validItems.push({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
        uploading: true,
      });
    }

    if (firstValidationError) setError(firstValidationError);
    if (validItems.length) {
      replaceUploads((current) => [...current, ...validItems]);
      validItems.forEach(uploadFile);
    }
  };

  const retryUpload = (id: string) => {
    const item = uploadsRef.current.find((upload) => upload.id === id);
    if (!item) return;
    if (!item.file) {
      setError('当前图片无法重试，请移除后重新选择。');
      return;
    }
    replaceUploads((current) => current.map((upload) => (
      upload.id === id ? { ...upload, uploading: true, error: undefined } : upload
    )));
    uploadFile(item);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .flatMap((item) => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
    if (!imageFiles.length) return;
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    onFiles(imageFiles);
  };

  const submit = async () => {
    if (submittingRef.current) return;
    if (!draftIdentityReadyRef.current) {
      setError('正在恢复反馈草稿，请稍候再提交。');
      return;
    }
    setError('');
    setMessage('');
    const submittedContent = contentRef.current;
    const submittedUploads = [...uploadsRef.current];
    if (!submittedContent.trim()) {
      setError('请输入反馈内容');
      return;
    }
    if (submittedUploads.some((item) => item.uploading)) {
      setError('图片仍在上传，请稍候');
      return;
    }
    if (submittedUploads.some((item) => !item.imageUrl || !item.assetId)) {
      setError('有图片上传失败，请移除或重试后再提交');
      return;
    }

    const imageUrls = submittedUploads.map((item) => item.imageUrl as string);
    const uploadedAssetIds = submittedUploads.map((item) => item.assetId as string);
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: submittedContent,
          imageUrls,
          uploadedAssetIds,
          pageUrl: window.location.href,
          pathname: window.location.pathname,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '提交失败，请稍后重试。');
      const notSaved = Number.isSafeInteger(data.attachments?.notSaved) && data.attachments.notSaved > 0 ? data.attachments.notSaved : 0;
      setMessage(notSaved ? `意见已提交，${notSaved} 项附件未通过核验，未保存。` : '意见已提交');
      const submittedIds = new Set(submittedUploads.map((item) => item.id));
      const submittedPreviewUrls = new Set(submittedUploads.map((item) => item.previewUrl).filter(Boolean));
      const remainingUploads = uploadsRef.current.filter((item) => !submittedIds.has(item.id));
      submittedPreviewUrls.forEach((url) => revokePreviewUrl(url));
      replaceUploads(remainingUploads);
      if (contentRef.current === submittedContent) {
        contentEditedRef.current = false;
        updateContent('');
      }
      // New edits made while this request was pending remain a draft, not submitted.
      if (!contentRef.current && remainingUploads.length === 0) setOpen(false);
    } catch (err) {
      const reason = err instanceof Error ? err.message : '提交失败，请稍后重试。';
      setError(imageUrls.length > 0 ? `截图已上传成功，但反馈提交失败：${reason}` : reason);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const retrySubmitUploadedAssets = () => {
    void submit();
  };

  return (
    <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 60 }}>
      {open && (
        <section ref={panelRef} onPaste={onPaste} style={{
          width: 360,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'min(520px, calc(100dvh - 112px))',
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
              <h2 style={{ margin: 0, fontSize: 18 }}>提意见</h2>
            </div>
            <button type="button" onClick={() => setOpen(false)} disabled={submitting} aria-label="收起反馈" title="收起反馈" style={iconButtonStyle}><X size={16} /></button>
          </div>

          <textarea
            value={content}
            onChange={(event) => {
              contentEditedRef.current = true;
              updateContent(event.target.value);
            }}
            aria-label="意见描述"
            placeholder="哪里不好用，或想怎样改？"
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

          <div style={{ marginTop: 8 }}>
            <button type="button" title="添加截图" aria-label="添加截图" disabled={submitting}
              onClick={() => fileInputRef.current?.click()} style={{ ...iconButtonStyle, width: 36, height: 36, borderRadius: 8 }}><ImagePlus size={18} /></button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={(event) => {
                onFiles(event.target.files);
                event.currentTarget.value = '';
              }}
              style={{ display: 'none' }}
            />
          </div>

          {uploads.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 }}>
              {uploads.map((item) => (
                <div key={item.id} style={{ position: 'relative' }}>
                  <img src={item.previewUrl || item.imageUrl} alt="反馈图片预览" style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 8 }} />
                  <button type="button" onClick={() => removeUpload(item.id)} aria-label="移除图片" title="移除图片" style={{ ...iconButtonStyle, position: 'absolute', top: 4, right: 4 }}><X size={14} /></button>
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

          {error && (
            <div style={{
              marginTop: 12,
              color: '#fca5a5',
              fontSize: 13,
            }}>
              {error}
            </div>
          )}
          {error.startsWith('截图已上传成功，但反馈提交失败') && (
            <button type="button" onClick={retrySubmitUploadedAssets} disabled={submitting} style={{ ...linkButtonStyle, marginTop: 8 }}>
              重新提交意见
            </button>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button type="button" onClick={() => setOpen(false)} disabled={submitting} style={secondaryButtonStyle}>取消</button>
            <button type="button" onClick={submit} disabled={submitting} style={primaryButtonStyle}>
              {submitting ? '提交中' : '提交意见'}
            </button>
          </div>
        </section>
      )}

      {message && <div role="status" style={{ position: 'absolute', bottom: 8, right: 68, padding: '10px 14px',
        background: '#202a24', color: '#b8ebc9', border: '1px solid #4a6654', borderRadius: 8,
        whiteSpace: 'nowrap', fontSize: 13, pointerEvents: 'none' }}>{message}</div>}
      <button
        ref={triggerRef}
        type="button"
        disabled={submitting}
        onClick={() => setOpen((value) => !value)}
        aria-label="提意见"
        title="提意见"
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
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        onMouseEnter={(event) => { event.currentTarget.style.transform = 'scale(1.06)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.transform = 'scale(1)'; }}
      >
        <MessageSquare size={24} />
      </button>
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
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
