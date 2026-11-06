// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import { autofixLoop as runAutofix } from '../../../server/agent/autofix';
import { HostExecutor } from '../../../server/sandbox/executor';
import type { AIProvider } from '../../../server/providers/types';
import * as sandbox from '../../../server/sandbox/builder';
import { containsPotentialSecret } from '../../../server/security/secrets';
import {sourceHash} from '../../../server/agent/patches';
const host = new HostExecutor();
const autofixLoop: typeof runAutofix = (provider, files, opts) => runAutofix(provider, files, { ...opts, executor: host });

/* Step 4: AUTOFIX — bounded repair loop s mock providerom (deterministické CI). */

function mockFixingProvider(): AIProvider {
  return {
    name: 'mock-fix',
    model: 'mock-fix',
    async complete(messages) {
      /* AI vráti opravený main.tsx (syntax chyba → validný kód) */
      return {
        text: JSON.stringify({
          version:1,summary:'Opravená syntax vstupného súboru.',changes: [
            { path: 'src/main.tsx',action:'modify',beforeSha256:JSON.parse(messages[1].content).files.find((f:{path:string})=>f.path==='src/main.tsx').sha256,edits:[{search:'const x = {',replace:'import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<h1>FIXED</h1>);'}] },
          ],
        }),
        usage: { promptTokens: 10, completionTokens: 50 },
      };
    },
    async *stream() { yield { delta: '' }; },
  };
}

function mockUselessProvider(): AIProvider {
  return {
    name: 'mock-bad',
    model: 'mock-bad',
    async complete() {
      return { text: 'blbosť bez json', usage: { promptTokens: 0, completionTokens: 0 } };
    },
    async *stream() { yield { delta: '' }; },
  };
}

const brokenFiles = [
  { path: 'package.json', content: JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }) },
  { path: 'src/main.tsx', content: 'const x = {' }, // syntax chyba
];

afterEach(() => vi.restoreAllMocks());

