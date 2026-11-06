import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import 'fake-indexeddb/auto';
import {useStore} from '../../src/stores/useAppStore';
import {BuildRepairAction} from '../../src/features/workspace/BuildRepairAction';
import {ProjectDiff} from '../../src/features/workspace/ProjectDiff';
import {ReviewPanel} from '../../src/features/workspace/ReviewPanel';
import {BUILD_REPAIR_FILES} from '../fixtures/buildRepairProject';
import {PATCH_PROJECT_FILES} from '../fixtures/patchProject';
const originalSandbox=useStore.getState().runSandbox;
const result=(over:Record<string,unknown>={})=>({ok:true,attempts:1,patchesApplied:1,summary:'Iba syntax chyba.',finalFiles:PATCH_PROJECT_FILES,buildErrors:[],...over});
beforeEach(()=>{
 useStore.getState().newProject();const snap=useStore.getState().createSnapshot('ai','Broken','<main>Original</main>');
 useStore.setState({liveId:snap.id,snapshots:[{...snap,sourceFiles:JSON.stringify(BUILD_REPAIR_FILES.map(f=>({name:f.path,content:f.content})))}],vfs:{[snap.id]:BUILD_REPAIR_FILES.map(f=>({name:f.path,content:f.content,modified:false}))},aiModelId:'mistral',aiFallbackIds:['openai'],sandboxErrors:[{file:'src/App.tsx',message:'Syntax error'}],runSandbox:vi.fn().mockResolvedValue(undefined)});
});
afterEach(()=>{cleanup();useStore.getState().cancelAiRun();useStore.setState({runSandbox:originalSandbox});useStore.getState().newProject();vi.unstubAllGlobals();});
describe('explicit build repair with immutable review',()=>{
 it('sends selected models and complete files, reviews the verified diff, then approves once',async()=>{
  const fetch=vi.fn().mockResolvedValue(Response.json(result()));vi.stubGlobal('fetch',fetch);const old=useStore.getState().snapshots[0],before=JSON.stringify(useStore.getState().vfs);
  render(<><BuildRepairAction/><ProjectDiff/><ReviewPanel/></>);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Navrhnúť AI opravu'}));});
  expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0][0]).toContain('/api/sandbox/autofix');expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({files:BUILD_REPAIR_FILES,modelId:'mistral',allowFallback:true,fallbackIds:['openai']});
  expect(JSON.stringify(useStore.getState().vfs)).toBe(before);expect(useStore.getState().runSandbox).not.toHaveBeenCalled();expect(screen.getByRole('region',{name:'Rozdiel navrhovaných zmien'})).toHaveTextContent('Zmenené súbory: 1');expect(useStore.getState().pendingReview?.summary).toContain('prešiel buildom');expect(document.body.dataset.view).toBe('canvas');expect(screen.getByRole('button',{name:'Navrhnúť AI opravu'})).toBeDisabled();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Použiť zmeny'})));
  const state=useStore.getState();expect(state.snapshots).toHaveLength(2);expect(state.snapshots[0]).toEqual(old);expect(state.vfs[state.liveId!].find(f=>f.name==='src/App.tsx')?.content).toBe(PATCH_PROJECT_FILES.find(f=>f.path==='src/App.tsx')!.content);expect(state.approveStagedRun()).toBe(false);expect(state.runSandbox).toHaveBeenCalledOnce();
 });
 it('discards a late successful repair after manual source changes',async()=>{
  let resolve!:(response:Response)=>void;const fetch=vi.fn(()=>new Promise<Response>(done=>{resolve=done;}));vi.stubGlobal('fetch',fetch);const work=useStore.getState().repairSandbox();const state=useStore.getState();useStore.setState({vfs:{...state.vfs,[state.liveId!]:state.vfs[state.liveId!].map(f=>({...f,content:f.content+'\n// later'}))}});const changed=JSON.stringify(useStore.getState().vfs);resolve(Response.json(result()));await work;expect(useStore.getState().pendingReview).toBeNull();expect(JSON.stringify(useStore.getState().vfs)).toBe(changed);expect(useStore.getState().messages.at(-1)?.text).toContain('zahodený');
 });
 it('never stages an unverified candidate and leaves the original source intact',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(result({ok:false,attempts:2}))));const before=JSON.stringify(useStore.getState().vfs);await useStore.getState().repairSandbox();expect(useStore.getState().pendingReview).toBeNull();expect(JSON.stringify(useStore.getState().vfs)).toBe(before);expect(useStore.getState().messages.at(-1)?.text).toContain('neprešla');
 });
 it('does not retry quota errors or expose an invalid response body',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(Response.json({error:'quota_exceeded'},{status:429})).mockResolvedValueOnce(Response.json({private:'UNTRUSTED_DETAIL'}));vi.stubGlobal('fetch',fetch);await useStore.getState().repairSandbox();expect(fetch).toHaveBeenCalledOnce();expect(useStore.getState().messages.at(-1)?.text).toContain('mesačný limit');await useStore.getState().repairSandbox();expect(fetch).toHaveBeenCalledTimes(2);expect(JSON.stringify(useStore.getState().messages)).not.toContain('UNTRUSTED_DETAIL');expect(useStore.getState().pendingReview).toBeNull();
 });
 it('cancels without accepting a provider that resolves after abort',async()=>{
  let resolve!:(response:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(done=>{resolve=done;})));const before=JSON.stringify(useStore.getState().vfs),work=useStore.getState().repairSandbox();useStore.getState().cancelAiRun();resolve(Response.json(result()));await work;expect(useStore.getState().pendingReview).toBeNull();expect(JSON.stringify(useStore.getState().vfs)).toBe(before);expect(useStore.getState().generating).toBe(false);
 });
 it('blocks duplicate actions while reviewing, editing or viewing history',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);for(const gate of [{generating:true},{edEditing:true},{viewing:useStore.getState().snapshots[0]}]){const original={generating:false,edEditing:false,viewing:null};useStore.setState({...original,...gate});await useStore.getState().repairSandbox();expect(fetch).not.toHaveBeenCalled();useStore.setState(original);}
 });
});
