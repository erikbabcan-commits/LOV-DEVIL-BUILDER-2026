// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {materializePatch,sourceHash,PatchError,applyTextEdits,requestPatch} from '../../../server/agent/patches';
import {GenerateRequestSchema,type AgentEvent} from '../../../server/agent/schemas';
import {parseAgentRequest,runAgent} from '../../../server/agent/run';
import {makeMockProvider} from '../../../server/index';
import type {AIProvider} from '../../../server/providers/types';
const files=[{path:'src/index.css',content:'/* zachovaj 🌍 */\r\n.primary { background: #2563eb; color: white; }\r\n.secondary { background: gray; }\r\n'},{path:'src/App.tsx',content:'export default function App(){return <button className="primary">Create</button>;}'},{path:'src/keep.ts',content:'export const keep=true;'}];
const modify=(over:Record<string,unknown>={})=>({path:files[0].path,action:'modify',beforeSha256:sourceHash(files[0].content),edits:[{search:'#2563eb',replace:'#dc2626'}],...over});
const envelope=(changes:unknown[]=[modify()])=>({version:1,summary:'Mení sa iba farba hlavného tlačidla.',changes});
const req=()=>GenerateRequestSchema.parse({projectId:'patch',prompt:'Zmeň farbu hlavného tlačidla na červenú.',mode:'iterate',context:{files,history:[]}});
const plan={summary:'Jedna farba',steps:[{id:'color',title:'Uprav farbu'}],filesPlanned:['src/index.css']};
async function events(p:AIProvider,request:unknown=req()){const result:AgentEvent[]=[];for await(const e of runAgent(request,{runId:'patch-run',provider:p,maxFiles:40}))result.push(e);return result;}
describe('exact source-bound patches',()=>{
 it('materializes one CSS edit while preserving Unicode, CRLF and every unrelated byte/file',()=>{
  const original=JSON.stringify(files),result=materializePatch(files,envelope(),plan.filesPlanned);expect(result.files).toEqual([{path:'src/index.css',content:files[0].content.replace('#2563eb','#dc2626'),action:'modify'}]);expect(JSON.stringify(files)).toBe(original);expect(result.files[0].content).toContain('🌍 */\r\n');
 });
 it('applies independent ranges against original offsets, regardless of model order',()=>{
  expect(applyTextEdits('before RED middle BLUE after',[{search:'BLUE',replace:'GREEN-LONG'},{search:'RED',replace:'R'}])).toBe('before R middle GREEN-LONG after');
 });
 it('rejects split emoji ranges and lone surrogates instead of corrupting UTF-8 source',()=>{
  expect(()=>applyTextEdits('A🌍B',[{search:'\ud83c',replace:'X'}])).toThrow(PatchError);
  expect(()=>applyTextEdits('A🌍B',[{search:'🌍',replace:'\udf0d'}])).toThrow(PatchError);
  expect(()=>materializePatch([{...files[0],content:'broken\ud800'}],envelope(),plan.filesPlanned)).toThrow(PatchError);
  expect(()=>materializePatch(files,envelope([{path:'src/new.ts',action:'create',content:'broken\udfff'}]),['src/new.ts'])).toThrow(PatchError);
  expect(applyTextEdits('A🌍B\r\n',[{search:'🌍',replace:'🌎'}])).toBe('A🌎B\r\n');
 });
 it.each([
  {beforeSha256:'0'.repeat(64)},
  {edits:[{search:'missing',replace:'x'}]},
  {edits:[{search:'background',replace:'foreground'}]},
  {edits:[{search:'#2563eb',replace:'#2563eb'}]},
  {edits:[{search:'background: #2563eb',replace:'x'},{search:'#2563eb',replace:'y'}]},
 ])('refuses stale, missing, ambiguous, no-op or overlapping edits atomically',over=>{expect(()=>materializePatch(files,envelope([modify(over)]),plan.filesPlanned)).toThrow(PatchError);expect(files[0].content).toContain('#2563eb');});
 it('rejects duplicate, unsafe and unplanned paths or a full-file generator response',()=>{
  for(const value of [envelope([modify(),modify()]),envelope([modify({path:'../../secrets'})]),envelope([modify({path:'src/unplanned.ts'})]),{files:[{path:'src/index.css',content:'rewritten',action:'modify'}]}])expect(()=>materializePatch(files,value,plan.filesPlanned)).toThrow(PatchError);
 });
 it('rejects bulk replacement of a large existing file rather than disguising regeneration as an edit',()=>{
  const big=[{path:'src/index.css',content:'/* keep */\n'.repeat(200)+'#2563eb'}];expect(()=>materializePatch(big,envelope([{...modify(),beforeSha256:sourceHash(big[0].content),edits:[{search:big[0].content,replace:'rewritten'}]}]),plan.filesPlanned)).toThrow(PatchError);
 });
 it('supports empty files, new files and deleting an existing file with an exact before hash',()=>{
  const changes=[{path:'src/keep.ts',action:'delete',beforeSha256:sourceHash(files[2].content)},{path:'src/new.ts',action:'create',content:''},modify()];
  expect(materializePatch(files,envelope(changes),changes.map(c=>c.path)).files).toEqual([{path:'src/keep.ts',content:'',action:'delete'},{path:'src/new.ts',content:'',action:'create'},{path:'src/index.css',content:files[0].content.replace('#2563eb','#dc2626'),action:'modify'}]);
 });
 it('allows only existing safe legacy root sources and refuses deleting the whole project',()=>{
  const legacy=[{path:'styles.css',content:'.btn{color:blue}'},{path:'app.js',content:'console.log("hello")'}];
  expect(materializePatch(legacy,envelope([{path:'styles.css',action:'modify',beforeSha256:sourceHash(legacy[0].content),edits:[{search:'blue',replace:'red'}]}]),['styles.css']).files[0].content).toBe('.btn{color:red}');
  expect(()=>materializePatch([files[2]],envelope([{path:files[2].path,action:'delete',beforeSha256:sourceHash(files[2].content)}]),[files[2].path])).toThrow(PatchError);
 });
 it('rejects secrets and final project size/count overflow before any staged result',()=>{
  const canary='sk-'+'A'.repeat(24);expect(()=>materializePatch(files,envelope([modify({edits:[{search:'#2563eb',replace:canary}]})]),plan.filesPlanned)).toThrow(PatchError);
  expect(()=>materializePatch(files,envelope([modify({edits:[{search:'#2563eb',replace:'x'.repeat(200000)}]})]),plan.filesPlanned)).toThrow(PatchError);
  const many=Array.from({length:40},(_,i)=>({path:'src/f'+i+'.ts',content:'export {};'}));expect(()=>materializePatch(many,envelope([{path:'src/new.ts',action:'create',content:'export {};'}]),['src/new.ts'])).toThrow(PatchError);
 });
 it('rejects duplicate input paths before provider calls and HTTP admission',()=>{const body=req();body.context.files.push({...files[0]});expect(parseAgentRequest(body)).toMatchObject({ok:false,error:{code:'bad_request'}});});
 it('uses the patch protocol for iterate/fix and stages materialized files only after validation',async()=>{
  for(const mode of ['iterate','fix'] as const){const p=makeMockProvider(),complete=vi.spyOn(p,'complete').mockResolvedValueOnce({text:JSON.stringify(plan),usage:{promptTokens:1,completionTokens:1}}).mockResolvedValueOnce({text:JSON.stringify(envelope()),usage:{promptTokens:1,completionTokens:1}});
   const result=await events(p,{...req(),mode});expect(result.at(-1)?.type).toBe('done');expect(complete).toHaveBeenCalledTimes(2);expect(complete.mock.calls[1][0][0].content).toContain('Forge Patch Editor');
   const body=JSON.parse(complete.mock.calls[1][0][1].content);expect(body.files[0].sha256).toBe(sourceHash(files[0].content));expect(body.plannedFiles).toEqual(['src/index.css']);expect(result.find(e=>e.type==='stage')).toMatchObject({editMode:'patch',summary:envelope().summary,files:[{path:'src/index.css',action:'modify'}]});
  }
 });
 it('never regenerates or retries a conflicted or malformed patch',async()=>{
  for(const response of [JSON.stringify(envelope([modify({beforeSha256:'0'.repeat(64)})])),'invalid private-model-response']){const p=makeMockProvider(),complete=vi.spyOn(p,'complete').mockResolvedValueOnce({text:JSON.stringify(plan),usage:{promptTokens:1,completionTokens:1}}).mockResolvedValueOnce({text:response,usage:{promptTokens:1,completionTokens:1}});const result=await events(p);expect(complete).toHaveBeenCalledTimes(2);expect(result.some(e=>e.type==='stage')).toBe(false);expect(result.at(-1)?.type).toBe('error');expect(JSON.stringify(result)).not.toContain('private-model-response');}
 });
 it('does not send another request for an invalid plan or truncated patch',async()=>{
  const p=makeMockProvider(),complete=vi.spyOn(p,'complete').mockResolvedValue({text:JSON.stringify(envelope()),finishReason:'length',usage:{promptTokens:1,completionTokens:1}});await expect(requestPatch(p,req(),plan)).rejects.toBeInstanceOf(PatchError);expect(complete).toHaveBeenCalledOnce();await expect(requestPatch(p,req(),{...plan,filesPlanned:[]})).rejects.toBeInstanceOf(PatchError);expect(complete).toHaveBeenCalledOnce();
 });
});
