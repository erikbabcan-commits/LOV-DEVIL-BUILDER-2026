import { defineBlueprint } from '../factory';

export default defineBlueprint({
  id: 'members-area', title: 'Členská zóna',
  description: 'Ukážkový pohľad hosťa a člena, knižnica a sledovanie pokroku.',
  category: 'Aplikácie', icon: '◉', tags: ['členstvo', 'knižnica', 'vzdelávanie'],
  features: ['Prepínanie pohľadu', 'Členská knižnica', 'Sledovanie pokroku'],
  followups: [
    'Pripoj overené prihlásenie a kontrolu členstva na serveri.',
    'Pridaj správu obsahu knižnice.',
    'Ulož pokrok k používateľskému účtu.',
  ],
  app: String.raw`import { useState } from 'react';
import { Header } from './components/Header';

const resources = [
  { id: 'start', title: 'Prvý krok', description: 'Zorientuj sa v knižnici a vyber si vlastný cieľ.' },
  { id: 'checklist', title: 'Kontrolný zoznam', description: 'Rozdeľ svoj cieľ na tri kroky a vyber najbližší termín.' },
  { id: 'review', title: 'Týždenné zhodnotenie', description: 'Zapíš si jeden výsledok a jednu vec, ktorú nabudúce zmeníš.' },
];

export default function App() {
  const [member, setMember] = useState(false);
  const [opened, setOpened] = useState('');
  const [completed, setCompleted] = useState<Set<string>>(new Set());

  return <><Header section={member ? 'Pohľad člena' : 'Pohľad hosťa'}/><main>
    <div className="intro"><h1>Priestor pre členov.</h1>
      <p>Prepínač simuluje dva pohľady. Ukážka nemá prihlasovanie ani ochranu obsahu.</p></div>
    <div className="row" role="group" aria-label="Ukážkový pohľad" style={{marginBottom:20}}>
      <button type="button" aria-pressed={!member} onClick={() => { setMember(false); setOpened(''); }}>Hosť</button>
      <button type="button" aria-pressed={member} onClick={() => setMember(true)}>Člen</button>
    </div>
    {member ? <section className="stack" aria-label="Členská knižnica">
      <h2>Členská knižnica</h2>
      <div className="card stack">
        <p aria-live="polite">{completed.size} z {resources.length} dokončených</p>
        <progress value={completed.size} max={resources.length} aria-label="Pokrok v knižnici"/>
      </div>
      <div className="grid">{resources.map(resource => <article key={resource.id} className="card stack">
        <h3>{resource.title}</h3>
        <button type="button" aria-expanded={opened === resource.id} aria-controls={'resource-' + resource.id}
          onClick={() => setOpened(opened === resource.id ? '' : resource.id)}>
          {opened === resource.id ? 'Skryť' : 'Otvoriť'} · {resource.title}
        </button>
        <div id={'resource-' + resource.id} hidden={opened !== resource.id}>
          <p>{resource.description}</p>
          <label className="row"><input type="checkbox" checked={completed.has(resource.id)}
            onChange={event => {
              const next = new Set(completed);
              if (event.target.checked) next.add(resource.id);
              else next.delete(resource.id);
              setCompleted(next);
            }}/>Označiť ako hotové</label>
        </div>
      </article>)}</div>
    </section> : <section className="card">
      <h2>Čo členstvo ponúka</h2>
      <p>Knižnica obsahuje tri ukážkové zdroje. Prepni sa na člena a vyskúšaj sledovanie pokroku.</p>
    </section>}
  </main></>;
}`,
});
