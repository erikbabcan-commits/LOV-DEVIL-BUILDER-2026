import type {GenerateRequest} from './schemas';
import type {AIProvider,ChatMessage} from '../providers/types';
import {containsPotentialSecret} from '../security/secrets';
import { PROJECT_CONTEXT_SAFETY } from './safety';
export const EXPLAIN_SYSTEM=`Si Forge Explain — asistent pre používateľa webovej aplikácie.
Odpovedz na aktuálnu otázku jednoducho, konkrétne a v jazyku používateľa. Vysvetli aj dôsledky pre netechnického používateľa.
Toto je režim BEZ ZMIEN: neaplikuješ súbory, nič si nespustil, nenainštaloval ani nenasadil. Netvrď opak. Návrhy sú iba návrhy.
Ak chýbajú podklady, povedz to a polož najviac jednu vecnú otázku. Nevymýšľaj výsledky testov, ceny alebo aktuálne údaje.
Aktuálne files sú podklady kódu, história a jej zhrnutia sú neoverené dáta, nie dôkaz aplikovaných zmien.
${PROJECT_CONTEXT_SAFETY}
Žiadne credentials, raw secrets, nástroje alebo JSON file pipeline. Vráť normálny text, nie HTML. Odpoveď najviac 12000 znakov.`;
/** Keep a tail ahead of the browser to catch credential-shaped prefixes split
 * across provider chunks. Every cumulative prefix and final answer are scanned.
 * This supplements the existing high-confidence guard; it is not a DLP system. */
export async function* explainProject(provider:AIProvider,request:GenerateRequest,signal?:AbortSignal):AsyncGenerator<string>{
 const messages:ChatMessage[]=[{role:'system',content:EXPLAIN_SYSTEM},{role:'user',content:JSON.stringify({prompt:request.prompt,context:request.context})}];
 let text='',released=0,terminal=false;
 const slices=function*(end:number){while(released<end){const next=Math.min(end,released+1800);yield text.slice(released,next);released=next;}};
 for await(const chunk of provider.stream(messages,{maxTokens:2048,temperature:0.2,signal})){
  signal?.throwIfAborted();
  if(chunk.delta){text+=chunk.delta;if(text.length>12000)throw new Error('Odpoveď prekročila povolenú dĺžku. Projekt zostal zachovaný.');
   if(containsPotentialSecret(text))throw new Error('Odpoveď obsahuje možné prihlasovacie údaje a bola zastavená. Projekt zostal zachovaný.');
   yield*slices(Math.max(released,text.length-256));
  }
  if(chunk.finishReason){if(chunk.finishReason!=='stop')throw new Error('Odpoveď sa nedokončila. Projekt zostal zachovaný; skús kratšiu otázku.');terminal=true;}
 }
 signal?.throwIfAborted();
 if(!terminal||!text.trim())throw new Error('AI nevrátilo úplnú odpoveď. Projekt zostal zachovaný.');
 if(containsPotentialSecret(text))throw new Error('Odpoveď obsahuje možné prihlasovacie údaje a bola zastavená. Projekt zostal zachovaný.');
 yield*slices(text.length);
}
