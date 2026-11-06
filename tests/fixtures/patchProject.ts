import {makeMockProvider} from '../../server/index';
import type {AIProvider} from '../../server/providers/types';
export const PATCH_PROJECT_FILES=[
 {path:'package.json',content:JSON.stringify({name:'patch-fixture',private:true,type:'module',dependencies:{react:'^18.3.1','react-dom':'^18.3.1'}})},
 {path:'index.html',content:'<!doctype html><html><head><title>Patch fixture</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'},
 {path:'src/main.tsx',content:'import React from "react";import{createRoot}from"react-dom/client";import App from "./App";import "./index.css";createRoot(document.getElementById("root")!).render(<App/>);'},
 {path:'src/App.tsx',content:'export default function App(){return <main><h1>Kontrola cielenej zmeny</h1><p>Mení sa iba farba hlavného tlačidla.</p><button className="primary">Hlavné tlačidlo</button><button className="secondary">Druhé tlačidlo</button></main>;}'},
 {path:'src/index.css',content:'body { margin: 0; padding: 32px; font-family: system-ui; background: #f8fafc; color: #0f172a; }\nbutton { border: 0; border-radius: 8px; padding: 12px 20px; margin-right: 12px; color: white; }\n.primary { background: #2563eb; }\n.secondary { background: #64748b; }\n'},
];
/** Explicit synthetic responses only. No external model or pricing claim. */
export function patchFixtureProvider():AIProvider{
 const base=makeMockProvider();return{...base,name:'mock-patch',model:'patch-fixture',async complete(messages,opts){
  if(messages[0].content.includes('Forge Edit Planner'))return{text:JSON.stringify({summary:'Zmením iba farbu hlavného tlačidla.',steps:[{id:'color',title:'Zmeň farbu v CSS'}],filesPlanned:['src/index.css']}),model:'patch-fixture-actual',usage:{promptTokens:40,completionTokens:30}};
  if(messages[0].content.includes('Forge Patch Editor')){const data=JSON.parse(messages[1].content) as {prompt:string;files:Array<{path:string;sha256:string}>};return{text:JSON.stringify({version:1,summary:'Mení sa len farba hlavného tlačidla.',changes:[{path:'src/index.css',action:'modify',beforeSha256:/konflikt/i.test(data.prompt)?'0'.repeat(64):data.files.find(f=>f.path==='src/index.css')!.sha256,edits:[{search:'#2563eb',replace:'#dc2626'}]}]}),model:'patch-fixture-actual',usage:{promptTokens:40,completionTokens:30}};}
  return{...await base.complete(messages,opts),model:'patch-fixture-actual'};
 }};
}
