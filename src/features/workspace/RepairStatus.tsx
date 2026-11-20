import {useSyncExternalStore} from 'react';
import {REPAIR_MAX_ATTEMPTS,repairProgress,type RepairProgress,type RepairStep} from '../../services/ai/buildRepair';

export const REPAIR_STATUS_TEXT={
 running:`Prebieha build a AI oprava, najviac ${REPAIR_MAX_ATTEMPTS} pokusy…`,
 succeeded:'Oprava prešla buildom a čaká na tvoju kontrolu. Projekt sa zatiaľ nemenil.',
 clean:'Projekt prešiel buildom bez AI opravy.',
 failed:`Oprava neprešla ani po ${REPAIR_MAX_ATTEMPTS} pokusoch. Ostal posledný funkčný stav projektu, nič sa nezmenilo.`,
 blocked:'Build zablokovala bezpečnostná kontrola. Takéto nálezy AI neopravuje, uprav kód ručne. Ostal posledný funkčný stav projektu.',
} as const;
const STEP_LABEL:Record<RepairStep['step'],string>={build:'build',patch:'AI oprava',rebuild:'rebuild'};
const STATUS_LABEL:Record<RepairStep['status'],string>={ok:'v poriadku',failed:'zlyhal'};

/** Agent 9: priebeh opravy po pokusoch („Pokus N z 3“). Bez nových farieb, len existujúce triedy. */
export function RepairStatus({context,progress:override}:{context?:unknown;progress?:RepairProgress}){
 const live=useSyncExternalStore(repairProgress.subscribe,repairProgress.get,repairProgress.get);
 const progress=override??live;
 if(progress.state==='idle'||(context!==undefined&&progress.context!==context))return null;
 const attempts=[...new Set(progress.steps.map(step=>step.attempt))];
 const final=progress.state==='running'?REPAIR_STATUS_TEXT.running:progress.state==='blocked'?REPAIR_STATUS_TEXT.blocked
  :progress.state==='failed'?REPAIR_STATUS_TEXT.failed:progress.attempts===0?REPAIR_STATUS_TEXT.clean:REPAIR_STATUS_TEXT.succeeded;
 const label=progress.state==='running'?'Priebeh AI opravy':`AI oprava: ${progress.state==='succeeded'?'úspech':'neúspech'}, ${progress.attempts} z ${REPAIR_MAX_ATTEMPTS} pokusov`;
 return <div className="repair-status cp-feedback" role="status" aria-live="polite" aria-label={label} data-state={progress.state} aria-busy={progress.state==='running'}>
  <p>{final}</p>
  {attempts.length>0&&<ol>{attempts.map(attempt=><li key={attempt}>
   <strong>Pokus {attempt} z {REPAIR_MAX_ATTEMPTS}:</strong>{' '}
   {progress.steps.filter(step=>step.attempt===attempt).map(step=>STEP_LABEL[step.step]+' '+STATUS_LABEL[step.status]).join(' · ')}
  </li>)}</ol>}
  {progress.route&&progress.state!=='running'&&<p>Model: {progress.route.model}</p>}
 </div>;
}
