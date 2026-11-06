import {useStore} from '../../stores/useAppStore';
/** Explicit paid action; builds never silently start an AI repair. */
export function BuildRepairAction(){
 const busy=useStore(s=>s.generating||s.sandboxBuilding||!!s.pendingReview||s.edEditing);
 const historical=useStore(s=>!!s.viewing);
 const repair=useStore(s=>s.repairSandbox);
 if(historical)return null;
 return <div className="build-repair-action"><button className="btn-primary" disabled={busy} onClick={()=>void repair()}>Navrhnúť AI opravu</button><p>Overím opravu buildom. Zmeny schváliš ty. Čerpá AI limit.</p></div>;
}
