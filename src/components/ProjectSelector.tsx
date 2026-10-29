'use client';

import { useEffect, useId, useRef, useState, type SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { PROJECT_CATALOG_CHANGED, readProjectSelectorCatalog, useProjectCatalogRevision, type ProjectCatalogChange, type ProjectSelectorRecord } from '@/lib/projects/selector-client';
import { ProductActionMenu } from './ProductActionMenu';
import { ProjectManagementDialog, type ProjectManagementRequest } from './ProjectManagementDialog';
import { useDialogDismiss } from './useDialogDismiss';
import styles from './ProjectSelector.module.css';

type Option = { value: string; label: string; disabled: boolean; group: string; projectId: string | null };
/** Original options remain authoritative for each selection's purpose and permissions. */
export function ProjectSelector({ children, className, style, value, disabled, title, id: suppliedId, onCatalogChange, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { onCatalogChange?: () => void }) {
  const { user, sessionChanged } = useAppSession();
  const ownerId = user?.id || '', revision = useProjectCatalogRevision(ownerId);
  const native = useRef<HTMLSelectElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const generatedId = useId(), id = suppliedId || generatedId;
  const [options, setOptions] = useState<Option[]>([]), [open, setOpen] = useState(false), [search, setSearch] = useState('');
  const [recovery, setRecovery] = useState<Array<{projectId:string;name:string;mode:'edit'|'delete'|'archive'}>>([]), [createRecovery, setCreateRecovery] = useState(false);
  const [catalog, setCatalog] = useState<ProjectSelectorRecord[]>([]), [canCreate, setCanCreate] = useState(false), [catalogLoading, setCatalogLoading] = useState(false), [notice, setNotice] = useState('');
  const [position, setPosition] = useState<{left:number;top:number;width:number;maxHeight:number} | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null), [management, setManagement] = useState<ProjectManagementRequest | null>(null);
  const catalogCallback = useRef(onCatalogChange); catalogCallback.current = onCatalogChange;
  useEffect(() => {
    const refresh = (event: Event) => { const detail = (event as CustomEvent<ProjectCatalogChange>).detail; if (detail?.ownerId === ownerId && !sessionChanged) catalogCallback.current?.(); };
    window.addEventListener(PROJECT_CATALOG_CHANGED, refresh); return () => window.removeEventListener(PROJECT_CATALOG_CHANGED, refresh);
  }, [ownerId, sessionChanged]);
  const selected = value == null ? '' : String(value), selectedOption = options.find(option=>option.value === selected);
  const unavailable = Boolean(selected && !selectedOption);
  useEffect(() => {
    const element = native.current; if (!element) return;
    const refresh = () => {
      const next = Array.from(element.options).filter(option=>!option.dataset.projectPreserved).map(option=>{
        const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
        const candidate = option.value.startsWith('project:') ? option.value.slice(8) : option.value;
        const projectId = !candidate || ['all','unassigned','none','personal','__none__','__all__'].includes(candidate) || option.value.startsWith('album:') ? null : candidate;
        return { value:option.value,label:option.label,disabled:option.disabled || Boolean(group?.disabled),group:group?.label || '',projectId };
      });
      setOptions(old=>JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    refresh(); const observer = new MutationObserver(refresh); observer.observe(element,{childList:true,subtree:true,attributes:true,characterData:true});
    return ()=>observer.disconnect();
  }, [children]);
  useEffect(()=>{ setOpen(false); setManagement(null); setCatalog([]); setCanCreate(false); setCatalogLoading(false); },[ownerId,sessionChanged]);
  useEffect(()=>{ if (disabled) setOpen(false); },[disabled]);
  useEffect(()=>{
    if (!open || !ownerId || sessionChanged) return;
    let cancelled=false; setNotice(''); setCatalogLoading(true);
    try {
      const prefix=`sd2:project-selector-mutation:v1:${ownerId}:`, createPrefix=`sd2-project-create:v1:${ownerId}:project-selector`;
      const originals:Array<{projectId:string;name:string;mode:'edit'|'delete'|'archive'}>=[];let creating=false;
      for(let index=0;index<localStorage.length;index++) {
        const key=localStorage.key(index);if(!key)continue;
        if(key===createPrefix || key.startsWith(`${createPrefix}:`))creating=true;
        if(!key.startsWith(prefix))continue;
        const original=JSON.parse(localStorage.getItem(key) || 'null');
        if(original?.ownerId===ownerId && key===prefix+original.projectId && /^[A-Za-z0-9_-]{1,120}$/.test(original.projectId)
          && ['edit','delete','archive'].includes(original.mode) && typeof original.name==='string') originals.push(original);
      }
      setRecovery(originals);setCreateRecovery(creating);
    } catch { setNotice('原项目操作记录暂不可读取，可继续选择项目；没有再次提交。'); }
    void readProjectSelectorCatalog(ownerId).then(result=>{if(!cancelled){setCatalog(result.projects);setCanCreate(result.capabilities?.can_create_team_project === true && result.capabilities?.create_operation_version === 1);}})
      .catch(cause=>{if(!cancelled){setCatalog([]);setCanCreate(false);setNotice(cause.message);}})
      .finally(()=>{if(!cancelled)setCatalogLoading(false);});
    return ()=>{cancelled=true;};
  },[open,ownerId,sessionChanged,revision]);
  useDialogDismiss({open,dialogRef:panel,layerSurfaceRef:panel,branchRefs:[trigger],modal:false,initialFocusRef:searchInput,onDismiss:()=>setOpen(false)});
  useEffect(()=>{
    if(!open) return;
    const place=()=>{
      if(!trigger.current || !panel.current) return;
      const anchor=trigger.current.getBoundingClientRect(),rect=panel.current.getBoundingClientRect(),viewport=window.visualViewport;
      const left=viewport?.offsetLeft || 0,top=viewport?.offsetTop || 0,right=left+(viewport?.width || innerWidth),bottom=top+(viewport?.height || innerHeight);
      const width=Math.min(Math.max(240,anchor.width),right-left-16),maxHeight=Math.max(0,Math.min(460,bottom-top-16)),height=Math.min(rect.height,maxHeight);
      setPosition({left:Math.max(left+8,Math.min(anchor.left,right-width-8)),top:anchor.bottom+height+5<=bottom-8 ? anchor.bottom+5 : Math.max(top+8,anchor.top-height-5),width,maxHeight});
    };
    place(); const raf=requestAnimationFrame(()=>{place();(searchInput.current || panel.current?.querySelector<HTMLButtonElement>('button[data-project-choice][aria-pressed="true"]:not(:disabled)') || panel.current?.querySelector<HTMLButtonElement>('button[data-project-choice]:not(:disabled)') || panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();});
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);window.visualViewport?.addEventListener('resize',place);
    return ()=>{cancelAnimationFrame(raf);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);window.visualViewport?.removeEventListener('resize',place);};
  },[open,options.length,notice,search,recovery.length,createRecovery]);
  function toggle(){ setHost(trigger.current?.closest('dialog[open]') as HTMLElement || document.body);setSearch('');setPosition(null);if(!open)setCatalogLoading(true);setOpen(previous=>!previous); }
  function choose(option:Option){
    if(disabled || option.disabled || !native.current) return;
    setOpen(false); if(option.value === selected) return;
    native.current.value=option.value;
    native.current.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function manage(request:ProjectManagementRequest){setOpen(false);setManagement(request);}
  const visible=options.filter(option=>!search || option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const name=props['aria-label'] || title || '项目';
  return <span className={`${styles.root} ${className || ''}`} style={style}>
    <select {...props} id={suppliedId ? `${suppliedId}-native` : undefined} ref={native} value={value} disabled={disabled} tabIndex={-1} aria-hidden="true" className={styles.native}>
      {children}{unavailable && <option data-project-preserved="true" value={selected}>{selected}（当前不可选）</option>}
    </select>
    <button ref={trigger} id={id} type="button" className={styles.trigger} disabled={disabled} title={title} aria-label={props['aria-label']} aria-labelledby={props['aria-labelledby']}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open?`${id}-choices`:undefined} onClick={toggle}
      onKeyDown={event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(!open)toggle();}}}>
      <span>{selectedOption?.label || (selected ? `${selected}（当前不可选）` : options[0]?.label || '选择项目')}</span><ChevronDown size={14}/>
    </button>
    {open && host && createPortal(<div ref={panel} id={`${id}-choices`} role="dialog" aria-label={`${name}选择与管理`} className={styles.popover}
      style={position || {left:0,top:0,visibility:'hidden'}} onKeyDown={event=>{
        if(event.target instanceof HTMLInputElement || !['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
        event.preventDefault();const items=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button[data-project-choice]:not(:disabled)') || []),index=items.indexOf(document.activeElement as HTMLButtonElement);
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
      }}>
      <div className={styles.header}><span>选择项目</span><button type="button" className={styles.create}
        disabled={!ownerId || sessionChanged || catalogLoading || !canCreate}
        title={!ownerId ? '请先登录' : catalogLoading ? '正在确认项目权限' : !canCreate ? notice || '当前账号没有新建项目权限' : '新建项目'}
        onClick={()=>manage({mode:'create'})}><Plus size={15}/><span>新建项目</span></button></div>
      {options.length>7 && <input ref={searchInput} type="search" className={styles.search} value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索项目" aria-label="搜索项目"/>}
      {unavailable && <p className={styles.notice} role="status">当前项目不可选，原选择和草稿已保留。</p>}
      <div className={styles.list}>{visible.map((option,index)=>{
        const project=option.projectId ? catalog.find(item=>item.id===option.projectId) : undefined;
        return <div key={`${option.value}:${index}`}>{option.group && visible[index-1]?.group!==option.group && <div className={styles.group}>{option.group}</div>}
          <div className={styles.row}><button type="button" data-project-choice className={styles.option} disabled={option.disabled} aria-pressed={selected===option.value} onClick={()=>choose(option)}><span>{option.label}</span>{selected===option.value && <Check size={14}/>}</button>
            {project?.can_manage_project && <ProductActionMenu label={`管理项目：${option.label}`} portalTarget={host} actions={[
              {id:'edit',label:'编辑项目',icon:<Pencil size={14}/>,onSelect:()=>manage({mode:'edit',projectId:project.id})},
              ...(['personal','system'].includes(project.type) ? [] : [{id:'delete',label:'删除项目',icon:<Trash2 size={14}/>,danger:true,onSelect:()=>manage({mode:'delete',projectId:project.id})}]),
            ]}/>}</div></div>;
      })}{!visible.length && <p className={styles.notice}>{search?'没有匹配项目':'暂无可选项目'}</p>}
      {(recovery.length>0 || createRecovery) && <div className={styles.footer}>
        {createRecovery && <button type="button" className={styles.option} onClick={()=>manage({mode:'create'})}>核对原项目创建</button>}
        {recovery.map(original=><button key={original.projectId} type="button" className={styles.option}
          onClick={()=>manage({mode:original.mode,projectId:original.projectId})}><span>核对原{original.mode==='delete'?'删除':original.mode==='archive'?'归档':'保存'}：{original.name || original.projectId}</span></button>)}
      </div>}
      </div>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
    </div>,host)}
    {management && ownerId && <ProjectManagementDialog key={`${ownerId}:${management.mode}:${management.projectId || ''}`} request={management} portalTarget={host} onClose={()=>{setManagement(null);trigger.current?.focus();}}/>}
  </span>;
}
