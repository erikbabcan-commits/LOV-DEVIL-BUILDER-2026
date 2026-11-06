import { defineBlueprint } from '../factory';
export default defineBlueprint({
  id: 'chat', title: 'Chat rozhranie', description: 'Konverzácia s lokálnymi odpoveďami, históriou správ a novým rozhovorom.',
  category: 'Aplikácie', icon: '◌', tags: ['chat', 'správy', 'asistent'],
  followups: ['Pridaj čitateľné stavy odosielania a opakovania správy.', 'Priprav serverové rozhranie pre AI bez vloženia kľúčov do klienta.', 'Pridaj export konverzácie do textového súboru.'],
  types: 'export interface Message {id:number;role:"assistant"|"user";text:string}',
  data: 'import type {Message} from "./types";export const welcome:Message={id:1,role:"assistant",text:"Ahoj. Toto je lokálna ukážka chatu bez AI služby. Čo chceš v ďalšom kroku vytvoriť?"};',
  app: String.raw`import {useState} from 'react';import {Header} from './components/Header';import {welcome} from './data';import type {Message} from './types';
export default function App(){const [messages,setMessages]=useState<Message[]>([welcome]);const [text,setText]=useState('');
 const send=()=>{const value=text.trim();if(!value)return;const id=Date.now();setMessages(items=>[...items,{id,role:'user',text:value},{id:id+1,role:'assistant',text:'Rozumiem. Zapísal som si: '+value+'. V tejto ukážke ide o lokálnu odpoveď. Skutočnú AI službu pripoj cez vlastný server.'}]);setText('');};
 return <><Header section="Konverzácia"/><main style={{maxWidth:820}}><div className="row between"><div className="intro"><p className="eyebrow">Priestor pre otázky</p><h1>Rozhovor začína tu.</h1></div><button onClick={()=>setMessages([welcome])}>Nový rozhovor</button></div><p className="notice">Ukážka bez externého AI volania. Správy zostávajú iba v tejto karte.</p><section className="card"><div className="messages" role="log" aria-label="História správ" aria-live="polite">{messages.map(m=><article className={'message '+m.role} key={m.id}><small>{m.role==='user'?'Ty':'Ukážkový asistent'}</small><div>{m.text}</div></article>)}</div><form className="toolbar" onSubmit={e=>{e.preventDefault();send();}}><label>Správa<textarea rows={2} maxLength={1000} value={text} required onChange={e=>setText(e.target.value)}/></label><button className="primary" disabled={!text.trim()}>Odoslať</button></form></section></main></>;
}`,
});
