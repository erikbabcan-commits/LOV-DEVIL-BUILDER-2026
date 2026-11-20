import {useStore} from '../../stores/useAppStore';
import {markRepairContext} from '../../services/ai/buildRepair';
import {RepairStatus} from './RepairStatus';
/** Explicit paid action; builds never silently start an AI repair. */
export function BuildRepairAction(){
 const busy=useStore(s=>s.generating||s.sandboxBuilding||!!s.pendingReview||s.edEditing);
 const historical=useStore(s=>!!s.viewing);
 const errors=useStore(s=>s.sandboxErrors);
 const repair=useStore(s=>s.repairSandbox);
 if(historical)return null;
 return <div className="build-repair-action"><button className="btn-primary" disabled={busy} onClick={()=>{markRepairContext(errors);void repair();}}>Navrhnúť AI opravu</button><p>Overím opravu buildom (najviac 3 pokusy). Zmeny schváliš ty. Čerpá AI limit raz za celú opravu.</p><RepairStatus context={errors}/></div>;
}
