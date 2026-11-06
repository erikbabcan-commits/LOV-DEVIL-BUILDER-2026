import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import 'fake-indexeddb/auto';
import {Workspace} from '../../src/features/workspace/Workspace';
import {useStore} from '../../src/stores/useAppStore';
import {streamAgentEvents,NetworkError} from '../../src/services/ai/client';
vi.mock('../../src/services/ai/client',async original=>({...await original<typeof import('../../src/services/ai/client')>(),streamAgentEvents:vi.fn()}));
const oldScroll=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollTo');
beforeEach(()=>{useStore.getState().newProject();vi.mocked(streamAgentEvents).mockReset();Object.defineProperty(HTMLElement.prototype,'scrollTo',{value:vi.fn(),configurable:true});useStore.setState({model:'AI (Mistral)',edEditing:false});});
afterEach(()=>{cleanup();useStore.getState().newProject();if(oldScroll)Object.defineProperty(HTMLElement.prototype,'scrollTo',oldScroll);else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;});
function answer(){vi.mocked(streamAgentEvents).mockImplementation(async function*(){yield{type:'run_started',runId:'question',model:'fixture'};yield{type:'intent_selected',intent:'explain'};yield{type:'text_delta',delta:'Tlačidlo je sivé, '};yield{type:'text_delta',delta:'pretože je vypnuté.'};yield{type:'done',runId:'question',summary:'Answered'};});}
describe('read-only AI chat',()=>{
 it('joins streamed text, finishes without review and preserves all source state',async()=>{
  const snapshot=useStore.getState().createSnapshot('manual','existing','<main>Current</main>');useStore.setState({liveId:snapshot.id,vfs:{[snapshot.id]:[{name:'src/App.tsx',content:'export {};',modified:false}]}});
  const before=JSON.stringify({snapshots:useStore.getState().snapshots,vfs:useStore.getState().vfs});answer();await useStore.getState().generateWithAi('Prečo je sivé?','auto');
  expect(useStore.getState().messages.at(-1)).toMatchObject({text:'Tlačidlo je sivé, pretože je vypnuté.',done:true});expect(useStore.getState().pendingReview).toBeNull();expect(JSON.stringify({snapshots:useStore.getState().snapshots,vfs:useStore.getState().vfs})).toBe(before);
 });
 it('submits the workspace composer in automatic mode rather than forcing generation',async()=>{
  answer();render(<Workspace/>);fireEvent.change(screen.getByRole('textbox',{name:'Popíš zmenu'}),{target:{value:'Vysvetli mi tlačidlo'}});fireEvent.click(screen.getByRole('button',{name:'Odoslať (Ctrl+Enter)'}));await waitFor(()=>expect(vi.mocked(streamAgentEvents)).toHaveBeenCalledOnce());expect(vi.mocked(streamAgentEvents).mock.calls[0][0].mode).toBe('auto');
  await screen.findByText('Tlačidlo je sivé, pretože je vypnuté.');expect(screen.queryByRole('region',{name:'Navrhované zmeny'})).not.toBeInTheDocument();
 });
 it('re-runs a question through the chosen AI route and never starts an Instant Draft template',async()=>{
  useStore.setState({messages:[{id:'u',role:'user',text:'Prečo je sivé?'},{id:'a',role:'assistant',text:'Predošlá odpoveď',done:true},{id:'u2',role:'user',text:'Pridaj funkciu'},{id:'a2',role:'assistant',text:'Neskoršia odpoveď',done:true}]});answer();render(<Workspace/>);fireEvent.click(screen.getAllByRole('button',{name:'↻ Re-run'})[0]);await waitFor(()=>expect(vi.mocked(streamAgentEvents)).toHaveBeenCalledOnce());expect(vi.mocked(streamAgentEvents).mock.calls[0][0]).toMatchObject({mode:'auto',prompt:'Prečo je sivé?'});expect(useStore.getState().snapshots).toHaveLength(0);
 });
 it('copies the actual answer and keeps clipboard failures visible',async()=>{
  useStore.setState({messages:[{id:'a',role:'assistant',text:'Plain answer',done:true}]});const previous=Object.getOwnPropertyDescriptor(navigator,'clipboard'),writeText=vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
  try{render(<Workspace/>);fireEvent.click(screen.getByRole('button',{name:'⧉ Kopírovať'}));await waitFor(()=>expect(writeText).toHaveBeenCalledWith('Plain answer'));await waitFor(()=>expect(useStore.getState().toasts.some(t=>t.msg==='Odpoveď skopírovaná')).toBe(true));
   writeText.mockRejectedValue(new Error('private failure'));fireEvent.click(screen.getByRole('button',{name:'⧉ Kopírovať'}));await waitFor(()=>expect(useStore.getState().toasts.some(t=>t.msg.includes('Prehliadač nepovolil'))).toBe(true));
  }finally{if(previous)Object.defineProperty(navigator,'clipboard',previous);else Reflect.deleteProperty(navigator,'clipboard');}
 });
 it('retains a partial answer as incomplete after a network interruption',async()=>{
  vi.mocked(streamAgentEvents).mockImplementation(async function*(){yield{type:'run_started',runId:'network',model:'fixture'};yield{type:'intent_selected',intent:'explain'};yield{type:'text_delta',delta:'Partial explanation'};throw new NetworkError(true);});
  await useStore.getState().generateWithAi('Explain','auto');expect(useStore.getState().messages.at(-1)?.text).toContain('Partial explanation');expect(useStore.getState().messages.at(-1)?.text).toContain('neúplná');expect(useStore.getState().pendingReview).toBeNull();
 });
 it('keeps a partial answer explicitly incomplete on cancellation without proposing changes',async()=>{
  vi.mocked(streamAgentEvents).mockImplementation(async function*(_input,signal){yield{type:'run_started',runId:'cancel',model:'fixture'};yield{type:'intent_selected',intent:'explain'};yield{type:'text_delta',delta:'Čiastočná odpoveď.'};signal.throwIfAborted();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
  const work=useStore.getState().generateWithAi('Vysvetli','auto');await waitFor(()=>expect(useStore.getState().messages.at(-1)?.text).toBe('Čiastočná odpoveď.'));useStore.getState().cancelAiRun();await work;
  expect(useStore.getState().messages.at(-1)?.text).toContain('zastavená');expect(useStore.getState().pendingReview).toBeNull();expect(useStore.getState().generating).toBe(false);
 });
});
