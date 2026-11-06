import { AiUsageCard } from './AiUsageCard';
import { BillingCard } from '../billing/BillingCard';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores/useAppStore';
import { loadProjects, type StoredProject } from '../../services/persistence/db';
import { remoteProjects, ProjectApiError, type RemoteMetadata } from '../../services/projects/client';
import { openLocalWorkspace, openRemoteWorkspace, saveRemoteWorkspace } from '../../services/projects/workspace';
import type { QuotaInfo } from '../../services/auth';
import type { ProjectStorageSnapshot } from '../../../shared/projectStorage';

function storageSize(bytes:number):string {
  const unit=bytes>=1_000_000?'MB':bytes>=1000?'kB':'B',scale=unit==='MB'?1_000_000:unit==='kB'?1000:1;
  return (bytes/scale).toLocaleString('sk-SK',{maximumFractionDigits:1})+' '+unit;
}

const errors:Record<string,string>={access_denied:'Server odmietol prístup. Over prihlásenie a obnov stránku.',history_conflict:'Už uloženú históriu nemožno prepísať. Lokálny obsah zachováš uložením samostatnej serverovej kópie.',conflict:'Na serveri je iná revízia. Lokálny obsah zostal zachovaný. Ulož ho ako kópiu alebo otvor serverovú verziu.',network:'Spojenie sa prerušilo. Zápis už mohol prebehnúť. Obnov zoznam a porovnaj serverovú verziu; lokálny obsah zostal zachovaný.',login_required:'Relácia vypršala. Znovu sa prihlás.',deleted:'Projekt je na serveri v koši. Najprv ho obnov.',project_limits:'Projekt prekračuje limity alebo obsahuje nepovolené údaje. Lokálna verzia zostala zachovaná.',local_storage:'Lokálnu kópiu sa nepodarilo bezpečne uložiť. Projekt sa neprepína.',busy:'Najprv dokonči generovanie, kontrolu zmien alebo editáciu súboru.',stale:'Projekt alebo účet sa počas operácie zmenil. Výsledok sa neotvoril.',rate_limit:'Priveľa požiadaviek. Skús to o chvíľu znova.'};
export function ProjectLibrary({enabled,onClose,quota,onRefreshQuota,userId}:{enabled:boolean;onClose:()=>void;quota?:QuotaInfo;onRefreshQuota?:()=>void;userId?:string}){
  const dialog=useRef<HTMLDialogElement>(null),controller=useRef<AbortController|null>(null),alive=useRef(false);
  const [local,setLocal]=useState<StoredProject[]>([]),[remote,setRemote]=useState<RemoteMetadata[]>([]);
  const [deleted,setDeleted]=useState(false),[next,setNext]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [usage,setUsage]=useState<ProjectStorageSnapshot|null>(null),[usageError,setUsageError]=useState(false);
  const state=useStore();
  const blocked=state.generating||state.sandboxBuilding||!!state.pendingReview||state.edEditing;
  const refresh=useCallback(async(signal:AbortSignal,cursor:string|null=null)=>{
    if(enabled&&!cursor)void remoteProjects.usage(signal).then(value=>{if(!signal.aborted){setUsage(value);setUsageError(false);}},()=>{if(!signal.aborted){setUsage(null);setUsageError(true);}});
    const [locals,list]=await Promise.all([loadProjects(),enabled?remoteProjects.list(deleted,cursor,signal):Promise.resolve(null)]);
    if(signal.aborted)return;
    setLocal(locals);if(list){setRemote(previous=>cursor?[...previous,...list.projects]:list.projects);setNext(list.nextCursor);}
  },[enabled,deleted]);
  const perform=useCallback((action:(signal:AbortSignal)=>Promise<void>)=>{
    controller.current?.abort();const current=new AbortController();controller.current=current;
    setBusy(true);setError('');setMessage('');
    void action(current.signal).catch(reason=>{
      if(alive.current&&!current.signal.aborted)setError(reason instanceof ProjectApiError?reason.code==='storage_quota'?'Serverové úložisko je plné. Lokálna práca zostala zachovaná a môžeš ju ďalej upravovať alebo exportovať. Pre väčšiu kapacitu kontaktuj podporu.':errors[reason.code]??'Serverové úložisko teraz nie je dostupné.':'Údaje sa nepodarilo spracovať. Lokálny obsah zostal zachovaný.');
    }).finally(()=>{if(alive.current&&controller.current===current)setBusy(false);});
  },[]);
  useEffect(()=>{
    const node=dialog.current,previous=document.activeElement as HTMLElement|null;
    if(node){if(typeof node.showModal==='function')node.showModal();else node.setAttribute('open','');}
    return()=>{node?.close?.();previous?.focus();};
  },[]);
  useEffect(()=>{alive.current=true;perform(signal=>refresh(signal));return()=>{alive.current=false;controller.current?.abort();};},[refresh,perform]);
  return <dialog ref={dialog} className="project-library" aria-labelledby="project-library-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!busy)onClose();}}}>
    <div className="project-library-head"><h2 id="project-library-title">Moje projekty</h2><button disabled={busy} onClick={onClose} aria-label="Zavrieť projekty">×</button></div>
    <p>{enabled?'Na server ukladáš ručne. Zmeny v editore sa priebežne ukladajú lokálne.':'Pilot ukladá projekty iba v tomto prehliadači. Serverové projekty vyžadujú prihlásený účet.'}</p>
    <div className="project-library-actions">
      <button disabled={busy} onClick={()=>{onRefreshQuota?.();perform(signal=>refresh(signal));}}>Obnoviť zoznam</button>
      {enabled&&<><button disabled={busy||blocked||!state.snapshots.length} onClick={()=>perform(async signal=>{await saveRemoteWorkspace(signal);await refresh(signal);setMessage('Zachytená verzia bola uložená na server.');})}>Uložiť na server</button>
      <button disabled={busy||blocked||!state.snapshots.length} onClick={()=>perform(async signal=>{await saveRemoteWorkspace(signal,true);await refresh(signal);setMessage('Na serveri vznikla samostatná kópia. Pôvodný projekt zostal prepojený bez zmeny.');})}>Uložiť ako serverovú kópiu</button></>}
    </div>
    {busy&&<p role="status">Pracujem s projektmi…</p>}{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {blocked&&<p>Pred prepnutím dokonči rozpracovanú operáciu alebo úpravu súboru.</p>}
    {enabled&&quota&&<section className="project-storage" aria-label="Mesačná spotreba AI">
      <p><b>AI úlohy tento mesiac</b> · {quota.used} z {quota.limit} · zostáva {quota.remaining}</p>
      <progress aria-label="Využité AI úlohy" value={Math.min(quota.used,quota.limit)} max={quota.limit}/>
      <small>Otázky, generovanie aj AI opravy čerpajú limit. Počíta sa aj neúspešná alebo zrušená spustená úloha. Limit sa obnovuje na začiatku mesiaca v UTC. Lokálne úpravy a Instant Draft ho nečerpajú.</small>
      {quota.used>=quota.limit*0.8&&<p role="status">{quota.remaining===0?'Mesačný limit AI je vyčerpaný.':'Blížiš sa k mesačnému limitu AI.'} Lokálna práca a export zostávajú dostupné.</p>}
    </section>}
    {enabled&&userId&&<BillingCard userId={userId} onRefreshQuota={onRefreshQuota}/>}
    {enabled&&<AiUsageCard/>}
    <h3>V tomto prehliadači</h3>
    {!local.length&&!busy&&<p>Zatiaľ tu nie sú uložené projekty.</p>}
    <ul>{local.map(project=><li key={project.id}><span><b>{project.title}</b><small>{project.id===state.projectId?'Otvorený projekt':'Lokálne uložený'}</small></span><button disabled={busy||blocked} onClick={()=>perform(async signal=>{await openLocalWorkspace(project.id,signal);onClose();})}>Otvoriť lokálne</button></li>)}</ul>
    {enabled&&<><div className="project-library-head"><h3>Na serveri</h3><button disabled={busy} aria-pressed={deleted} onClick={()=>setDeleted(value=>!value)}>{deleted?'Zobraziť aktívne':'Kôš'}</button></div>
    {usage&&<section className="project-storage" aria-label="Kapacita serverového úložiska">
      <p>{storageSize(usage.usedBytes)} z {storageSize(usage.limitBytes)} · {usage.usedProjects} z {usage.limitProjects} projektov</p>
      <progress aria-label="Využité miesto na serveri" value={Math.min(usage.usedBytes,usage.limitBytes)} max={usage.limitBytes}/>
      <small>Počíta sa aj kôš ({usage.trashedProjects}). Obnova miesto nezaberie znova.</small>
      {usage.warning&&<p role="status">Kapacita servera sa blíži k limitu alebo je plná. Lokálna práca a export zostávajú dostupné.</p>}
    </section>}
    {usageError&&<p>Kapacitu sa nepodarilo načítať. Skús obnoviť zoznam; projekty môžeš ďalej otvárať.</p>}
    <p>Otvorenie zachová aktuálny uložený projekt. Ak nahrádzaš rovnaké lokálne ID, vytvorí sa jeho samostatná lokálna kópia so zdrojmi a históriou. Obnova z koša je možná do 30 dní.</p>
    {!remote.length&&!busy&&<p>{deleted?'Kôš je prázdny.':'Zatiaľ nemáš serverové projekty.'}</p>}
    <ul>{remote.map(project=><li key={project.id}><span><b>{project.title}</b><small>Revízia {project.revision} · {new Date(project.updatedAt).toLocaleString('sk-SK')}</small></span>
      {!deleted&&<button disabled={busy||blocked} onClick={()=>perform(async signal=>{await openRemoteWorkspace(project.id,signal);onClose();})}>Otvoriť zo servera</button>}
      <button disabled={busy} onClick={()=>perform(async signal=>{await remoteProjects.change(project.id,project.revision,deleted?'restore':'delete',signal);await refresh(signal);setMessage(deleted?'Projekt bol obnovený.':'Serverový projekt je v koši. Lokálna kópia zostala zachovaná.');})}>{deleted?'Obnoviť':'Do koša'}</button>
    </li>)}</ul>{next&&<button disabled={busy} onClick={()=>perform(signal=>refresh(signal,next))}>Ďalšie projekty</button>}</>}
  </dialog>;
}
