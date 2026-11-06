import {contextGuardedProvider,contextWindow} from './contextBudget';
import type {AiUsageStore,RunInput,RunStatus} from '../usage/store';
import {meteredProvider} from '../usage/meter';
import type {ModelEntry} from './registry';
import {resilientProvider,type ResilienceOptions} from './resilience';
export function createProviderRun(route:ModelEntry[],store:AiUsageStore|null,run:RunInput,options:ResilienceOptions={}){
  const health={broken:false};
  const meters=store?route.map(entry=>meteredProvider(entry.provider,store,run,health)):[];
  return{provider:contextGuardedProvider(resilientProvider(route.map((entry,index)=>meters[index]?.provider??entry.provider),options),Math.min(...route.map(entry=>contextWindow(entry.provider)))),
    finish:async(status:RunStatus)=>{if(meters[0])await meters[0].finish(status);}};
}
