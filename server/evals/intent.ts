import {createHash} from 'node:crypto';
import {z} from 'zod';
import {IntentSchema,INTENT_SYSTEM,INTENT_PROMPT_VERSION,intentMessages} from '../agent/intent';
import {safeModel} from '../usage/validation';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const CaseSchema=z.object({id:z.string().regex(/^(sk|en)-(create|iterate|fix|explain)-\d{2}$/),locale:z.enum(['sk','en']),hasProject:z.boolean(),expected:IntentSchema,prompt:z.string().min(1).max(4000)}).strict();
export const IntentDatasetSchema=z.object({schemaVersion:z.literal(1),version:z.string().max(100),labelSource:z.string().max(300),cases:CaseSchema.array().length(150)}).strict().refine(d=>new Set(d.cases.map(c=>c.id)).size===150&&new Set(d.cases.map(c=>c.prompt)).size===150,'duplicate_cases');
export type IntentDataset=z.infer<typeof IntentDatasetSchema>;
export function datasetHash(dataset:IntentDataset){return hash(JSON.stringify(dataset));}
export const intentPromptHash=()=>hash(INTENT_SYSTEM);
const metadata=z.string().refine(value=>safeModel(value)!==null);
const PredictionSchema=z.object({id:z.string().max(80),intent:IntentSchema.nullable()}).strict();
export const IntentPredictionsSchema=z.object({datasetHash:z.string().regex(/^[a-f0-9]{64}$/),promptHash:z.string().regex(/^[a-f0-9]{64}$/),promptVersion:z.literal(INTENT_PROMPT_VERSION),provenance:z.object({kind:z.enum(['synthetic','recorded']),provider:metadata,model:metadata}).strict(),predictions:PredictionSchema.array().max(150)}).strict();
export type IntentPredictions=z.infer<typeof IntentPredictionsSchema>;
const BaselineSchema=z.object({datasetHash:z.string(),results:z.array(z.object({id:z.string(),predicted:IntentSchema.nullable()}).passthrough()).length(150)}).passthrough();
export function exportIntentRequests(dataset:IntentDataset){return{mode:'offline-request-export',datasetHash:datasetHash(dataset),promptHash:intentPromptHash(),promptVersion:INTENT_PROMPT_VERSION,inferencePerformed:false,requests:dataset.cases.map(c=>({id:c.id,messages:intentMessages(c.prompt,c.hasProject),options:{maxTokens:256,temperature:0}}))};}
/** Scores imported observations only. No network, dotenv, provider or credential IO.
 * Missing/invalid predictions count as errors; no shrinking of denominator. */
export function scoreIntent(dataset:IntentDataset,input:unknown,baseline?:unknown){
 const observations=IntentPredictionsSchema.parse(input),digest=datasetHash(dataset),ids=new Set(dataset.cases.map(c=>c.id));
 if(observations.datasetHash!==digest||observations.promptHash!==intentPromptHash())throw new Error('intent_eval_fingerprint_mismatch');
 const predictions=new Map<string,z.infer<typeof IntentSchema>|null>();
 for(const p of observations.predictions){if(!ids.has(p.id)||predictions.has(p.id))throw new Error('intent_eval_invalid_case');predictions.set(p.id,p.intent);}
 const results=dataset.cases.map(c=>({id:c.id,locale:c.locale,expected:c.expected,predicted:predictions.get(c.id)??null,correct:predictions.get(c.id)===c.expected}));
 const correct=results.filter(r=>r.correct).length,accuracy=correct/150;
 const recalls=Object.fromEntries(IntentSchema.options.map(intent=>{const subset=results.filter(r=>r.expected===intent);return[intent,{correct:subset.filter(r=>r.correct).length,total:subset.length,recall:subset.filter(r=>r.correct).length/subset.length}];}));
 const locales=Object.fromEntries(['sk','en'].map(locale=>{const subset=results.filter(r=>r.locale===locale);return[locale,{correct:subset.filter(r=>r.correct).length,total:subset.length}];}));
 const confusion=Object.fromEntries(IntentSchema.options.map(expected=>[expected,Object.fromEntries([...IntentSchema.options,'missing'].map(predicted=>[predicted,results.filter(r=>r.expected===expected&&(r.predicted??'missing')===predicted).length]))]));
 let regression:null|{newlyWrong:string[];newlyCorrect:string[];fraction:number;withinFivePercent:boolean}=null;
 if(baseline!==undefined){const old=BaselineSchema.parse(baseline);if(old.datasetHash!==digest)throw new Error('intent_eval_baseline_mismatch');const oldMap=new Map(old.results.map(r=>[r.id,r.predicted]));
  if(oldMap.size!==150||[...oldMap.keys()].some(id=>!ids.has(id)))throw new Error('intent_eval_baseline_mismatch');
  const newlyWrong=results.filter(r=>!r.correct&&oldMap.get(r.id)===r.expected).map(r=>r.id),newlyCorrect=results.filter(r=>r.correct&&oldMap.get(r.id)!==r.expected).map(r=>r.id);
  regression={newlyWrong,newlyCorrect,fraction:newlyWrong.length/150,withinFivePercent:newlyWrong.length/150<=0.05};
 }
 return{schemaVersion:1,mode:'offline-scoring' as const,datasetVersion:dataset.version,datasetHash:digest,promptVersion:INTENT_PROMPT_VERSION,promptHash:intentPromptHash(),provenance:observations.provenance,inferenceVerified:false as const,qualityClaim:observations.provenance.kind==='synthetic'?'synthetic-only-not-model-accuracy':'imported-observations-only-provenance-not-independently-verified',total:150,received:observations.predictions.length,missing:results.filter(r=>r.predicted===null).length,correct,accuracy,accuracyGatePassed:accuracy>0.9,regression,perIntent:recalls,perLocale:locales,confusion,results};
}
