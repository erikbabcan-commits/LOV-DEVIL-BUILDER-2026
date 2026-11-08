import {readFile,stat,writeFile} from 'node:fs/promises';
import {IntentDatasetSchema,exportIntentRequests,scoreIntent} from '../server/evals/intent';
import {IntentPromptVersionSchema} from '../server/agent/intent';
/** Deliberately offline: no model/SDK/env import, no inference or schedule. */
async function readJson(path:string|URL){const metadata=await stat(path);if(!metadata.isFile()||metadata.size>1_000_000)throw new Error('invalid_eval_file');return JSON.parse(await readFile(path,'utf8'));}
async function main(){
 const args=process.argv.slice(2),options=new Map<string,string>();let exportRequests=false;
 for(let i=0;i<args.length;i++){const flag=args[i];if(flag==='--export-requests'){if(exportRequests)throw new Error('invalid_eval_arguments');exportRequests=true;continue;}
  if(!['--predictions','--baseline','--output','--prompt-version'].includes(flag)||options.has(flag)||!args[i+1]||args[i+1].startsWith('--'))throw new Error('invalid_eval_arguments');options.set(flag,args[++i]);}
 if(exportRequests?(options.has('--predictions')||options.has('--baseline')):(!options.has('--predictions')||options.has('--prompt-version')))throw new Error('invalid_eval_arguments');
 const dataset=IntentDatasetSchema.parse(await readJson(new URL('../server/evals/intent-cases.json',import.meta.url)));
 const version=IntentPromptVersionSchema.optional().parse(options.get('--prompt-version'));
 const result=exportRequests?exportIntentRequests(dataset,version):scoreIntent(dataset,await readJson(options.get('--predictions')!),options.has('--baseline')?await readJson(options.get('--baseline')!):undefined);
 const text=JSON.stringify(result,null,2)+'\n';if(options.has('--output'))await writeFile(options.get('--output')!,text,{flag:'wx',mode:0o600});else process.stdout.write(text);
 if('accuracyGatePassed' in result&&(!result.accuracyGatePassed||result.regression&&!result.regression.withinFivePercent))process.exitCode=2;
}
main().catch((error: unknown) => {
 const code = error instanceof Error ? error.message : '';
 const detail = code === 'intent_eval_baseline_provenance_mismatch'
  ? 'Baseline musí mať rovnaký druh pozorovaní, poskytovateľa a model.'
  : code === 'intent_eval_baseline_prompt_version_conflict'
    ? 'Rovnaká verzia promptu má rozdielne odtlačky. Over verziu pred porovnaním.'
    : 'Over argumenty, odtlačky datasetu a promptu, formát súborov a voľný výstupný názov.';
 process.stderr.write(`Vyhodnotenie sa nepodarilo. ${detail}\n`);
 process.exitCode = 1;
});
