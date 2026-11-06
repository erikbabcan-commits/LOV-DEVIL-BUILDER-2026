import {ProposalDiff} from './ProposalDiff';
import { useMemo, useState } from 'react';
import { useStore } from '../../stores/useAppStore';
import { changedFiles, lineDiff, parentOf, snapshotSources } from '../../lib/projectDiff';

export function ProjectDiff() {
  const pending=useStore(state=>state.pendingReview);
  const [historyForReview,setHistoryForReview]=useState<string|null>(null);
  const snapshots = useStore(state => state.snapshots);
  const vfs = useStore(state => state.vfs);
  const current = useStore(state => state.viewing?.id ?? state.liveId);
  const [targetId, setTarget] = useState<string>();
  const [baseId, setBase] = useState<string>();
  const [path, setPath] = useState<string>();
  const [visible, setVisible] = useState(400);
  const target = snapshots.find(snapshot => snapshot.id === (targetId ?? current)) ?? snapshots.at(-1);
  const parent = target ? parentOf(snapshots, target) : undefined;
  const base = baseId === undefined ? parent : snapshots.find(snapshot => snapshot.id === baseId);
  const unavailableParent = baseId === undefined && !!target?.parentId && !parent;
  const changes = useMemo(() => {
    if (!target || unavailableParent) return null;
    const a = base ? snapshotSources(base, vfs) : [];
    const b = snapshotSources(target, vfs);
    return a && b ? changedFiles(a, b) : null;
  }, [target, base, vfs, unavailableParent]);
  const selected = changes?.find(file => file.path === path) ?? changes?.[0];
  const diff = useMemo(() => selected ? lineDiff(selected.before, selected.after) : null, [selected]);
  if(pending&&historyForReview!==pending.runId)return <ProposalDiff key={pending.runId} review={pending} onHistory={()=>setHistoryForReview(pending.runId)}/>;
  if (!target) return <p className="pane-empty">Najprv vytvor alebo ulož verziu projektu.</p>;
  return <section className="project-diff" aria-label="Porovnanie súborov">
    {pending&&<button className="diff-action" onClick={()=>setHistoryForReview(null)}>Pozrieť navrhované zmeny</button>}
    <div className="diff-selectors">
      <label>Pôvodná verzia<select value={unavailableParent ? target.parentId! : base?.id ?? ''} onChange={event => { setBase(event.target.value); setVisible(400); }}>
        {unavailableParent && <option value={target.parentId!} disabled>Predchádzajúca verzia nedostupná</option>}
        <option value="">Prázdny projekt</option>{snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>v{snapshot.v} · {snapshot.prompt.slice(0, 45)}</option>)}
      </select></label>
      <label>Nová verzia<select value={target.id} onChange={event => { setTarget(event.target.value); setBase(undefined); setPath(undefined); setVisible(400); }}>
        {snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>v{snapshot.v} · {snapshot.prompt.slice(0, 45)}</option>)}
      </select></label>
    </div>
    {!changes ? <p role="alert">Zdrojové súbory tejto verzie alebo jej predchodcu nie sú dostupné. Vyber inú verziu.</p> : !changes.length ? <p role="status">Verzie majú rovnaký obsah súborov.</p> : <>
      <p role="status">Zmenené súbory: {changes.length} · pridané {changes.filter(file => file.status === 'added').length} · odstránené {changes.filter(file => file.status === 'deleted').length}</p>
      <label>Súbor<select value={selected?.path ?? ''} onChange={event => { setPath(event.target.value); setVisible(400); }}>
        {changes.map(file => <option key={file.path} value={file.path}>{file.status === 'added' ? '+' : file.status === 'deleted' ? '−' : '~'} {file.path}</option>)}
      </select></label>
      {selected && diff && <>
        <h3>{selected.path}</h3>
        <p>+{diff.lines.filter(line => line.kind === 'add').length} / −{diff.lines.filter(line => line.kind === 'delete').length} riadkov</p>
        {diff.coarse && <p>Rozsiahlejšia zmena: zobrazený celý zmenený blok.</p>}
        <div className="diff-code" tabIndex={0} role="region" aria-label={'Zmeny v ' + selected.path}>
          {diff.lines.slice(0, visible).map((line, index) => <div key={index} className={'diff-line ' + (line.kind === 'add' ? 'add' : line.kind === 'delete' ? 'del' : 'ctx')}>
            <span className="ln">{line.oldLine ?? ''}</span><span className="ln">{line.newLine ?? ''}</span><span className="sign">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '}</span><code>{line.text || ' '}</code>
          </div>)}
        </div>
        {diff.lines.length > visible && <button className="diff-action" onClick={() => setVisible(value => value + 400)}>Zobraziť ďalšie riadky ({diff.lines.length - visible})</button>}
      </>}
    </>}
  </section>;
}