describe('AUTOFIX (Step 4)', () => {
  it('build chyba → AI patch → rebuild úspešný v 1 pokuse', async () => {
    const r = await autofixLoop(mockFixingProvider(), brokenFiles);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.patchesApplied).toBe(1);
    expect(r.buildErrors.length).toBe(1); // z prvého buildu
    /* finálne súbory sú opravené */
    const main = r.finalFiles.find(f => f.path === 'src/main.tsx');
    expect(main?.content).toContain('FIXED');
    expect(r.history.some(h => h.phase === 'done')).toBe(true);
  });

  it('AI nevie opraviť → max 2 pokusy, ok=false, explicitné chyby', async () => {
    const r = await autofixLoop(mockUselessProvider(), brokenFiles);
    expect(r.ok).toBe(false);
    expect(r.attempts).toBeLessThanOrEqual(2);
    expect(r.buildErrors.length).toBeGreaterThan(0);
    expect(r.history.some(h => h.message.includes('AI patch zlyhal'))).toBe(true);
  });

  it('už fungujúci build → 0 pokusov, ok=true', async () => {
    const goodFiles = [
      { path: 'src/main.tsx', content: 'import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<h1>OK</h1>);' },
    ];
    const r = await autofixLoop(mockFixingProvider(), goodFiles);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(0);
    expect(r.patchesApplied).toBe(0);
  });

  it('AI patch je minimálny — nemení súbory, ktoré opravovať netreba', async () => {
    const files = [
      ...brokenFiles,
      { path: 'src/App.tsx', content: 'export default function App(){ return <h1> untouched</h1>; }' },
    ];
    const r = await autofixLoop(mockFixingProvider(), files);
    const app = r.finalFiles.find(f => f.path === 'src/App.tsx');
    expect(app?.content).toContain('untouched');
  });

  it('posiela celý zdroj aj za 4000 znakov a zachová Unicode/CRLF mimo chyby',async()=>{
    const original='// zachovaj 🌍\r\n'.repeat(400)+'const x = {',files=[{path:'src/main.tsx',content:original}],provider=mockFixingProvider(),complete=vi.spyOn(provider,'complete');
    const result=await autofixLoop(provider,files);expect(result.ok).toBe(true);expect(result.finalFiles[0].content.startsWith('// zachovaj 🌍\r\n'.repeat(400))).toBe(true);const input=JSON.parse(complete.mock.calls[0][0][1].content);expect(input.files[0]).toMatchObject({content:original,sha256:sourceHash(original)});expect(files[0].content).toBe(original);
  });

  it('odmietne priveľký úplný kontext ešte pred admission a provider volaním',async()=>{
    const provider={...mockFixingProvider(),contextWindowTokens:8192},complete=vi.spyOn(provider,'complete'),beforeAi=vi.fn(async()=>{});
    await expect(autofixLoop(provider,[{path:'src/main.tsx',content:'// zachovaj\n'.repeat(1000)+'const x = {'}],{beforeAi})).rejects.toMatchObject({message:expect.stringContaining('kapacitu')});expect(beforeAi).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
  });

  it('po konflikte alebo useknutom výstupe nerobí rebuild ani ďalší platený pokus',async()=>{
    for(const response of [{text:JSON.stringify({version:1,summary:'Conflict',changes:[{path:'src/main.tsx',action:'modify',beforeSha256:'0'.repeat(64),edits:[{search:'const x = {',replace:'export {};'}]}]})},{text:'{"files":[]}'},{text:'{}',finishReason:'length' as const}]){
      const provider=mockFixingProvider(),complete=vi.spyOn(provider,'complete').mockResolvedValue({...response,usage:{promptTokens:1,completionTokens:1}}),build=vi.spyOn(sandbox,'buildProject');
      const result=await autofixLoop(provider,brokenFiles);expect(result.ok).toBe(false);expect(result.finalFiles).toEqual(brokenFiles);expect(result.patchesApplied).toBe(0);expect(complete).toHaveBeenCalledOnce();expect(build).toHaveBeenCalledOnce();build.mockRestore();
    }
  });

  it('zastaví najviac po dvoch platných opravách a hash druhého pokusu viaže na nový obsah',async()=>{
    const provider=mockFixingProvider(),inputs:Array<{files:Array<{path:string;content:string;sha256:string}>}>=[];
    const complete=vi.spyOn(provider,'complete').mockImplementation(async messages=>{const input=JSON.parse(messages[1].content);inputs.push(input);const file=input.files.find((f:{path:string})=>f.path==='src/main.tsx');return{text:JSON.stringify({version:1,summary:'Still broken',changes:[{path:file.path,action:'modify',beforeSha256:file.sha256,edits:[{search:'const x = {',replace:'// retained error\nconst x = {'}]}]}),usage:{promptTokens:1,completionTokens:1}};});
    const result=await autofixLoop(provider,brokenFiles);expect(result).toMatchObject({ok:false,attempts:2,patchesApplied:2});expect(complete).toHaveBeenCalledTimes(2);expect(inputs[1].files[1].sha256).toBe(sourceHash(inputs[1].files[1].content));expect(inputs[1].files[1].sha256).not.toBe(inputs[0].files[1].sha256);
  });

  it('zrušený modelový výsledok ani nepovolené dependencies nepostúpia do rebuildu',async()=>{
    const abort=new AbortController(),provider=mockFixingProvider();vi.spyOn(provider,'complete').mockImplementation(async()=>{abort.abort();return{text:'{}',usage:{promptTokens:1,completionTokens:1}};});const build=vi.spyOn(sandbox,'buildProject');const cancelled=await autofixLoop(provider,brokenFiles,{signal:abort.signal});expect(cancelled.patchesApplied).toBe(0);expect(build).toHaveBeenCalledOnce();build.mockRestore();
    const invalid=mockFixingProvider();vi.spyOn(invalid,'complete').mockResolvedValue({text:JSON.stringify({version:1,summary:'Forbidden install',changes:[{path:'package.json',action:'modify',beforeSha256:sourceHash(brokenFiles[0].content),edits:[{search:brokenFiles[0].content,replace:'{"dependencies":{"unapproved":"*"}}'}]}]}),usage:{promptTokens:1,completionTokens:1}});const result=await autofixLoop(invalid,brokenFiles);expect(result.finalFiles).toEqual(brokenFiles);expect(result.patchesApplied).toBe(0);
  });

  it('nové cesty zachovajú povolené znaky a celý návrh zamietne traversal aj nepovolené znaky', async () => {
    const modulePath = 'src/features/feature_flags-v2.1.ts';
    const rejectedPaths = [
      '../escape.ts', 'src/../escape.ts', 'src/bad file.ts',
      'src/bad:name.ts', 'src\\bad.ts', 'src/bad?.ts',
    ];
    const provider: AIProvider = {
      name: 'mock-paths',
      model: 'mock-paths',
      async complete() {
        return {
          text: JSON.stringify({version:1,summary:'Add missing local import.',
            changes: [
              {
                path: 'src/main.tsx',
                action:'modify',beforeSha256:sourceHash(brokenFiles[1].content),edits:[{search:brokenFiles[1].content,replace:'import { createRoot } from "react-dom/client";\nimport { label } from "./features/feature_flags-v2.1.ts";\ncreateRoot(document.getElementById("root")!).render(<h1>{label}</h1>);'}],
              },
              { path: modulePath, action:'create',content: 'export const label = "PATH_OK";' },
            ],
          }),
          usage: { promptTokens: 10, completionTokens: 80 },
        };
      },
      async *stream() { yield { delta: '' }; },
    };

    const result = await autofixLoop(provider, brokenFiles);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.finalFiles.map(file => file.path)).toEqual([
      'package.json', 'src/main.tsx', modulePath,
    ]);
    expect(result.finalFiles.find(file => file.path === modulePath)?.content).toContain('PATH_OK');
    const original=provider.complete.bind(provider);
    for(const path of rejectedPaths){provider.complete=async(messages,opts)=>{const response=await original(messages,opts),value=JSON.parse(response.text);value.changes.push({path,action:'create',content:'export const rejected=true;'});return{...response,text:JSON.stringify(value)};};const rejected=await autofixLoop(provider,brokenFiles);expect(rejected.ok).toBe(false);expect(rejected.finalFiles).toEqual(brokenFiles);expect(rejected.patchesApplied).toBe(0);}
  });

  it('provider error sa redaktuje pred skrátením a bezpečný detail ostane užitočný', async () => {
    const canary = ['mstrl', 'AUTOFIX_PROVIDER_CANARY_0123456789'].join('_');
    const provider = mockFixingProvider();
    // The original credential crosses the 120-character history truncation boundary.
    const complete = vi.spyOn(provider, 'complete').mockRejectedValue(new Error(`HTTP 401: ${'detail '.repeat(10)}${canary} credential rejected`));

    const result = await autofixLoop(provider, brokenFiles);

    expect(result.ok).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain('mstrl_');
    expect(result.history.at(-1)?.message).toContain('HTTP 401:');
    expect(result.history.at(-1)?.message).toContain('[REDACTED] credential rejected');
  });

  it.each(['path', 'content'] as const)('tajomstvo vo vstupnom %s sa nevráti ani nepostúpi do buildu či AI', async field => {
    const canary = ['ghp', 'AUTOFIX_INPUT_CANARY_0123456789'].join('_');
    const files = [
      ...brokenFiles,
      {
        path: field === 'path' ? `src/${canary}.ts` : 'src/config.ts',
        content: field === 'content' ? `export const token = "${canary}";` : 'export const safe = true;',
      },
    ];
    const build = vi.spyOn(sandbox, 'buildProject');
    const provider = mockFixingProvider();
    const complete = vi.spyOn(provider, 'complete');

    const result = await autofixLoop(provider, files);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.finalFiles).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.history[0].message).toContain('zablokované');
  });

  it.each(['raw', 'escaped'] as const)('tajomstvo vo výstupe modelu (%s) sa neaplikuje ani nepoužije pri follow-up', async encoding => {
    const canary = ['mstrl', 'AUTOFIX_OUTPUT_CANARY_0123456789'].join('_');
    const text = JSON.stringify({ files: [{ path: 'src/main.tsx', content: `const token = "${canary}"; const broken = {` }] });
    const responseText = encoding === 'escaped' ? text.replace('mstrl_', 'mstrl\\u005f') : text;
    expect(containsPotentialSecret(responseText)).toBe(encoding === 'raw');
    const build = vi.spyOn(sandbox, 'buildProject');
    const provider = mockFixingProvider();
    const complete = vi.spyOn(provider, 'complete').mockResolvedValue({
      text: responseText,
      usage: { promptTokens: 10, completionTokens: 20 },
    });

    const result = await autofixLoop(provider, brokenFiles);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.patchesApplied).toBe(0);
    expect(result.finalFiles).toEqual(brokenFiles);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(complete.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(build.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.history.at(-1)?.message).toContain('potenciálne tajomstvo');
  });

  it('build diagnostic redaktuje tajomstvo pred ďalším AI volaním aj JSON výsledkom', async () => {
    const canary = ['ghp', 'AUTOFIX_BUILD_CANARY_0123456789'].join('_');
    const build = vi.spyOn(sandbox, 'buildProject');
    build.mockResolvedValueOnce({
        ok: false, html: null, durationMs: 1, moduleCount: 2,
        errors: [{ file: `src/${canary}.tsx`, message: `Syntax error near ${canary}: missing closing brace` }],
    });
    build.mockResolvedValueOnce({ ok: true, html: '<!doctype html>', durationMs: 1, moduleCount: 2, errors: [] });
    const provider = mockFixingProvider();
    const complete = vi.spyOn(provider, 'complete');

    const result = await autofixLoop(provider, brokenFiles);

    expect(result.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(complete.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(complete.mock.calls)).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result.buildErrors)).toContain('[REDACTED]');
    expect(JSON.stringify(result.buildErrors)).toContain('missing closing brace');
  });

  it('neočakávaná výnimka buildu vráti bezpečnú infra chybu bez AI volania', async () => {
    const canary = ['ghp', 'AUTOFIX_BUILD_CANARY_0123456789'].join('_');
    vi.spyOn(sandbox, 'buildProject').mockRejectedValueOnce(new Error(`worker failed ${canary}`));
    const provider = mockFixingProvider(); const complete = vi.spyOn(provider, 'complete');
    await expect(autofixLoop(provider, brokenFiles)).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    expect(complete).not.toHaveBeenCalled();
  });
});
