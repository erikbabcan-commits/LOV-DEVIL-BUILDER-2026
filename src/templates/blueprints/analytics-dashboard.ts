import { defineBlueprint } from '../factory';
export default defineBlueprint({
  id: 'analytics-dashboard', title: 'Analytický dashboard', description: 'Metriky, dostupný stĺpcový graf a prehľad zdrojov návštevnosti.',
  category: 'Biznis', icon: '▥', tags: ['metriky', 'grafy', 'reporty'],
  followups: ['Pridaj porovnanie s predchádzajúcim obdobím.', 'Pridaj CSV export zobrazených metrík.', 'Priprav prázdny stav pre ešte nepripojené analytické dáta.'],
  data: 'export const channels=[{name:"Organické vyhľadávanie",visits:1480},{name:"Priamy prístup",visits:920},{name:"Odporúčania",visits:540},{name:"Sociálne siete",visits:310}];',
  app: String.raw`import {useState} from 'react';import {Header} from './components/Header';import {channels} from './data';
export default function App(){const [period,setPeriod]=useState('7');const factor=period==='30'?4:1;const total=channels.reduce((sum,c)=>sum+c.visits,0)*factor;
 return <><Header section="Analytika"/><main><div className="row between"><div className="intro"><p className="eyebrow">Dáta v súvislostiach</p><h1>Prehľad výkonu.</h1><p>Ukážkové dáta. Pripoj svoj analytický zdroj pred použitím reportu.</p></div><label>Obdobie<select value={period} onChange={e=>setPeriod(e.target.value)}><option value="7">7 dní</option><option value="30">30 dní</option></select></label></div><div className="grid">{[{label:'Návštevy',value:total.toLocaleString('sk-SK')},{label:'Nové kontakty',value:String(86*factor)},{label:'Konverzia',value:'2,65 %'}].map(m=><article className="card" key={m.label}><p>{m.label}</p><strong className="number">{m.value}</strong><small>Ukážková metrika</small></article>)}</div><section className="card" style={{marginTop:20}}><h2>Odkiaľ prichádzajú návštevníci</h2><ul className="list">{channels.map(c=><li key={c.name}><div className="row between"><b>{c.name}</b><span>{(c.visits*factor).toLocaleString('sk-SK')}</span></div><div role="img" aria-label={c.name+': '+(c.visits*factor)+' návštev'} className="bar" style={{width:(c.visits/1480*100)+'%',marginTop:10}}/></li>)}</ul></section></main></>;
}`,
});
