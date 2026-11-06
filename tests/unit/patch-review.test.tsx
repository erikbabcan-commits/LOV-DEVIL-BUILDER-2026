import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import 'fake-indexeddb/auto';
import {useStore,captureReviewBase} from '../../src/stores/useAppStore';
import {ReviewPanel} from '../../src/features/workspace/ReviewPanel';
import {ProjectDiff} from '../../src/features/workspace/ProjectDiff';
import {applyFileOperations} from '../../src/lib/projectChanges';
const files=[{name:'src/index.css',content:'.primary { background: #2563eb; }',modified:false},{name:'src/App.tsx',content:'export default function App(){return <button className="primary">Create</button>}',modified:false}];
const originalSandbox=useStore.getState().runSandbox;
beforeEach(()=>{useStore.getState().newProject();const snapshot=useStore.getState().createSnapshot('ai','Original','<main>Original</main>');useStore.setState({liveId:snapshot.id,snapshots:[{...snapshot,sourceFiles:JSON.stringify(files)}],vfs:{[snapshot.id]:files.map(f=>({...f}))},runSandbox:vi.fn().mockResolvedValue(undefined)});
 const state=useStore.getState();useStore.setState({pendingReview:{runId:'patch-proposal',prompt:'Change button colour',source:'patch',summary:'Iba hlavné tlačidlo.',base:captureReviewBase(state),files:[{path:'src/index.css',content:files[0].content.replace('#2563eb','#dc2626'),action:'modify'}]}});
});
afterEach(()=>{cleanup();useStore.setState({runSandbox:originalSandbox});useStore.getState().newProject();});
describe('source-bound review and proposal diff',()=>{
 it('shows real before/after before approval without mutating source files',()=>{
  const before=JSON.stringify(useStore.getState().vfs);render(<ProjectDiff/>);const region=screen.getByRole('region',{name:'Rozdiel navrhovaných zmien'});expect(region).toHaveTextContent('Zmenené súbory: 1');
  expect(within(region).getByRole('combobox',{name:'Súbor návrhu'}).querySelectorAll('option')).toHaveLength(1);expect(within(region).getByRole('region',{name:'Zmeny v src/index.css'})).toHaveTextContent('#2563eb');expect(region).toHaveTextContent('#dc2626');expect(JSON.stringify(useStore.getState().vfs)).toBe(before);expect(useStore.getState().snapshots).toHaveLength(1);
 });
 it('approves exactly once, preserves the old snapshot and exposes the applied historical diff',()=>{
  const old=useStore.getState().snapshots[0];render(<><ReviewPanel/><ProjectDiff/></>);fireEvent.click(screen.getByRole('button',{name:'Použiť zmeny'}));const current=useStore.getState();expect(current.snapshots).toHaveLength(2);expect(current.snapshots[0]).toEqual(old);expect(current.snapshots[1].parentId).toBe(old.id);expect(current.vfs[current.liveId!][1].content).toBe(files[1].content);expect(current.vfs[current.liveId!][0].content).toContain('#dc2626');expect(current.approveStagedRun()).toBe(false);expect(screen.getByRole('region',{name:'Porovnanie súborov'})).toHaveTextContent('Zmenené súbory: 1');
 });
 it('blocks approval after an edit beyond the captured source and never shows a false diff',()=>{
  const state=useStore.getState();useStore.setState({vfs:{...state.vfs,[state.liveId!]:files.map(f=>({...f,content:f.content+'\n// later edit'}))}});render(<><ReviewPanel/><ProjectDiff/></>);expect(screen.getByRole('button',{name:'Použiť zmeny'})).toBeDisabled();expect(screen.getAllByRole('alert').some(node=>node.textContent?.includes('Projekt sa od návrhu zmenil'))).toBe(true);expect(screen.queryByRole('region',{name:'Zmeny v src/index.css'})).not.toBeInTheDocument();expect(useStore.getState().snapshots).toHaveLength(1);
 });
 it('moves mobile review to Diff and returns to approval without consuming the proposal',()=>{
  render(<><ReviewPanel/><ProjectDiff/></>);fireEvent.click(screen.getByRole('button',{name:'Skontrolovať rozdiel'}));expect(useStore.getState()).toMatchObject({tab:'diff',mview:'canvas'});fireEvent.click(screen.getByRole('button',{name:'Späť ku schváleniu'}));expect(useStore.getState().mview).toBe('chat');expect(useStore.getState().pendingReview?.runId).toBe('patch-proposal');
 });
 it('can inspect saved history and return to the current proposal',()=>{
  render(<ProjectDiff/>);fireEvent.click(screen.getByRole('button',{name:'Zobraziť uložené verzie'}));expect(screen.getByRole('region',{name:'Porovnanie súborov'})).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Pozrieť navrhované zmeny'}));expect(screen.getByRole('region',{name:'Rozdiel navrhovaných zmien'})).toHaveTextContent('#dc2626');
 });
 it('rejects without changing either source snapshot and shares delete/create semantics with approval',()=>{
  const before=JSON.stringify(useStore.getState().vfs);render(<ReviewPanel/>);fireEvent.click(screen.getByRole('button',{name:'Odmietnuť'}));expect(JSON.stringify(useStore.getState().vfs)).toBe(before);expect(useStore.getState().pendingReview).toBeNull();
  expect(applyFileOperations(files,[{path:'src/index.css',content:'',action:'delete'},{path:'src/new.ts',content:'',action:'create'}],true)?.map(f=>f.name)).toEqual(['src/App.tsx','src/new.ts']);expect(applyFileOperations(files,[{path:'src/absent.ts',content:'x',action:'modify'}],true)).toBeNull();
 });
});
