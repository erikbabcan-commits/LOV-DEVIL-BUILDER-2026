import type {AIProvider} from './types';
import {AiModelsSchema,type AiModels} from '../../shared/aiModels';
import {safeModel} from '../usage/validation';
export interface ModelEntry {id:string;label:string;provider:AIProvider}
export class ProviderRegistry{
  private readonly entries:readonly ModelEntry[];
  private readonly fallbacks:readonly string[];
  constructor(entries:ModelEntry[],fallbacks:readonly string[]=[]){
    this.fallbacks=Object.freeze([...fallbacks]);
    if(entries.length>3||new Set(entries.map(e=>e.id)).size!==entries.length||fallbacks.length>2||new Set(fallbacks).size!==fallbacks.length||fallbacks.some(id=>!entries.some(e=>e.id===id)))throw new Error('invalid_provider_configuration');
    this.entries=entries.map(entry=>{
      if(!safeModel(entry.provider.name)||!safeModel(entry.provider.model)||!/^[-\w]{1,40}$/.test(entry.id)||!entry.label||entry.label.length>180)throw new Error('invalid_provider_configuration');
      return Object.freeze({...entry});
    });
  }
  get defaultProvider(){return this.entries[0]?.provider??null;}
  catalog():AiModels{return AiModelsSchema.parse({defaultId:this.entries[0]?.id??null,models:this.entries.map(e=>({id:e.id,label:e.label,provider:e.provider.name,model:e.provider.model,fallbackIds:this.fallbacks.filter(id=>id!==e.id)}))});}
  route(id:string|undefined,allowFallback=false,fallbackIds?:readonly string[]):ModelEntry[]{
    const selected=id===undefined?this.entries[0]:this.entries.find(e=>e.id===id);if(!selected)throw new Error('invalid_model');
    const expected=this.fallbacks.filter(id=>id!==selected.id);
    if(allowFallback&&JSON.stringify(fallbackIds)!==JSON.stringify(expected))throw new Error('invalid_model');
    return[selected,...(allowFallback?this.fallbacks.filter(id=>id!==selected.id).map(id=>this.entries.find(e=>e.id===id)!):[])];
  }
}
