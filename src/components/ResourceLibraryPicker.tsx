'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, Grid2X2, ImageIcon, Maximize, Minimize, Music, Play, RotateCcw, Search, Upload, X, ZoomIn, Menu, Trash2 } from 'lucide-react';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import MediaPreview from '@/components/MediaPreview';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { RelativeTime } from '@/components/RelativeTime';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useProductDialog } from '@/components/useProductDialog';
import { readJsonResponse } from '@/lib/http/json-response';
import type { UploadProgressHandler, UploadProgressSnapshot, UploadedAssetPayload } from '@/lib/http/file-upload';
import type { AssetType } from '@/types';
import type { PickerAlbum, PickerItem, PickerResponse, PickerScope } from '@/lib/assets/picker-types';
import type { UploadedAssetSelection, UploadedImagePickerConfirmResult } from '@/components/UploadedImagePicker';
import styles from './ResourceLibraryPicker.module.css';
import type { AvatarReturnTarget } from '@/lib/avatar-random/handoff';
import { isNavItemVisible } from '@/lib/navigation';
import { imageDisplaySource } from '@/lib/media/image-comparison';

export interface ResourceLibraryPickerProps {
  open: boolean;
  imageOnly?: boolean;
  target?: 'image-studio' | 'workspace' | 'assets';
  title?: string;
  confirmLabel?: string;
  purpose?: string;
  initialSource?: 'all' | 'template-image' | 'random-person';
  maxSelection?: number;
  typeLimits?: Partial<Record<AssetType, number>>;
  acceptedTypes?: AssetType[];
  currentCount: number;
  currentAssetIds: string[];
  currentReferenceImageIds?: string[];
  portalContainer?: Element | null;
  onClose: () => void;
  onUploadFile: (file: File, onProgress?: UploadProgressHandler) => Promise<string | UploadedAssetPayload>;
  onConfirm: (ids: string[], assets?: UploadedAssetSelection[]) => Promise<UploadedImagePickerConfirmResult>;
  onConfirmSelection?: (items: PickerItem[]) => Promise<UploadedImagePickerConfirmResult>;
  avatarTarget?: AvatarReturnTarget;
  onAvatarApplied?: () => Promise<void>;
  onAvatarConfirm?: ResourceLibraryPickerProps['onConfirm'];
}
type Preferences = { view: 'library' | 'favorites' | 'recent'; scope: PickerScope; source: string; template: string; type: string; query: string; sort: string; album: string; project: string; scroll: number; pages: number };
const defaults: Preferences = { view: 'library', scope: 'mine', source: 'all', template: '', type: 'all', query: '', sort: 'newest', album: '', project: '', scroll: 0, pages: 1 };
const labels = { image: '图片', video: '视频', audio: '音频' };

function selectionName(item: PickerItem) {
  if (item.generationOrigin?.templateName) return item.generationOrigin.templateName;
  const name = item.fileName.trim();
  const generatedIdentifier = /^(?:(?:image|output|result|seedance|参考图)[-_])?(?:[a-f\d]{24,}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?:\.[a-z\d]+)?$/i;
  return name && !generatedIdentifier.test(name) ? name : item.type === 'image' ? '未命名图片' : `未命名${labels[item.type]}`;
}
const scopes: Array<[PickerScope, string]> = [['mine', '我的素材'], ['project', '项目素材'], ['shared', '共享给我'], ['public', '公共素材']];
function stored<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
function validKeys(input: unknown): string[] { return Array.isArray(input) ? input.filter((key): key is string => typeof key === 'string' && /^(asset|reference_image|video_task):[a-zA-Z0-9_-]+$/.test(key)).slice(0, 60) : []; }
function failure(result: UploadedImagePickerConfirmResult) { return result === false ? '所选素材未能加入，请重试' : result && typeof result === 'object' && !result.success ? result.message || '所选素材未能加入，请重试' : null; }
function durationText(value: number) { return `${Math.floor(value / 60).toString().padStart(2, '0')}:${Math.floor(value % 60).toString().padStart(2, '0')}`; }
function Thumbnail({ item }: { item: PickerItem }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.thumbnailUrl]);
  if (!item.thumbnailUrl || failed || item.type === 'audio') return <span className={styles.placeholder}>{item.type === 'audio' ? <Music size={30} /> : <ImageIcon size={26} />}<small>{item.type === 'audio' ? '音频' : '预览不可用'}</small></span>;
  return <img src={item.thumbnailUrl} alt={item.fileName} loading="lazy" onError={() => setFailed(true)} />;
}

