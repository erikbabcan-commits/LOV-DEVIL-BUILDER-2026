import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {AiModelMenu} from '../../src/components/AiModelMenu';
import {useStore} from '../../src/stores/useAppStore';
import {streamAgentEvents} from '../../src/services/ai/client';
vi.mock('../../src/services/ai/client',async importOriginal=>({...await importOriginal<typeof import('../../src/services/ai/client')>(),streamAgentEvents:vi.fn()}));
const catalog={defaultId:'mistral',models:[{id:'mistral',label:'AI (Mistral)',provider:'mistral',model:'configured-mistral',fallbackIds:['openai']},{id:'openai',label:'AI (OpenAI)',provider:'openai',model:'configured-openai',fallbackIds:[]}]};
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();useStore.setState({model:'Instant Draft',aiModelId:undefined,aiFallbackIds:[],generating:false,pendingReview:null,aiAbort:null,messages:[],snapshots:[],vfs:{}});});
describe('real server-backed model choice',()=>{
  it('shows only server models and binds backup consent to exact recipients',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(catalog)));render(<AiModelMenu open/>);
    fireEvent.click(await screen.findByRole('button',{name:/AI \(Mistral\)/}));expect(useStore.getState()).toMatchObject({model:'AI (Mistral)',aiModelId:'mistral',aiFallbackIds:[]});
    const backup=screen.getByRole('checkbox',{name:'Povoliť záložné modely'});fireEvent.click(backup);expect(useStore.getState().aiFallbackIds).toEqual(['openai']);
    expect(screen.getByText(/Kontext sa môže odoslať aj do/)).toHaveTextContent('AI (OpenAI)');
    fireEvent.click(screen.getByRole('button',{name:/AI \(OpenAI\)/}));expect(useStore.getState()).toMatchObject({aiModelId:'openai',aiFallbackIds:[]});
  });
  it('keeps Instant Draft available and does not invent an AI model during catalog failure',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:503})));render(<AiModelMenu open/>);
    await screen.findByText('Ponuku AI modelov sa nepodarilo načítať.');expect(screen.queryByRole('button',{name:/AI \(Mistral\)/})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:/Instant Draft/})).toBeEnabled();
  });
  it('ignores a catalog response from a closed menu',async()=>{
    let finish!:(value:Response)=>void;const fetch=vi.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetch);
    const view=render(<AiModelMenu open/>);view.rerender(<AiModelMenu open={false}/>);finish(Response.json(catalog));await Promise.resolve();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);expect(screen.queryByRole('button',{name:/AI \(Mistral\)/})).not.toBeInTheDocument();
  });
  it('clears stale backup consent when the configured recipients change',async()=>{
    useStore.setState({model:'AI (Mistral)',aiModelId:'mistral',aiFallbackIds:['removed-provider']});vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(catalog)));render(<AiModelMenu open/>);
    await screen.findByRole('checkbox',{name:'Povoliť záložné modely'});await waitFor(()=>expect(useStore.getState().aiFallbackIds).toEqual([]));
  });
  it('submits selected model and exact backup snapshot without falling into template generation',async()=>{
    useStore.setState({model:'AI (OpenAI)',aiModelId:'openai',aiFallbackIds:['mistral'],generating:false,pendingReview:null,edEditing:false,messages:[],snapshots:[],vfs:{}});
    vi.mocked(streamAgentEvents).mockImplementation(async function*(){yield{type:'error',code:'synthetic',message:'Synthetic final error',retriable:false};});
    await useStore.getState().generateWithAi('Build a small page','create');
    expect(vi.mocked(streamAgentEvents).mock.calls.at(-1)?.[0]).toMatchObject({modelId:'openai',allowFallback:true,fallbackIds:['mistral']});
  });
});
