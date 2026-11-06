import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { changedFiles, lineDiff, parentOf, snapshotSources } from '../../src/lib/projectDiff';
import { ProjectDiff } from '../../src/features/workspace/ProjectDiff';
import { useStore, type Snapshot } from '../../src/stores/useAppStore';
import 'fake-indexeddb/auto';
const snap = (id: string, v: number, files: {name:string;content:string}[]): Snapshot => ({id,v,html:'same html',sourceFiles:JSON.stringify(files),prompt:id,kind:'manual',time:'now'});
afterEach(() => { cleanup(); useStore.getState().newProject(); });

describe('project file comparison', () => {
  it('finds React edits, added empty files and deletions despite identical HTML', () => {
    expect(changedFiles([{name:'src/App.tsx',content:'old'},{name:'gone',content:''}], [{name:'src/App.tsx',content:'new'},{name:'empty',content:''}])).toEqual([
      {path:'empty',before:undefined,after:'',status:'added'}, {path:'gone',before:'',after:undefined,status:'deleted'}, {path:'src/App.tsx',before:'old',after:'new',status:'modified'},
    ]);
  });
  it('retains order, duplicate lines, removals and both line numbers', () => {
    const result = lineDiff('a\nb\na\nc', 'a\na\nb\nc');
    expect(result.lines.filter(line=>line.kind!=='context').map(line=>[line.kind,line.text])).toEqual([['delete','b'],['add','b']]);
    expect(result.lines.at(-1)).toMatchObject({oldLine:4,newLine:4});
  });
  it('reconstructs both originals over deterministic repeated-line cases', () => {
    let seed=17;
    const next=()=> {seed=(seed*1664525+1013904223)>>>0;return seed;};
    for(let k=0;k<100;k++) {
      const a=Array.from({length:1+next()%30},()=>String(next()%5)).join('\n');
      const b=Array.from({length:1+next()%30},()=>String(next()%5)).join('\n');
      const {lines}=lineDiff(a,b);
      expect(lines.filter(line=>line.kind!=='add').map(line=>line.text).join('\n')).toBe(a);
      expect(lines.filter(line=>line.kind!=='delete').map(line=>line.text).join('\n')).toBe(b);
    }
  });
  it('bounds work for large changes without dropping lines', () => {
    const a=Array.from({length:1000},(_,i)=>'old'+i).join('\n');
    const b=Array.from({length:1000},(_,i)=>'new'+i).join('\n');
    const result=lineDiff(a,b);
    expect(result.coarse).toBe(true); expect(result.lines).toHaveLength(2000);
    expect(result.lines.filter(line=>line.kind==='add')).toHaveLength(1000);
  });
  it('reads persisted sources and legacy HTML, and reports corrupt sources', () => {
    const a=snap('a',1,[{name:'src/App.tsx',content:'a'}]);
    expect(snapshotSources(a,{})).toEqual([{name:'src/App.tsx',content:'a'}]);
    expect(snapshotSources({...a,sourceFiles:undefined},{})).toEqual([{name:'index.html',content:'same html'}]);
    expect(snapshotSources({...a,sourceFiles:'broken'},{})).toBeNull();
    expect(snapshotSources({...a,sourceFiles:'[]'},{})).toEqual([]);
  });
  it('follows actual ancestry after restore, retaining it across IndexedDB reload', async () => {
    const store=useStore.getState();store.newProject();
    const a=store.createSnapshot('manual','a','a');useStore.setState({liveId:a.id,liveHtml:a.html});
    const b=store.createSnapshot('manual','b','b');useStore.setState({liveId:b.id,liveHtml:b.html});
    store.restoreSnapshot(a.id);
    store.manualSnapshot();
    const c=useStore.getState().snapshots.at(-1)!;
    expect(c.parentId).toBe(a.id);expect(parentOf(useStore.getState().snapshots,c)?.id).toBe(a.id);
    await useStore.getState().persistNow();useStore.setState({snapshots:[],vfs:{},liveId:null});
    await useStore.getState().restoreFromDb();
    expect(useStore.getState().snapshots.find(item=>item.id===c.id)?.parentId).toBe(a.id);
  });
  it('compares the viewed version and switches versions and files through real controls', () => {
    const a=snap('first',1,[{name:'src/App.tsx',content:'old'}]);
    const b={...snap('second',2,[{name:'src/App.tsx',content:'new'},{name:'new.txt',content:'<script>unsafe</script>'}]),parentId:a.id};
    const c={...snap('third',3,[{name:'src/App.tsx',content:'later'}]),parentId:b.id};
    useStore.setState({snapshots:[a,b,c],liveId:c.id,viewing:b,vfs:{}});
    render(<ProjectDiff/>);
    expect(screen.getByLabelText('Nová verzia')).toHaveValue(b.id);
    expect(screen.getByLabelText('Pôvodná verzia')).toHaveValue(a.id);
    fireEvent.change(screen.getByLabelText('Súbor'),{target:{value:'src/App.tsx'}});
    expect(screen.getByRole('region',{name:'Zmeny v src/App.tsx'})).toHaveTextContent('old');
    expect(screen.getByRole('region',{name:'Zmeny v src/App.tsx'})).toHaveTextContent('new');
    fireEvent.change(screen.getByLabelText('Súbor'),{target:{value:'new.txt'}});
    expect(screen.getByRole('region',{name:'Zmeny v new.txt'}).querySelector('script')).toBeNull();
    fireEvent.change(screen.getByLabelText('Pôvodná verzia'),{target:{value:b.id}});
    expect(screen.getByRole('status')).toHaveTextContent('rovnaký obsah');
    fireEvent.change(screen.getByLabelText('Nová verzia'),{target:{value:c.id}});
    expect(screen.getByLabelText('Pôvodná verzia')).toHaveValue(b.id);
  });
  it('does not present a missing parent as an empty base', () => {
    const a={...snap('a',1,[]),parentId:'missing'};
    useStore.setState({snapshots:[a],liveId:a.id,viewing:null,vfs:{}});
    render(<ProjectDiff/>);expect(screen.getByRole('alert')).toHaveTextContent('nie sú dostupné');
  });
});
