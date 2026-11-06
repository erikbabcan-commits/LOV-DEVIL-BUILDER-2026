import { defineBlueprint } from '../factory';
export default defineBlueprint({
  id: 'settings', title: 'Nastavenia účtu', description: 'Profil, preferencie a upozornenia s formulárovou validáciou.',
  category: 'Aplikácie', icon: '⚙', tags: ['profil', 'formulár', 'nastavenia'],
  followups: ['Rozdeľ nastavenia na prehľadné záložky.', 'Pridaj výber jazyka slovenčina a angličtina.', 'Pridaj export nastavení do JSON súboru.'],
  app: String.raw`import {useState} from 'react';import {Header} from './components/Header';
export default function App(){const [name,setName]=useState('Alex Novák');const [email,setEmail]=useState('alex@example.com');const [weekly,setWeekly]=useState(true);const [tips,setTips]=useState(false);const [saved,setSaved]=useState(false);
 return <><Header section="Nastavenia"/><main><div className="intro"><p className="eyebrow">Podľa teba</p><h1>Tvoj účet. Tvoje nastavenia.</h1><p>Prehľadný formulár pripravený na napojenie tvojho backendu. Zatiaľ nič neposiela ani trvalo neukladá.</p></div><form className="grid" onChange={()=>setSaved(false)} onSubmit={e=>{e.preventDefault();setSaved(true);}}><section className="card stack"><h2>Profil</h2><label>Zobrazované meno<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label><label>E-mail<input type="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><p className="muted">Údaje slúžia iba na ukážku rozhrania.</p></section><section className="card stack"><h2>Upozornenia</h2><label className="row"><input type="checkbox" checked={weekly} onChange={e=>setWeekly(e.target.checked)}/>Týždenný prehľad</label><label className="row"><input type="checkbox" checked={tips} onChange={e=>setTips(e.target.checked)}/>Tipy k používaniu</label><button className="primary">Uložiť nastavenia</button><p role="status">{saved?'Nastavenia boli použité v tejto ukážke.':'Po úprave nezabudni nastavenia uložiť.'}</p></section></form></main></>;
}`,
});
