import { defineBlueprint } from '../factory';
export default defineBlueprint({
  id: 'saas-landing', title: 'SaaS landing', description: 'Produktová stránka s porovnaním plánov, FAQ a formulárom záujmu.',
  category: 'Biznis', icon: '↗', tags: ['startup', 'pricing', 'landing'],
  features: ['Mesačné a ročné plány', 'Časté otázky', 'Formulár záujmu'],
  followups: ['Prispôsob texty tejto landing page mojej značke.', 'Pridaj sekciu často kladených otázok.', 'Pridaj prístupný prepínač svetlej a tmavej témy.'],
  data: 'export const benefits = ["Jeden prehľadný pracovný priestor", "Menej rutiny, viac času pre zákazníkov", "Začni s tým, čo práve potrebuješ"];',
  app: String.raw`import {useState} from 'react';
import {Header} from './components/Header';
import {benefits} from './data';
export default function App(){
 const [annual,setAnnual]=useState(false); const [joined,setJoined]=useState(false);
 return <><Header section="Produkt"/><main><section className="hero intro"><p className="eyebrow">Od nápadu k výsledku</p><h1>Práca, ktorá má konečne svoj systém.</h1><p>Prehľadný priestor pre projekty, priority a ľudí. Nastav si vlastný postup a venuj energiu tomu podstatnému.</p><a href="#plans">Pozrieť možnosti →</a></section><section className="grid" aria-label="Výhody">{benefits.map((b,i)=><article className="card" key={b}><span className="badge">0{i+1}</span><h2 style={{marginTop:18}}>{b}</h2><p>Jednoduchý začiatok, zrozumiteľné kroky a priestor na rast.</p></article>)}</section><section id="plans" style={{marginTop:36}}><div className="row between"><h2>Vyber si svoje tempo</h2><label className="row"><input type="checkbox" checked={annual} onChange={e=>setAnnual(e.target.checked)}/>Ročný prepočet</label></div><p>Ukážkový cenník. Platobná brána ešte nie je pripojená.</p><div className="grid">{[{name:'Štart',price:0,desc:'Vyskúšaj základné možnosti.'},{name:'Tím',price:annual?16:20,desc:'Viac priestoru pre tvoje projekty.'}].map(p=><article className="card" key={p.name}><h3>{p.name}</h3><p className="price">{p.price} € <small>/ mesiac</small></p><p>{p.desc}</p><a href="#interest">Mám záujem</a></article>)}</div></section><section className="card" id="interest" style={{marginTop:24}}><h2>Chceš vedieť viac?</h2><form className="toolbar" onSubmit={e=>{e.preventDefault();setJoined(true);}}><label>E-mail<input name="email" type="email" required placeholder="ty@firma.sk"/></label><button className="primary">Prejaviť záujem</button></form><p role="status">{joined?'Ďakujeme. Formulár je zatiaľ lokálna ukážka, e-mail sa nikam neposlal.':'Ukážka formulára bez odosielania údajov.'}</p></section><section style={{marginTop:28}}><h2>Časté otázky</h2><details className="card"><summary>Môžem začať postupne?</summary><p>Áno. Tento návrh môžeš prispôsobiť svojmu produktu a rozširovať podľa potrieb.</p></details></section></main></>;
}`,
});
