// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {IntentDatasetSchema,datasetHash,intentPromptHash,exportIntentRequests,scoreIntent} from '../../../server/evals/intent';
import {INTENT_PROMPT_VERSION} from '../../../server/agent/intent';
const dataset=IntentDatasetSchema.parse(JSON.parse(readFileSync(new URL('../../../server/evals/intent-cases.json',import.meta.url),'utf8')));
const predictions=(correct=150)=>({datasetHash:datasetHash(dataset),promptHash:intentPromptHash(),promptVersion:INTENT_PROMPT_VERSION,provenance:{kind:'synthetic',provider:'fixture',model:'synthetic-only'},predictions:dataset.cases.map((c,i)=>({id:c.id,intent:i<correct?c.expected:null}))});
describe('versioned 150-prompt intent evaluation',()=>{
 it('contains 75 Slovak and 75 English unique manually labelled cases across all four intents',()=>{
  expect(dataset.cases).toHaveLength(150);for(const locale of ['sk','en'])expect(dataset.cases.filter(c=>c.locale===locale)).toHaveLength(75);
  expect(new Set(dataset.cases.map(c=>c.expected))).toEqual(new Set(['create','iterate','fix','explain']));expect(dataset.labelSource).toContain('human review pending');
 });
 it('requires strictly above 90 percent, without rounding 135/150 into success',()=>{
  expect(scoreIntent(dataset,predictions(135))).toMatchObject({correct:135,accuracy:0.9,accuracyGatePassed:false});expect(scoreIntent(dataset,predictions(136)).accuracyGatePassed).toBe(true);
 });
 it('never labels synthetic correctness as verified model inference or model quality',()=>{
  expect(scoreIntent(dataset,predictions())).toMatchObject({correct:150,accuracy:1,inferenceVerified:false,qualityClaim:'synthetic-only-not-model-accuracy'});
 });
 it('counts omitted predictions in the full denominator and rejects duplicates or unknown cases',()=>{
  expect(scoreIntent(dataset,{...predictions(),predictions:[]})).toMatchObject({total:150,correct:0,missing:150,accuracyGatePassed:false});
  expect(()=>scoreIntent(dataset,{...predictions(),predictions:[predictions().predictions[0],predictions().predictions[0]]})).toThrow('intent_eval_invalid_case');
  expect(()=>scoreIntent(dataset,{...predictions(),predictions:[{id:'unknown',intent:'create'}]})).toThrow('intent_eval_invalid_case');
 });
 it('rejects stale prompts or datasets instead of scoring another classifier version',()=>{
  expect(()=>scoreIntent(dataset,{...predictions(),datasetHash:'0'.repeat(64)})).toThrow('intent_eval_fingerprint_mismatch');expect(()=>scoreIntent(dataset,{...predictions(),promptHash:'0'.repeat(64)})).toThrow('intent_eval_fingerprint_mismatch');
 });
 it('measures per-class/locale coverage and a full confusion matrix',()=>{
  const p=predictions();for(const row of p.predictions)row.intent='fix';const result=scoreIntent(dataset,p);expect(result.perIntent.fix).toEqual({total:36,correct:36,recall:1});expect(result.perIntent.explain.recall).toBe(0);expect(result.confusion.explain.fix).toBe(34);expect(result.perLocale.sk.total).toBe(75);
 });
 it('fails an eight-case regression and permits seven out of the same 150 cases',()=>{
  const old=scoreIntent(dataset,predictions());expect(scoreIntent(dataset,predictions(142),old).regression).toMatchObject({withinFivePercent:false});expect(scoreIntent(dataset,predictions(143),old).regression).toMatchObject({withinFivePercent:true});
  expect(()=>scoreIntent(dataset,predictions(),{...old,datasetHash:'stale'})).toThrow('intent_eval_baseline_mismatch');
 });
 it('exports the exact classifier contract without performing inference',()=>{
  const result=exportIntentRequests(dataset);expect(result.inferencePerformed).toBe(false);expect(result.requests).toHaveLength(150);expect(JSON.parse(result.requests[0].messages[1].content)).toEqual({prompt:dataset.cases[0].prompt,hasProject:dataset.cases[0].hasProject});
 });
 it('runs the real offline CLI from an unrelated cwd and refuses live flags and file overwrite',()=>{
  const directory=mkdtempSync(join(tmpdir(),'lov-intent-eval-')),root=resolve(new URL('../../..',import.meta.url).pathname),script=join(root,'scripts/eval-intent.ts');
  const invoke=(args:string[])=>spawnSync(process.execPath,[join(root,'node_modules/tsx/dist/cli.mjs'),script,...args],{cwd:directory,encoding:'utf8',env:{...process.env,NODE_ENV:'test',MISTRAL_API_KEY:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',DOTENV_CONFIG_PATH:'/dev/null'}});
  try{const input=join(directory,'predictions.json'),output=join(directory,'report.json');writeFileSync(input,JSON.stringify(predictions(135)));writeFileSync(join(directory,'.env'),'MISTRAL_API_KEY=unused-private-marker');
   const result=invoke(['--predictions',input,'--output',output]);expect(result.status).toBe(2);expect(JSON.parse(readFileSync(output,'utf8'))).toMatchObject({mode:'offline-scoring',correct:135,inferenceVerified:false});expect(statSync(output).mode&0o777).toBe(0o600);
   expect(invoke(['--predictions',input,'--output',output]).status).toBe(1);expect(invoke(['--live']).status).toBe(1);
   expect(invoke(['--export-requests','--output',join(directory,'requests.json')]).status).toBe(0);expect(JSON.parse(readFileSync(join(directory,'requests.json'),'utf8')).requests).toHaveLength(150);
  }finally{rmSync(directory,{recursive:true,force:true});}
 },15000);
});
