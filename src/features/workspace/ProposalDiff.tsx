import {filesFor} from '../../lib/vfs/filesFor';
import {useMemo,useState} from 'react';
import {useStore,matchesReviewBase,type PendingReview} from '../../stores/useAppStore';
import {changedFiles,lineDiff} from '../../lib/projectDiff';
import {applyFileOperations} from '../../lib/projectChanges';
export function ProposalDiff({review,onHistory}:{review:PendingReview;onHistory:()=>void}){
 const state=useStore(),[path,setPath]=useState<string>(),[visible,setVisible]=useState(400);
 const current=matchesReviewBase(state,review.base);
 const changes=useMemo(()=>{
  if(!current)return null;
  const snapshot=state.snapshots.find(s=>s.id===review.base.snapshotId);
  const before=review.base.snapshotId?(snapshot?(state.vfs[snapshot.id]??filesFor(snapshot)):null):[];
  if(!before||!current)return null;const after=applyFileOperations(before,review.files,review.source==='patch');return after?changedFiles(before,after):null;
 },[state.snapshots,state.vfs,review,current]);
 const selected=changes?.find(file=>file.path===path)??changes?.[0],diff=useMemo(()=>selected?lineDiff(selected.before,selected.after):null,[selected]);
 return <section className="project-diff" aria-label="Rozdiel navrhovaných zmien">
  <h3>Navrhované zmeny</h3><p>Porovnanie s pôvodným obsahom. Súbory sa použijú až po schválení.</p>
  {review.summary&&<p>{review.summary}</p>}
  <div className="proposal-tools"><button className="diff-action" onClick={onHistory}>Zobraziť uložené verzie</button>
  <button className="diff-action" onClick={()=>state.setMview('chat')}>Späť ku schváleniu</button></div>
  {!current?<p role="alert">Projekt sa od návrhu zmenil. Návrh je zastaraný; odmietni ho a spusti novú úlohu.</p>:!changes?<p role="alert">Návrh alebo pôvodné súbory sa nedajú bezpečne porovnať.</p>:!changes.length?<p role="status">Návrh nemení obsah súborov.</p>:<>
   <p role="status">Zmenené súbory: {changes.length} · pridané {changes.filter(f=>f.status==='added').length} · odstránené {changes.filter(f=>f.status==='deleted').length}</p>
   <label>Súbor návrhu<select value={selected?.path??''} onChange={event=>{setPath(event.target.value);setVisible(400);}}>{changes.map(file=><option key={file.path} value={file.path}>{file.status==='added'?'+':file.status==='deleted'?'−':'~'} {file.path}</option>)}</select></label>
   {selected&&diff&&<><h3>{selected.path}</h3><p>+{diff.lines.filter(l=>l.kind==='add').length} / −{diff.lines.filter(l=>l.kind==='delete').length} riadkov</p>
    {diff.coarse&&<p>Rozsiahlejšia zmena: zobrazený celý zmenený blok.</p>}
    <div className="diff-code" tabIndex={0} role="region" aria-label={'Zmeny v '+selected.path}>{diff.lines.slice(0,visible).map((line,index)=><div key={index} className={'diff-line '+(line.kind==='add'?'add':line.kind==='delete'?'del':'ctx')}><span className="ln">{line.oldLine??''}</span><span className="ln">{line.newLine??''}</span><span className="sign">{line.kind==='add'?'+':line.kind==='delete'?'−':' '}</span><code>{line.text||' '}</code></div>)}</div>
    {diff.lines.length>visible&&<button className="diff-action" onClick={()=>setVisible(value=>value+400)}>Zobraziť ďalšie riadky ({diff.lines.length-visible})</button>}
   </>}
  </>}
 </section>;
}
