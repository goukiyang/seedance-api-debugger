'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { isNavItemVisible } from '@/lib/navigation';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import type { AccountMenuUser } from './AccountMenu';
export default function ToolsMenu({ user }: { user?: AccountMenuUser | null }) {
  const [open, setOpen] = useState(false), menu = useRef<HTMLDivElement>(null);
  const items = [{ label: '人物生成', href: '/tools/avatar-studio', imageStudioOnly: true }, { label: 'AI 抠图', href: '/cutout', adminOnly: true }].filter(i=>isNavItemVisible(i,user));
  useDialogDismiss({ open, dialogRef: menu, modal:false, onDismiss: ()=>setOpen(false) });
  if (!items.length) return null;
  return <div ref={menu} style={{position:'relative'}}><button type="button" className="composer-topbar-nav-btn" aria-expanded={open} aria-haspopup="menu" onClick={()=>setOpen(v=>!v)}>工具 <ChevronDown size={13}/></button>{open&&<nav aria-label="工具" style={{position:'absolute',top:'100%',left:0,minWidth:150,padding:6,zIndex:40,background:'var(--bg-secondary)',border:'1px solid var(--border-color)',borderRadius:6}}>{items.map(i=><Link href={i.href} key={i.href} className="composer-topbar-nav-btn" style={{display:'block'}} onClick={()=>setOpen(false)}>{i.label}</Link>)}</nav>}</div>;
}
