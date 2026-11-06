import { useStore,matchesReviewBase } from '../../stores/useAppStore';

/** The visible counterpart to the existing compare-and-apply safety gate. */
export function ReviewPanel() {
  const review = useStore(state => state.pendingReview);
  const current=useStore(state=>state.pendingReview?matchesReviewBase(state,state.pendingReview.base):true);
  const showDiff=useStore(state=>state.setTab);
  const showCanvas=useStore(state=>state.setMview);
  const approve = useStore(state => state.approveStagedRun);
  const reject = useStore(state => state.rejectStagedRun);
  if (!review) return null;
  const template = review.source === 'template';
  return <section className="review-panel" aria-labelledby="review-title">
    <span className="section-eyebrow">Pripravené na tvoju kontrolu</span>
    <h3 id="review-title">{template ? review.title : 'Navrhované zmeny'}</h3>
    <p>{template ? 'Šablóna je pripravená bez AI volania.' : 'Agent pripravil súbory.'} Použi ich až po kontrole. Predchádzajúca verzia zostane v histórii.</p>
    {review.summary&&<p>{review.summary}</p>}
    {!current&&<p role="alert">Projekt sa od návrhu zmenil. Odmietni tento návrh a spusti novú úlohu.</p>}
    <button onClick={()=>{showDiff('diff');showCanvas('canvas');}}>Skontrolovať rozdiel</button>
    <div className="review-files">{review.files.map(file => <details key={file.path}><summary><span className={'file-action ' + file.action}>{file.action === 'delete' ? '−' : file.action === 'modify' ? '~' : '+'}</span>{file.path}</summary>
      <small>{file.action === 'delete' ? 'Odstráni sa v novej verzii' : 'Navrhovaný obsah'}</small>
      {file.action !== 'delete' && <pre>{file.content}</pre>}</details>)}</div>
    <div className="review-actions"><button onClick={reject}>Odmietnuť</button><button disabled={!current} onClick={() => {
      if (approve()) {
        const state = useStore.getState();
        void state.runSandbox(); state.setTab('preview'); state.setMview('canvas');
      }
    }}>Použiť zmeny</button></div>
  </section>;
}
