import {afterEach,describe,expect,it,vi} from 'vitest';
import 'fake-indexeddb/auto';
import {conversationContext,useStore} from '../../src/stores/useAppStore';
import {streamAgentEvents} from '../../src/services/ai/client';
import {selectPersistenceScope} from '../../src/services/persistence/projectStore';
import type {AgentEvent} from '../../src/services/ai/types';
vi.mock('../../src/services/ai/client',async original=>({...await original<typeof import('../../src/services/ai/client')>(),streamAgentEvents:vi.fn()}));
afterEach(()=>{selectPersistenceScope({kind:'pilot'});useStore.getState().newProject();vi.restoreAllMocks();});
const prepared:AgentEvent[]=[{type:'run_started',runId:'run-one',model:'mock'},{type:'validation',result:{ok:true,errors:[]}},{type:'stage',files:[{path:'src/App.tsx',content:'export {};',action:'create'}]},{type:'done',runId:'run-one',summary:'Ready'}];
describe('chat context and review outcome',()=>{
 it('sends previous turns and full current files, excluding the newly added prompt and its empty assistant',async()=>{
  useStore.setState({projectId:'context-fixture',messages:[{id:'old',role:'user',text:'Brand Acme'}],edEditing:false,generating:false,pendingReview:null});
  vi.mocked(streamAgentEvents).mockImplementation(async function*(){yield{type:'error',code:'fixture',message:'Synthetic terminal',retriable:false};});
  await useStore.getState().generateWithAi('Newest request','iterate');
  expect(vi.mocked(streamAgentEvents).mock.calls.at(-1)?.[0].context.conversation).toEqual([{role:'user',content:'Brand Acme'}]);
 });
 it('does not confuse pending or rejected proposals with applied code, and allows the next run after review',async()=>{
  useStore.getState().newProject();
  vi.mocked(streamAgentEvents).mockImplementation(async function*(){yield*prepared;});
  await useStore.getState().generateWithAi('Add a page','create');expect(useStore.getState().pendingReview?.runId).toBe('run-one');
  expect(conversationContext(useStore.getState().messages).at(-1)?.content).toContain('aplikovanie sa tým nepotvrdilo');
  useStore.getState().rejectStagedRun();expect(useStore.getState().messages.at(-1)?.text).toContain('Návrh odmietnutý');expect(useStore.getState().snapshots).toHaveLength(0);
  await useStore.getState().generateWithAi('Try a different page','create');expect(useStore.getState().pendingReview).not.toBeNull();expect(useStore.getState().approveStagedRun()).toBe(true);
  expect(useStore.getState().messages.at(-1)?.text).toContain('Zmeny sú v aktuálnom projekte');expect(useStore.getState().snapshots).toHaveLength(1);
 });
 it('persists a chat-only project and restores it only within its own account scope',async()=>{
  selectPersistenceScope({kind:'account',userId:'context-alice-'+crypto.randomUUID()});useStore.getState().newProject();useStore.getState().addMsg('user','Brand Acme');await useStore.getState().persistNow();
  useStore.setState({messages:[]});await useStore.getState().restoreFromDb();expect(useStore.getState().messages.map(m=>m.text)).toEqual(['Brand Acme']);expect(useStore.getState().mode).toBe('work');expect(document.body.dataset.mode).toBe('work');
  selectPersistenceScope({kind:'account',userId:'context-bob-'+crypto.randomUUID()});useStore.getState().newProject();await useStore.getState().restoreFromDb();expect(useStore.getState().messages).toEqual([]);
 });
});
