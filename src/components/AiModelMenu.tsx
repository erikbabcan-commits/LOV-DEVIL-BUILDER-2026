import {useEffect,useState} from 'react';
import {AiModelsSchema,type AiModels} from '../../shared/aiModels';
import {useStore} from '../stores/useAppStore';
export function AiModelMenu({open}:{open:boolean}){
  const state=useStore(),[catalog,setCatalog]=useState<AiModels|null>(null),[failed,setFailed]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{
    if(!open)return;const controller=new AbortController();setCatalog(null);setFailed(false);
    void fetch('/api/ai-models',{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error('models_unavailable');const data=AiModelsSchema.parse(await response.json());if(!controller.signal.aborted)setCatalog(data);
    }).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
    return()=>controller.abort();
  },[open,revision]);
  const selected=state.model==='Instant Draft'?null:catalog?.models.find(entry=>entry.id===(state.aiModelId??catalog.defaultId));
  const setFallback=state.setAiFallback;
  const expectedFallback=selected?.fallbackIds.join(',')??'',consent=state.aiFallbackIds.join(',');
  useEffect(()=>{if(catalog&&consent&&consent!==expectedFallback)setFallback([]);},[catalog,consent,expectedFallback,setFallback]);
  return <div className={'dropdown model-dropdown'+(open?' open':'')} id="modelMenu" role="group" aria-label="Modely generovania" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();state.setModelMenuOpen(false);document.getElementById('modelChip')?.focus();}}}>
    {open&&!catalog&&!failed&&<p role="status">Načítavam dostupné modely…</p>}
    {failed&&<><p role="status">Ponuku AI modelov sa nepodarilo načítať.</p><button className="item" onClick={()=>setRevision(v=>v+1)}>Obnoviť ponuku modelov</button></>}
    {catalog?.models.map(entry=><button key={entry.id} className="item" disabled={state.generating} onClick={()=>{state.chooseAiModel(entry.id,entry.label);document.getElementById('modelChip')?.focus();}}>
      <span>{entry.label}<span className="sub">{entry.model}</span></span><span className="check">{selected?.id===entry.id?'✓':''}</span>
    </button>)}
    {catalog&&catalog.models.length===0&&<p>Server nemá nastavený žiadny AI model, preto sa kód negeneruje cez AI. Správca ho zapne kľúčom poskytovateľa na serveri. Dovtedy funguje len Instant Draft (šablóny).</p>}
    {selected&&selected.fallbackIds.length>0&&<div className="model-backup">
      <label><input type="checkbox" aria-label="Povoliť záložné modely" disabled={state.generating} checked={state.aiFallbackIds.length>0} onChange={event=>state.setAiFallback(event.target.checked?selected.fallbackIds:[])}/>Pri výpadku použiť záložné modely</label>
      <small>Kontext sa môže odoslať aj do: {selected.fallbackIds.map(id=>catalog!.models.find(entry=>entry.id===id)!.label).join(', ')}. Ďalšie volania sa počítajú do spotreby.</small>
    </div>}
    <button className="item" disabled={state.generating} onClick={()=>{state.setModel('Instant Draft');document.getElementById('modelChip')?.focus();}}><span>Instant Draft<span className="sub">Šablóny bez AI</span></span><span className="check">{state.model==='Instant Draft'?'✓':''}</span></button>
  </div>;
}
