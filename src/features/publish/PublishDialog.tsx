import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { PublishJob, PublishReadiness, PublishRequest, type PublishResult, type PublishReady } from '../../../shared/publish';
import { apiHeaders } from '../../lib/csrf';
import { useStore } from '../../stores/useAppStore';
import { persistenceScope } from '../../services/persistence/db';
import { saveRemoteWorkspace, workspacePayload } from '../../services/projects/workspace';

const Receipt = z.object({ selection: PublishRequest, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
// These POST rejections occur before a job is created. Other outcomes must keep their recovery UUID.
const rejectedInput: Record<string, number> = {
  publish_project_conflict: 409, publish_project_not_found: 404, publish_project_invalid: 409,
  publish_snapshot_sources_required: 409, publish_sources_unsupported: 400,
  publish_invalid_request: 400, publish_input_limit: 413,
};
class PublishHttpError extends Error {
  constructor(code: string, readonly noJobCreated: boolean) { super(code); }
}
const copy: Record<string,string> = {
  publish_disabled:'Publikovanie nie je na serveri zapnuté.', publish_unavailable:'Publikovanie teraz nie je dostupné.',
  publish_conflict:'Serverová verzia sa zmenila. Obnov projekt a skontroluj zdroje.',
  publish_project_conflict:'Serverová revízia sa zmenila. Obnov projekt v Moje projekty, skontroluj zdroje a skús publikovať znova.',
  publish_request_conflict:'Táto požiadavka už patrí inej uloženej verzii. Over pôvodnú publikáciu; novú požiadavku nezačíname.',
  publish_project_not_found:'Uložený projekt sa nenašiel. Obnov ho v Moje projekty alebo ho najprv ulož na server.',
  publish_project_invalid:'Uložený projekt má neplatné údaje. Obnov projekt a ulož platnú verziu.',
  publish_snapshot_sources_required:'Zvolená verzia nemá úplné zdroje. Vytvor a ulož novú verziu.',
  publish_sources_unsupported:'Tieto zdroje nie sú podporované. Oprav zdroje a ulož novú verziu pred publikovaním.',
  publish_invalid_request:'Požiadavka neprešla overením. Obnov aplikáciu a skontroluj uloženú verziu.',
  publish_input_limit:'Požiadavka prekročila povolenú veľkosť. Obnov aplikáciu a skontroluj uloženú verziu.',
  publish_capacity:'Kapacita publikácií je vyčerpaná. Over rovnakú požiadavku po uvoľnení kapacity.',
  publish_protocol:'Odpoveď publikovania neprešla overením. Over pôvodnú požiadavku; novú nezačíname.',
  publish_receipt_storage:'Uloženú požiadavku nemožno aktualizovať. Povoľ úložisko stránky; pôvodný identifikátor zostáva zachovaný.',
  publish_storage_unavailable:'Úložisko publikovaných aplikácií nie je dostupné. Predchádzajúca publikácia zostáva zachovaná.',
  publish_sandbox_unavailable:'Izolovaný build teraz nie je dostupný.', publish_build_failed:'Zostavenie zlyhalo. Oprav chyby a vytvor novú verziu.',
  conflict:'Na serveri je iná revízia. Najprv ju zosúlaď v Moje projekty.',
  stale:'Účet alebo projekt sa zmenil. Oneskorený výsledok sa nepoužil.',
};
async function call(path:string, signal:AbortSignal, body?:unknown) {
  const response=await fetch('/api/publish'+path,{method:body===undefined?'GET':'POST',credentials:'include',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(110_000)]),...(body===undefined?{}:{headers:apiHeaders(),body:JSON.stringify(body)})});
  const data=await response.json().catch(()=>null);
  if(!response.ok) {
    const code=typeof data?.error==='string'?data.error:'publish_unavailable';
    throw new PublishHttpError(code,body!==undefined&&path===''&&rejectedInput[code]===response.status);
  }return data;
}
function sourceBinding() {
  const state=useStore.getState();
  return JSON.stringify({workspace:workspacePayload(state),snapshot:state.viewing?.id??state.liveId});
}
async function digest(text:string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join(''); }
export function PublishDialog({userId,onClose}:{userId?:string;onClose:()=>void}) {
  const state=useStore(),dialog=useRef<HTMLDialogElement>(null),controller=useRef<AbortController|null>(null),alive=useRef(false);
  const [ready,setReady]=useState<PublishReady|null>(null),[busy,setBusy]=useState(false),[consent,setConsent]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<PublishResult|null>(null);
  const [uncertain,setUncertain]=useState(false);
  const scope=persistenceScope(),epoch=useRef(scope.epoch).current,projectId=useRef(state.projectId).current;
  const snapshot=state.viewing??state.snapshots.find(s=>s.id===state.liveId);
  const blocked=state.generating||state.sandboxBuilding||!!state.pendingReview||state.codeDraftDirty||state.edEditing||!snapshot;
  const key='forge-publish:'+encodeURIComponent(userId??'')+':'+projectId;
  useEffect(()=>{
    alive.current=true;const node=dialog.current,previous=document.activeElement as HTMLElement|null;
    if(node){if(node.showModal)node.showModal();else node.setAttribute('open','');}
    const pending=new AbortController();controller.current=pending;
    if(userId)void call('',pending.signal).then(data=>{if(alive.current&&!pending.signal.aborted)setReady(PublishReadiness.parse(data));}).catch(()=>{if(alive.current&&!pending.signal.aborted)setError('Stav publikovania sa nepodarilo overiť.');});
    return()=>{alive.current=false;controller.current?.abort();node?.close?.();previous?.focus();};
  },[userId]);
  const current=()=>alive.current&&persistenceScope().epoch===epoch&&useStore.getState().projectId===projectId;
  async function publish() {
    if(busy||blocked||!consent||!ready?.ready||!userId||!current()||!snapshot)return;
    const pending=new AbortController();controller.current?.abort();controller.current=pending;setBusy(true);setError('');setResult(null);
    const binding=sourceBinding(),unchanged=()=>current()&&!pending.signal.aborted&&!useStore.getState().codeDraftDirty&&!useStore.getState().edEditing&&sourceBinding()===binding;
    let ownedReceipt:string|null=null;
    const clearOwnedReceipt=()=>{if(ownedReceipt!==null&&sessionStorage.getItem(key)===ownedReceipt)sessionStorage.removeItem(key);};
    try {
      const fingerprint=await digest(binding);if(!unchanged())throw new Error('stale');
      const stored=sessionStorage.getItem(key),receipt=stored?Receipt.parse(JSON.parse(stored)):null;
      let selection=receipt?.fingerprint===fingerprint?receipt.selection:null;
      if(selection&&selection.projectId!==projectId)throw new Error('publish_protocol');
      if(selection)ownedReceipt=stored;
      let data:unknown;
      if(selection) {
        try{data=await call('/'+selection.requestId,pending.signal);}catch(reason){if(!(reason instanceof Error)||!['publish_not_found','publish_job_not_found'].includes(reason.message))throw reason;}
      } else {
        const saved=await saveRemoteWorkspace(pending.signal);if(!unchanged())throw new Error('stale');
        if(saved.id!==projectId)throw new Error('stale');
        selection=PublishRequest.parse({requestId:crypto.randomUUID(),projectId:saved.id,expectedRevision:saved.revision,snapshotId:useStore.getState().remoteSnapshotIds[snapshot.id]??snapshot.id,publicConsent:true});
        ownedReceipt=JSON.stringify({selection,fingerprint});
        sessionStorage.setItem(key,ownedReceipt);
      }
      if(!unchanged())throw new Error('stale');
      if(data===undefined || PublishJob.parse(data).state === 'building')data=await call('',pending.signal,selection);
      let job=PublishJob.parse(data);
      for(let i=0;job.state==='building'&&i<6;i++) {
        await new Promise(resolve=>setTimeout(resolve,10_000));if(!unchanged())throw new Error('stale');
        job=PublishJob.parse(await call('/'+selection.requestId,pending.signal));
      }
      if(!unchanged())throw new Error('stale');
      if(job.requestId!==selection.requestId||job.projectId!==selection.projectId||job.revision!==selection.expectedRevision||job.snapshotId!==selection.snapshotId)throw new Error('publish_protocol');
      if(job.state==='published') {
        const url=new URL(job.url??'');
        if(url.origin!==ready.publicOrigin||url.username||url.password||url.search||url.hash||!/^\/p\/[a-f0-9-]{36}\/$/i.test(url.pathname))throw new Error('publish_protocol');
        useStore.setState({publishedUrl:url.href});await useStore.getState().persistNow();
        if(!unchanged())return;
        clearOwnedReceipt();setUncertain(false);
      }else if(job.state==='failed'){clearOwnedReceipt();setUncertain(false);}else setUncertain(true);
      setResult(job);
    }catch(reason){if(current()&&!pending.signal.aborted){
      if(reason instanceof PublishHttpError&&reason.noJobCreated){
        try{clearOwnedReceipt();setUncertain(false);}catch{setUncertain(true);setError(copy['publish_receipt_storage']!);return;}
      }
      else setUncertain(ownedReceipt!==null);
      setError(copy[reason instanceof Error?reason.message:'']??'Výsledok sa nepodarilo potvrdiť. Over rovnakú požiadavku; nová publikácia sa nezačne naslepo.');
    }}
    finally{if(current())setBusy(false);}
  }
  return <dialog ref={dialog} className="project-library" aria-label="Publikovať aplikáciu" onCancel={e=>{e.preventDefault();onClose();}}>
    <div className="project-library-head"><h2>Publikovať aplikáciu</h2><button onClick={onClose} aria-label="Zavrieť publikovanie">×</button></div>
    <p><b>{state.projectTitle}</b>{snapshot?' · verzia '+snapshot.v:''}</p>
    <p>Verejná statická aplikácia bude zostavená z uloženej verzie projektu. Chat ani čakajúci AI návrh sa nepublikujú. Táto verzia hostingu nepodporuje vlastný backend ani externé sieťové API.</p>
    {!userId?<p role="status">Publikovanie vyžaduje prihlásený účet.</p>:!ready&&!error?<p role="status">Overujem hosting…</p>:ready&&!ready.ready?<p role="status">{ready.enabled?'Izolovaný hosting teraz nie je pripravený.':'Publikovanie nie je na serveri zapnuté.'}</p>:null}
    {blocked&&<p role="status">Najprv dokonči kontrolu návrhu, úpravy a zostavenie projektu.</p>}
    <label><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/> Súhlasím so zverejnením tejto aplikácie a jej zostavených zdrojov pre každého s odkazom.</label>
    <button disabled={busy||blocked||!consent||!ready?.ready||!userId} onClick={()=>void publish()}>{busy?'Zostavujem a publikujem…':uncertain?'Overiť rovnakú požiadavku':'Publikovať zvolenú verziu'}</button>
    {error&&<p role="alert">{error}</p>}
    {result?.state==='building'&&<p role="status">Server ešte pracuje. Over výsledok rovnakou požiadavkou.</p>}
    {result?.state==='failed'&&<div role="alert"><p>{copy[result.error??'']??'Zostavenie alebo uloženie zlyhalo.'}</p>{result.errors.map((e,i)=><p key={i}>{e.file}: {e.message}</p>)}</div>}
    {result?.state==='published'&&<p role="status">Publikované · revízia {result.revision} · <a href={result.url!} target="_blank" rel="noopener noreferrer">Otvoriť verejnú aplikáciu</a></p>}
  </dialog>;
}