export function ResourceLibraryPicker({ open, imageOnly, target = imageOnly ? 'image-studio' : 'assets', title = '添加参考素材', confirmLabel = '添加到参考区', purpose = 'reference', initialSource = 'all', maxSelection, typeLimits, acceptedTypes, currentCount, currentAssetIds, currentReferenceImageIds = [], portalContainer, onClose, onUploadFile, onConfirm, onConfirmSelection, avatarTarget, onAvatarApplied, onAvatarConfirm }: ResourceLibraryPickerProps) {
  const { user } = useAppSession();
  const { confirm: askConfirm, productDialog } = useProductDialog();
  const [removedItem, setRemovedItem] = useState<Pick<PickerItem,'assetId'|'identity'|'fileName'|'canRemoveFromLibrary'> | null>(null);
  const avatarWindow = useRef<Window|null>(null), avatarTicket = useRef('');
  const returnKey=user&&avatarTarget?`sd2:avatar-return:v1:${user.id}:${avatarTarget.kind}:${avatarTarget.id}:${purpose}`:'';
  const [returnAvailable,setReturnAvailable]=useState(false);
  const avatarCurrent = useRef({avatarTarget,onAvatarApplied,onAvatarConfirm,returnKey,currentAssetIds}); avatarCurrent.current={avatarTarget,onAvatarApplied,onAvatarConfirm,returnKey,currentAssetIds};
  useEffect(()=>{avatarTicket.current='';setReturnAvailable(false);if(returnKey){const ticket=stored<string>(returnKey,'');if(typeof ticket==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(ticket)){avatarTicket.current=ticket;setReturnAvailable(true);}}},[returnKey]);
  useEffect(()=>{setRemovedItem(null);if(!user)return;const saved=stored<Pick<PickerItem,'assetId'|'identity'|'fileName'|'canRemoveFromLibrary'>|null>(`sd2:library-undo:${user.id}`,null);if(saved&&typeof saved.fileName==='string'){const identity=saved.identity??(saved.assetId?`asset:${saved.assetId}`:'');if(typeof identity==='string'&&/^(asset|reference_image|video_task):[a-zA-Z0-9_-]{1,100}$/.test(identity))setRemovedItem({...saved,identity,canRemoveFromLibrary:true});}},[user?.id]);
  useEffect(()=>{
    const receive=async(event:MessageEvent)=>{
      if(event.origin!==location.origin||avatarWindow.current&&event.source!==avatarWindow.current||event.data?.type!=='sd2:avatar-return'||event.data.ticketId!==avatarTicket.current||locked.current||!active.current)return;
      const current=avatarCurrent.current;
      if(!current.avatarTarget)return;
      locked.current=true;setBusy(true);setError('');
      try{
        const receiptKey=`${current.returnKey}:receipt:${avatarTicket.current}`;
        const receipt=stored<{assetId?:string;claimToken?:string}>(receiptKey,{});
        if(receipt.assetId&&receipt.claimToken&&current.currentAssetIds.includes(receipt.assetId)){
          const ack=await fetch('/api/avatar-studio/handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'ack',id:avatarTicket.current,...receipt})});if(!ack.ok)throw new Error('原回填已保存，但确认未完成，请重试确认');
        }else{
          const response=await fetch('/api/avatar-studio/handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'apply',id:avatarTicket.current,signature:current.avatarTarget.sourceSignature})});const data=await readJsonResponse<{error?:string;localDraft?:boolean;assetId?:string;claimToken?:string;applied?:boolean}>(response);if(!response.ok)throw new Error(data.error||'回填未确认');
          if(data.localDraft&&data.assetId&&data.claimToken){
            const metadata=await fetch(`/api/assets/picker?target=image-studio&scope=mine&types=image&keys=asset:${encodeURIComponent(data.assetId)}`);const payload=await readJsonResponse<PickerResponse>(metadata);const item=payload.items.find(i=>i.assetId===data.assetId);if(!metadata.ok||!item)throw new Error('图片暂不可读取，请在我的素材中重新选择');
            if(avatarCurrent.current.avatarTarget?.sourceSignature!==current.avatarTarget.sourceSignature)throw new Error('原页面已修改，未覆盖新编辑');
            if(!current.onAvatarConfirm)throw new Error('原页面不支持安全回填，请手动选择素材');
            localStorage.setItem(receiptKey,JSON.stringify({assetId:data.assetId,claimToken:data.claimToken}));
            const result=await current.onAvatarConfirm([data.assetId],[{id:data.assetId,type:'image',originalUrl:item.originalUrl,thumbnailUrl:item.thumbnailUrl,fileName:item.fileName,width:item.width,height:item.height}]);const problem=failure(result);if(problem)throw new Error(problem);
            const ack=await fetch('/api/avatar-studio/handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'ack',id:avatarTicket.current,assetId:data.assetId,claimToken:data.claimToken})});if(!ack.ok)throw new Error('图片草稿已保存，但返回确认未完成，请重试确认');
          }else {if(avatarCurrent.current.avatarTarget?.sourceSignature!==current.avatarTarget.sourceSignature)throw new Error('原页面已修改，图片已保留，未刷新覆盖新编辑');await current.onAvatarApplied?.();}
        }
        localStorage.removeItem(current.returnKey);setReturnAvailable(false);avatarWindow.current?.postMessage({type:'sd2:avatar-applied',ticketId:avatarTicket.current},location.origin);setNotice('人物图片已添加，没有启动生成。');onClose();}
      catch(e){setError(e instanceof Error?e.message:'回填未确认');}
      finally{locked.current=false;setBusy(false);}
    };
    window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);
  },[onClose,onConfirm]);
  const openAvatar=async()=>{
    if(!avatarTarget||locked.current)return;
    const windowRef=window.open('about:blank','_blank');if(!windowRef){setError('浏览器未打开人物工具，请允许本次新窗口');return;}
    avatarWindow.current=windowRef;locked.current=true;setBusy(true);setError('');
    try{const response=await fetch('/api/avatar-studio/handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'create',target:avatarTarget})});const data=await readJsonResponse<{id?:string;error?:string}>(response);if(!response.ok||!data.id)throw new Error(data.error||'来路保存失败');localStorage.setItem(returnKey,data.id);avatarTicket.current=data.id;setReturnAvailable(true);windowRef.location.href=`/tools/avatar-studio?ticket=${encodeURIComponent(data.id)}`;}
    catch(e){windowRef.close();setError(e instanceof Error?e.message:'人物工具打开失败');}
    finally{locked.current=false;setBusy(false);}
  };
  const typesKey = (imageOnly ? ['image'] : acceptedTypes || ['image', 'video', 'audio']).join(',');
  const types = useMemo(() => typesKey.split(',') as AssetType[], [typesKey]);
  const prefsKey = user ? `sd2:resource-picker:v1:${user.id}:${target}:${purpose}` : '';
  const recentKey = user ? `sd2:resource-recent:v1:${user.id}:${target}` : '';
  const [prefs, setPrefs] = useState<Preferences>(defaults), [ready, setReady] = useState(false), [query, setQuery] = useState('');
  const [templates, setTemplates] = useState<Array<{ id: string; name: string }>>([]);
  const [sessionOwner, setSessionOwner] = useState('');
  const [notice, setNotice] = useState('');
  const imports = useRef(new Map<string, PickerItem>()), importOwner = useRef('');
  const [items, setItems] = useState<PickerItem[]>([]), [albums, setAlbums] = useState<PickerAlbum[]>([]), [selected, setSelected] = useState<PickerItem[]>([]), [preview, setPreview] = useState<PickerItem | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [total, setTotal] = useState(0), [hasMore, setHasMore] = useState(false), [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(false), [navigationOpen, setNavigationOpen] = useState(false), [failedFiles, setFailedFiles] = useState<File[]>([]), [progress, setProgress] = useState<UploadProgressSnapshot | null>(null), [uploadLabel, setUploadLabel] = useState(''), [container, setContainer] = useState<Element | null>(null), [epoch, setEpoch] = useState(0);
  const dialog = useRef<HTMLDivElement>(null), backdrop = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0), session = useRef(0), locked = useRef(false), restoring = useRef(false), restoration = useRef(0);
  const active = useRef(open); active.current = open;
  const close = () => { if (locked.current) { setError('上传或添加尚未结束，请等待完成'); return; } onClose(); };
  useDialogDismiss({ open: open && ready && sessionOwner === prefsKey, dialogRef: dialog, dismissSurfaceRef: backdrop, onDismiss: () => preview ? setPreview(null) : close() });

  useEffect(() => {
    if (!open || !user || !prefsKey) { setReady(false); sequence.current++; session.current++; return; }
    if (importOwner.current !== recentKey) { imports.current.clear(); importOwner.current = recentKey; }
    const raw = stored<Partial<Preferences>>(prefsKey, {}), next = { ...defaults, source: initialSource as string };
    if (['library', 'favorites', 'recent'].includes(raw.view || '')) next.view = raw.view!;
    if (scopes.some(([s]) => s === raw.scope)) next.scope = raw.scope!;
    if (['all', 'uploaded', 'generated', 'other', 'template-image', 'random-person', 'other-generated', 'unknown', 'video-generated'].includes(raw.source || '')) next.source = raw.source!;
    if (raw.type === 'all' || types.includes(raw.type as AssetType)) next.type = raw.type!;
    if (typeof raw.query === 'string') next.query = raw.query.slice(0, 160);
    if (raw.sort === 'name') next.sort = 'name';
    for (const field of ['album', 'project', 'template'] as const) if (typeof raw[field] === 'string' && /^[a-zA-Z0-9_-]{0,100}$/.test(raw[field]!)) next[field] = raw[field]!;
    if (typeof raw.scroll === 'number' && Number.isFinite(raw.scroll)) next.scroll = Math.max(0, raw.scroll);
    if (typeof raw.pages === 'number') next.pages = Math.min(5, Math.max(1, Math.floor(raw.pages) || 1));
    restoration.current = next.scroll; restoring.current = true;
    setPrefs(next); setQuery(next.query); setSelected([]); setItems([]); setAlbums([]); setTemplates([]); setTotal(0); setPreview(null); setFailedFiles([]); setError(''); setNotice(''); setUploadLabel(''); setProgress(null); setSessionOwner(prefsKey);
    const modal = Array.from(document.querySelectorAll('dialog[open]')).reverse().find(d => d.matches(':modal'));
    setContainer(portalContainer || modal || document.body); setReady(true);
    return () => { sequence.current++; session.current++; };
  }, [open, prefsKey, portalContainer, types, user?.id, initialSource]);
  useEffect(() => { if (!ready || sessionOwner !== prefsKey) return; const timer = setTimeout(() => setPrefs(p => p.query === query ? p : { ...p, query, pages: 1, scroll: 0 }), 250); return () => clearTimeout(timer); }, [query, ready, sessionOwner, prefsKey]);
  useEffect(() => { if (ready && prefsKey && sessionOwner === prefsKey) { try { localStorage.setItem(prefsKey, JSON.stringify(prefs)); } catch { /* Storage failure never prevents selection. */ } } }, [prefs, ready, prefsKey, sessionOwner]);
  const fetchPage = useCallback(async (nextPage: number): Promise<PickerResponse> => {
    const params = new URLSearchParams({ scope: prefs.scope, source: prefs.source, types: prefs.type === 'all' ? typesKey : prefs.type, q: prefs.query, view: prefs.view, sort: prefs.sort, target, page: String(nextPage) });
    if (prefs.album) params.set('album', prefs.album); if (prefs.project) params.set('project', prefs.project);
    if (prefs.template && prefs.source === 'template-image') params.set('template', prefs.template);
    if (prefs.view === 'recent') params.set('keys', validKeys(stored(recentKey, [])).join(','));
    const response = await fetch(`/api/assets/picker?${params}`, { cache: 'no-store' });
    const data = await readJsonResponse<PickerResponse & { error?: string }>(response, { invalidJsonMessage: '素材库服务返回了无效内容，请刷新或重新登录' });
    if (!response.ok) throw new Error(data.error || '素材库读取失败'); return data;
  }, [prefs.scope, prefs.source, prefs.template, prefs.type, prefs.query, prefs.view, prefs.sort, prefs.album, prefs.project, typesKey, target, recentKey]);
  useEffect(() => {
    if (!open || !ready || sessionOwner !== prefsKey) return;
    const token = ++sequence.current; setLoading(true); setError('');
    void (async () => {
      try {
        let batch: PickerItem[] = []; const count = restoring.current ? prefs.pages : 1;
        for (let nextPage = 1; nextPage <= count; nextPage++) {
          const data = await fetchPage(nextPage); if (token !== sequence.current) return;
          batch = [...batch, ...data.items]; setAlbums(data.albums); setTemplates(data.templates || []); setTotal(data.total); setPage(data.page); setHasMore(data.hasMore); setNotice(data.notice || '');
          if (prefs.template && !(data.templates || []).some(t => t.id === prefs.template)) { setPrefs(p => ({ ...p, template: '', pages: 1, scroll: 0 })); return; }
          if (prefs.album && !data.albums.some(a => a.id === prefs.album && a.scope === prefs.scope) || prefs.project && !data.albums.some(a => a.project?.id === prefs.project && a.scope === prefs.scope)) {
            restoring.current = false; setPrefs(p => ({ ...p, album: '', project: '', pages: 1, scroll: 0 })); return;
          }
          if (!data.hasMore) break;
        }
        setItems(batch);
      } catch (e) { if (token === sequence.current) setError(e instanceof Error ? e.message : '素材库读取失败'); }
      finally { if (token === sequence.current) setLoading(false); }
    })();
    return () => { sequence.current++; };
  }, [open, ready, sessionOwner, prefsKey, fetchPage, epoch]);
  useEffect(() => { if (loading || !items.length || !restoring.current) return; body.current?.scrollTo({ top: restoration.current }); restoring.current = false; }, [items, loading]);

  const currentIds = new Set(currentAssetIds), currentRefs = new Set(currentReferenceImageIds);
  const existing = (item: PickerItem) => Boolean(item.assetId && currentIds.has(item.assetId) || item.referenceImageId && currentRefs.has(item.referenceImageId) || imports.current.get(item.identity)?.assetId && currentIds.has(imports.current.get(item.identity)!.assetId!));
  const canSelect = (next: PickerItem[]) => {
    if (maxSelection !== undefined && next.length > maxSelection) return `本次还可添加 ${maxSelection} 个素材`;
    for (const type of types) if (typeLimits?.[type] !== undefined && next.filter(i => i.type === type).length > typeLimits[type]!) return `${labels[type]}还可添加 ${typeLimits[type]} 个`;
    if (next.some(i => !types.includes(i.type))) return '当前用途不接收这种素材'; return '';
  };
  const toggle = (item: PickerItem) => {
    if (busy || existing(item) || item.unavailableReason) return;
    const next = selected.some(s => s.identity === item.identity) ? selected.filter(s => s.identity !== item.identity) : [...selected, item];
    const issue = canSelect(next); if (issue) { setError(issue); return; } setSelected(next); setError('');
  };
  const change = (patch: Partial<Preferences>) => { restoring.current = false; body.current?.scrollTo({ top: 0 }); setPrefs(p => ({ ...p, ...patch, scroll: 0, pages: 1 })); };
  const removeItem = async (item: Pick<PickerItem,'assetId'|'identity'|'fileName'|'canRemoveFromLibrary'>, restore = false) => {
    if (!item.canRemoveFromLibrary || !/^(asset|reference_image|video_task):[a-zA-Z0-9_-]{1,100}$/.test(item.identity) || locked.current) return;
    if (!restore && !(await askConfirm(`从我的素材库删除“${item.fileName}”？可以撤销。底层文件、已经添加到任务或图集的引用、已共享内容仍保留；这不是彻底删除。`, { title: '删除素材', confirmLabel: '从我的素材库删除', danger: true }))) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/assets/library/removal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: item.identity, assetId: item.assetId, removed: !restore }) });
      const data = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(data.error || '操作未确认');
      if (!restore) { setItems(old => old.filter(i => i.identity !== item.identity)); setSelected(old => old.filter(i => i.identity !== item.identity)); imports.current.delete(item.identity); }
      setRemovedItem(restore ? null : item);if(user){try{if(restore)localStorage.removeItem(`sd2:library-undo:${user.id}`);else localStorage.setItem(`sd2:library-undo:${user.id}`,JSON.stringify({assetId:item.assetId,identity:item.identity,fileName:item.fileName,canRemoveFromLibrary:true}));}catch{setNotice('删除已确认；本机无法记住撤销入口，请在关闭窗口前撤销。');}} setEpoch(v => v + 1);
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { locked.current = false; setBusy(false); }
  };
  const loadMore = async () => {
    if (loading) return; const token = sequence.current; setLoading(true);
    try { const data = await fetchPage(page + 1); if (token !== sequence.current) return; setItems(old => [...old, ...data.items.filter(i => !old.some(o => o.identity === i.identity))]); setPage(data.page); setHasMore(data.hasMore); setPrefs(p => ({ ...p, pages: data.page })); }
    catch (e) { if (token === sequence.current) setError(e instanceof Error ? e.message : '读取失败'); }
    finally { if (token === sequence.current) setLoading(false); }
  };
  const upload = async (files: File[]) => {
    if (locked.current || !files.length) return;
    const kinds = files.map(f => f.type.split('/')[0] as AssetType);
    if (kinds.some(t => !types.includes(t))) { setError(`请选择${types.map(t => labels[t]).join('、')}文件`); return; }
    const issue = canSelect([...selected, ...kinds.map((type, index) => ({ type, identity: `upload:${index}` } as PickerItem))]); if (issue) { setError(issue); return; }
    locked.current = true; setBusy(true); setError(''); setFailedFiles([]); const token = session.current;
    const uploaded: PickerItem[] = [], failed: File[] = []; let detail = '';
    for (let index = 0; index < files.length; index++) {
      const file = files[index]; setUploadLabel(`${index + 1}/${files.length} ${file.name}`); setProgress(null);
      let uploadedId: string | undefined;
      try {
        const result = await onUploadFile(file, p => { if (token === session.current) setProgress(p); });
        if (token !== session.current) break;
        const id = typeof result === 'string' ? result : result.id; uploadedId = id;
        if (!id) throw new Error('上传结果缺少素材编号');
        // Keep uploaded IDs even when metadata retrieval fails, so a retry never retransmits them.
        const fallback: PickerItem = { key: `asset:${id}`, identity: `asset:${id}`, assetId: id, id, type: kinds[index], originalUrl: typeof result === 'string' ? '' : result.originalUrl || '', thumbnailUrl: typeof result === 'string' ? null : result.thumbnailUrl || null, fileName: file.name, width: typeof result === 'string' ? null : result.width || null, height: typeof result === 'string' ? null : result.height || null, duration: null, createdAt: new Date().toISOString(), source: 'uploaded' };
        uploaded.push(fallback);
        const response = await fetch(`/api/assets/picker?target=${target}&keys=${encodeURIComponent(`asset:${id}`)}&types=${typesKey}`, { cache: 'no-store' });
        const data = await readJsonResponse<PickerResponse>(response, { invalidJsonMessage: '文件已上传，素材信息读取失败；请重新读取，不必重传' });
        const item = response.ok ? data.items.find(i => i.assetId === id) : undefined;
        if (item) uploaded[uploaded.length - 1] = item; else detail = '文件已上传，素材信息暂时不可用；添加时会重新核对';
      } catch (e) { if (!uploadedId) failed.push(file); detail = e instanceof Error ? e.message : '上传失败'; }
    }
    if (token === session.current) {
      setSelected(old => [...old, ...uploaded.filter(i => !existing(i) && !old.some(o => o.identity === i.identity))]);
      change({ view: 'library', scope: 'mine', source: 'all', type: 'all', album: '', project: '', query: '' }); setQuery(''); setEpoch(e => e + 1);
      setFailedFiles(failed); setError(detail); setProgress(null); setUploadLabel(''); setBusy(false);
    }
    if (token !== session.current) setBusy(false);
    locked.current = false;
  };
  const confirm = async () => {
    if (locked.current || !selected.length) return;
    const issue = canSelect(selected); if (issue) { setError(issue); return; }
    locked.current = true; setBusy(true); setError('');
    const confirmationSession = session.current;
    try {
      const validated: PickerItem[] = [];
      for (const scope of scopes.map(([s]) => s)) {
        const params = new URLSearchParams({ target, scope, types: typesKey, keys: selected.map(i => i.referenceImageId ? `reference_image:${i.referenceImageId}` : i.key).join(',') });
        for (let p = 1; ; p++) {
          params.set('page', String(p)); const response = await fetch(`/api/assets/picker?${params}`, { cache: 'no-store' });
          const data = await readJsonResponse<PickerResponse>(response, { invalidJsonMessage: '素材权限核对失败，请重试' });
          if (!response.ok) throw new Error('素材权限核对失败，请重试'); validated.push(...data.items); if (!data.hasMore) break;
        }
      }
      const ordered = selected.map(i => validated.find(v => v.identity === i.identity && (!i.referenceImageId || v.referenceImageId === i.referenceImageId)));
      if (ordered.some(i => !i)) throw new Error('部分素材已失效或无权使用，请移除后重试');
      const readyItems = ordered as PickerItem[];
      if (readyItems.some(item => item.unavailableReason)) throw new Error('部分素材暂不能用于此处，请移除后重试');
      if (!active.current || confirmationSession !== session.current) return;
      const attachedItems: PickerItem[] = [];
      for (const item of readyItems) {
        if (!item.importUrl) { attachedItems.push(item); continue; }
        const cached = imports.current.get(item.identity);
        if (cached) {
          const response = await fetch(`/api/assets/picker?target=${target}&keys=${encodeURIComponent(cached.key)}&types=${item.type}`, { cache: 'no-store' });
          const data = await readJsonResponse<PickerResponse>(response, { invalidJsonMessage: '素材已导入，信息读取失败；请重试添加，不必重传' });
          if (!active.current || confirmationSession !== session.current) return;
          const owned = response.ok ? data.items.find(i => i.assetId === cached.assetId) : undefined;
          if (!owned) throw new Error('已导入素材暂不可用，请重新读取后重试');
          imports.current.set(item.identity, owned); attachedItems.push(owned); continue;
        }
        // Only existing authorized original/download endpoints are used; preview URLs are never copied.
        setUploadLabel(`准备添加 ${item.fileName}`);
        const response = await fetch(item.importUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error('原素材不可下载或权限已变化，请重试');
        const blob = await response.blob();
        if (!blob.size || !blob.type.startsWith(`${item.type}/`)) throw new Error('原素材文件不可用，请重试');
        if (!active.current || confirmationSession !== session.current) return;
        const result = await onUploadFile(new File([blob], item.fileName, { type: blob.type }), p => setProgress(p));
        const id = typeof result === 'string' ? result : result.id;
        if (!id) throw new Error('素材导入结果缺少编号');
        if (!active.current || confirmationSession !== session.current) return;
        const fallback: PickerItem = { ...item, id, assetId: id, referenceImageId: undefined, importUrl: undefined, key: `asset:${id}`, identity: `asset:${id}`, originalUrl: typeof result === 'string' ? '' : result.originalUrl || '' };
        imports.current.set(item.identity, fallback);
        const metadataResponse = await fetch(`/api/assets/picker?target=${target}&keys=${encodeURIComponent(`asset:${id}`)}&types=${item.type}`, { cache: 'no-store' });
        const metadata = await readJsonResponse<PickerResponse>(metadataResponse, { invalidJsonMessage: '素材已导入，信息读取失败；请重试添加，不必重传' });
        if (!active.current || confirmationSession !== session.current) return;
        const owned = metadataResponse.ok ? metadata.items.find(i => i.assetId === id) : undefined;
        const imported = owned || fallback;
        imports.current.set(item.identity, imported); attachedItems.push(imported);
        if (!owned) throw new Error('素材已导入，信息暂不可用；请重试添加，不必重传');
      }
      if (!active.current || confirmationSession !== session.current) return;
      const uniqueItems = attachedItems.filter((item, index, all) => all.findIndex(other => other.identity === item.identity) === index);
      const result = onConfirmSelection ? await onConfirmSelection(uniqueItems) : await onConfirm(uniqueItems.map(i => i.id), uniqueItems);
      const message = failure(result); if (message) throw new Error(message);
      if (active.current && confirmationSession === session.current) for (const item of uniqueItems.filter(item => item.type === 'image')) {
        const descriptor = imageDisplaySource(item.originalUrl, 'hd-description');
        if (descriptor === item.originalUrl) continue;
        const url = new URL(descriptor, location.origin); url.searchParams.set('hd-priority', 'recent');
        void fetch(url, { credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
      }
      if (recentKey) { try { localStorage.setItem(recentKey, JSON.stringify([...readyItems.map(i => i.key), ...validKeys(stored(recentKey, []))].filter((k, i, all) => all.indexOf(k) === i).slice(0, 60))); } catch { /* Local recent history is not cloud sync. */ } }
      if (active.current && confirmationSession === session.current) onClose();
    } catch (e) { if (confirmationSession === session.current) setError(e instanceof Error ? e.message : '添加失败，请重试'); }
    finally { locked.current = false; setBusy(false); setUploadLabel(''); setProgress(null); }
  };

  if (!open || !ready || !container || sessionOwner !== prefsKey) return null;
  const scopedAlbums = albums.filter(a => a.scope === prefs.scope), projects = Array.from(new Map(scopedAlbums.flatMap(a => a.project ? [[a.project.id, a.project] as const] : [])).values());
  const selectedCounts = { image: selected.filter(i => i.type === 'image').length, video: selected.filter(i => i.type === 'video').length, audio: selected.filter(i => i.type === 'audio').length };
  const availableScopes = scopes.filter(([s]) => s === 'mine' || albums.some(a => a.scope === s));
  return createPortal(<div ref={backdrop} className={styles.backdrop}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} className={`${styles.dialog} ${expanded ? styles.expanded : ''}`}
      onDragOver={e => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); void upload(Array.from(e.dataTransfer.files)); }}
      onPaste={e => { const files = Array.from(e.clipboardData.items).filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter((f): f is File => !!f); if (files.length) { e.preventDefault(); e.stopPropagation(); void upload(files); } }}>
      <header className={styles.header}><h2>{title}</h2><div className={styles.commands}>
        {avatarTarget && types.includes('image') && isNavItemVisible({label:'人物生成',href:'/tools/avatar-studio',imageStudioOnly:true},user) && <button type="button" disabled={busy||avatarTarget.capacity<1} onClick={()=>void openAvatar()}><ImageIcon size={18}/><span>生成人物</span></button>}
        {returnAvailable&&avatarTarget&&<button type="button" disabled={busy} onClick={()=>{avatarWindow.current=window.open(`/tools/avatar-studio?ticket=${encodeURIComponent(avatarTicket.current)}`,'_blank');}}>继续上次人物回填</button>}
        <button type="button" title={expanded ? '收起窗口' : '展开窗口'} aria-label={expanded ? '收起窗口' : '展开窗口'} onClick={() => setExpanded(v => !v)}>{expanded ? <Minimize size={18} /> : <Maximize size={18} />}</button>
        <button type="button" aria-label="关闭素材库" title="关闭素材库" onClick={close}><X size={20} /></button>
      </div></header>
      <input hidden ref={input} type="file" accept={types.map(t => `${t}/*`).join(',')} multiple={maxSelection !== 1} onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; void upload(files); }} />
      <div className={styles.topbar}><nav className={styles.tabs} aria-label="浏览素材">{([['library', '素材库'], ['favorites', '我的喜欢'], ['recent', '最近使用']] as const).map(([view, label]) => <button key={view} type="button" aria-pressed={prefs.view === view} onClick={() => change({ view })}>{label}</button>)}</nav><label className={styles.search}><Search size={18} /><input type="search" aria-label="搜索素材名称、图集" placeholder="搜索素材名称、图集" value={query} maxLength={160} onChange={e => setQuery(e.target.value)} /></label></div>
      <div className={styles.layout}><aside className={`${styles.sidebar} ${navigationOpen ? styles.navigationOpen : ''}`} aria-label="图集和项目">
        <label className={`${styles.scopeControl} ${styles.sidebarScope}`}><span>素材范围</span><select aria-label="素材范围" value={prefs.scope} onChange={e => change({ scope: e.target.value as PickerScope, album: '', project: '' })}>{availableScopes.map(([s, label]) => <option key={s} value={s}>{label}</option>)}{!availableScopes.some(([s]) => s === prefs.scope) && <option value={prefs.scope}>此范围已不可用</option>}</select></label>
        <button type="button" className={!prefs.album && !prefs.project ? styles.active : ''} onClick={() => { change({ album: '', project: '' }); setNavigationOpen(false); }}><Grid2X2 size={18} />全部素材</button>
        {!!scopedAlbums.length && <h3>图集</h3>}{scopedAlbums.map(a => <button key={a.id} type="button" title={a.name} className={prefs.album === a.id ? styles.active : ''} onClick={() => { change({ album: a.id, project: '' }); setNavigationOpen(false); }}><Folder size={17} /><span>{a.name}</span></button>)}
        {!!projects.length && <h3>项目素材</h3>}{projects.map(p => <button key={p.id} type="button" className={prefs.project === p.id ? styles.active : ''} onClick={() => { change({ project: p.id, album: '' }); setNavigationOpen(false); }}><Folder size={17} /><span>{p.name}</span></button>)}
      </aside><section className={styles.main}>
        <div className={styles.filters}><button type="button" className={styles.mobileNavigation} aria-expanded={navigationOpen} onClick={() => setNavigationOpen(v => !v)}><Menu size={17} />图集／项目</button>
          <label className={`${styles.scopeControl} ${styles.mobileScope}`}><span>范围</span><select aria-label="素材范围" value={prefs.scope} onChange={e => change({ scope: e.target.value as PickerScope, album: '', project: '' })}>{availableScopes.map(([s, label]) => <option key={s} value={s}>{label}</option>)}{!availableScopes.some(([s]) => s === prefs.scope) && <option value={prefs.scope}>此范围已不可用</option>}</select></label>
          {types.length > 1 && <div className={`${styles.segments} ${styles.typeSegments}`} aria-label="素材类型">{['all', ...types].map(t => <button key={t} type="button" aria-pressed={prefs.type === t} onClick={() => change({ type: t })}>{t === 'all' ? '全部' : labels[t as AssetType]}</button>)}</div>}
          <label className={styles.sortControl}><span>来源</span><select aria-label="素材来源" value={prefs.source} onChange={e => change({ source: e.target.value, template: '' })}><option value="all">全部来源</option><option value="uploaded">上传的</option><option value="generated">全部生成</option>{types.includes('image') && <><option value="template-image">模板生图</option><option value="random-person">随机人物</option><option value="other-generated">其他生成</option><option value="unknown">来源待识别</option></>}{types.includes('video') && <option value="video-generated">视频生成</option>}<option value="other">其他素材</option></select></label>
          {prefs.source === 'template-image' && <label className={styles.sortControl}><span>模板</span><select aria-label="具体模板" value={prefs.template} onChange={e => change({ template: e.target.value })}><option value="">全部模板</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
          <label className={styles.sortControl}><span>排序</span><select aria-label="排序" value={prefs.sort} onChange={e => change({ sort: e.target.value })}><option value="newest">最新添加</option><option value="name">名称</option></select></label>
          <button type="button" className={styles.resetFilter} title="重置筛选和浏览位置" aria-label="重置筛选和浏览位置" onClick={() => { setQuery(''); change(defaults); }}><RotateCcw size={16} /></button>
        </div>
        {uploadLabel && <UploadProgressIndicator busy label={progress?.label || '准备上传'} detail={uploadLabel} percent={progress?.percent} />}
        {notice && <div role="status" className={styles.notice}>{notice}</div>}
        {removedItem && <div role="status" className={styles.notice}>已从我的素材库删除，文件和已有引用保留。<button type="button" disabled={busy} onClick={() => void removeItem(removedItem, true)}>撤销删除</button></div>}
        {error && <div role="alert" className={styles.error}>{error}<button type="button" disabled={busy} onClick={() => setEpoch(v => v + 1)}>重新读取</button></div>}
        {!!failedFiles.length && <div className={styles.error}>{failedFiles.map(f => f.name).join('、')}<button type="button" disabled={busy} onClick={() => void upload(failedFiles)}>重试失败文件</button></div>}
        <div ref={body} className={styles.body} aria-busy={loading} onScroll={e => { const scroll = e.currentTarget.scrollTop; if (!restoring.current) setPrefs(p => ({ ...p, scroll })); }} onWheel={() => { restoring.current = false; }} onTouchStart={() => { restoring.current = false; }}>
          <div className={styles.grid}>{items.map(item => { const order = selected.findIndex(s => s.identity === item.identity), inUse = existing(item); return <article key={item.identity} className={`${styles.card} ${order >= 0 ? styles.selected : ''}`}>
            <div className={styles.cover} data-reaction-surface>
            <button type="button" className={styles.selectCard} disabled={busy || inUse || !!item.unavailableReason} aria-pressed={order >= 0} aria-label={`${order >= 0 ? '取消选择' : '选择'}${selectionName(item)}`} title={item.unavailableReason} onClick={() => toggle(item)}><Thumbnail item={item} />{order >= 0 && <span className={styles.order}>{order + 1}</span>}{inUse && <span className={styles.inUse}>已添加</span>}</button>
            {item.canRemoveFromLibrary && <button type="button" className={styles.removeButton} title="从我的素材库删除" aria-label={`从我的素材库删除：${selectionName(item)}`} disabled={busy} onClick={() => void removeItem(item)}><Trash2 size={17} /></button>}
            <button type="button" className={styles.preview} title={item.type === 'image' ? '放大图片' : `播放${labels[item.type]}`} aria-label={`${item.type === 'image' ? '放大' : '播放'}${item.fileName}`} onClick={() => setPreview(item)}>{item.type === 'image' ? <ZoomIn size={17} /> : <Play size={20} fill="currentColor" />}</button>
            {item.type !== 'image' && <span className={styles.duration}>{item.duration != null ? durationText(item.duration) : '时长未知'}</span>}
            <ContentReactions contentKey={item.key} overlay imageSharing={false} onChange={() => { if (prefs.view === 'favorites') setEpoch(v => v + 1); }} />
            </div>
            <div className={styles.meta}><strong>{selectionName(item)}</strong>{item.unavailableReason && <small className={styles.compatibility}>{item.unavailableReason}</small>}
              <small>{item.generationOrigin ? `${item.generationOrigin.label}${item.generationOrigin.templateName ? ` · ${item.generationOrigin.templateName}` : ''}` : item.source === 'uploaded' ? '上传的' : '其他素材'}</small>
              <details className={styles.cardDetails}><summary>详情</summary><small className={styles.originalName}>{item.fileName}</small><small>{item.source === 'generated' ? '生成' : item.source === 'uploaded' ? '上传' : '图集'}{item.width && item.height ? ` · ${item.width} × ${item.height}` : ''} · <RelativeTime value={item.createdAt} /></small></details>
            </div>
          </article>; })}</div>
          {loading && <div className={styles.empty} role="status">正在读取素材</div>}{!loading && !items.length && <div className={styles.empty}>{prefs.view === 'recent' ? '本机还没有符合筛选的最近选用素材' : '没有符合筛选的可用素材'}</div>}
          <div className={styles.more}><span>{total} 个素材</span>{hasMore && <button type="button" disabled={loading} onClick={() => void loadMore()}>加载更多</button>}</div>
        </div>
      </section></div>
      <footer className={styles.footer}><button type="button" className={styles.uploadAction} disabled={busy || maxSelection === 0} onClick={() => input.current?.click()}><Upload size={18} /><span>上传素材</span></button><div className={styles.count}><strong>已选 {selected.length} 个</strong><small>{types.map(t => `${labels[t]} ${selectedCounts[t]}${typeLimits?.[t] !== undefined ? ` · 剩余 ${Math.max(0, typeLimits[t]! - selectedCounts[t])}` : ''}`).join(' / ')}{maxSelection !== undefined ? ` · 本次剩余 ${Math.max(0, maxSelection - selected.length)}` : ''} · 当前已添加 {currentCount}</small></div>
        <div className={styles.selection}>{selected.map((item, index) => <div key={item.identity} className={styles.selectedThumb} title={item.fileName}><Thumbnail item={item} /><span>{index + 1}</span><button type="button" disabled={busy} aria-label={`移除${item.fileName}`} onClick={() => toggle(item)}><X size={13} /></button></div>)}</div>
        <div className={styles.footerActions}><button type="button" disabled={busy} onClick={close}>取消</button><button type="button" className={styles.primary} disabled={busy || !selected.length || !!canSelect(selected)} onClick={() => void confirm()}>{busy && !uploadLabel ? '正在添加' : confirmLabel}</button></div>
      </footer>
    </div>
    {preview && (preview.type === 'image' ? <ZoomableImagePreview contentKey={preview.key} src={preview.previewUrl || preview.originalUrl} thumbnailSrc={preview.thumbnailUrl || undefined} alt={selectionName(preview)} fileName={preview.fileName} safeDetails={{ width: preview.width || undefined, height: preview.height || undefined, fileSize: preview.fileSize ?? undefined }} onClose={() => setPreview(null)} /> : <MediaPreview contentKey={preview.key} src={preview.previewUrl || preview.originalUrl} type={preview.type} title={preview.fileName} poster={preview.thumbnailUrl || undefined} onClose={() => setPreview(null)} />)}
    {productDialog}
  </div>, container);
}
