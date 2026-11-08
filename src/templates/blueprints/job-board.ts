import { defineBlueprint } from '../factory';

export default defineBlueprint({
  id: 'job-board', title: 'Pracovná nástenka',
  description: 'Vyhľadávanie pracovných ponúk, filter podľa pracoviska a lokálna prihláška.',
  category: 'Biznis', icon: '▤', tags: ['práca', 'ponuky', 'nábor'],
  features: ['Vyhľadávanie ponúk', 'Filter pracoviska', 'Prihláška na pozíciu'],
  followups: [
    'Pridaj rozhranie pre správu ponúk.',
    'Priprav serverové ukladanie prihlášok s ochranou osobných údajov.',
    'Pridaj filtrovanie podľa pracovného pomeru.',
  ],
  app: String.raw`import { useState } from 'react';
import type { FormEvent } from 'react';
import { Header } from './components/Header';
import { EmptyState } from './components/EmptyState';

const jobs = [
  { id: 'frontend', title: 'Frontend vývojár', company: 'Ateliér Kód', workplace: 'Na diaľku' },
  { id: 'design', title: 'Produktový dizajnér', company: 'Studio Línia', workplace: 'Bratislava' },
  { id: 'support', title: 'Zákaznícka podpora', company: 'Tím Most', workplace: 'Na diaľku' },
];
const searchable = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export default function App() {
  const [query, setQuery] = useState('');
  const [workplace, setWorkplace] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [applications, setApplications] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<{ message: string; duplicate: boolean } | null>(null);
  const selected = jobs.find(job => job.id === selectedId);
  const needle = searchable(query.trim());
  const visible = jobs.filter(job => (!workplace || job.workplace === workplace) &&
    searchable(job.title + ' ' + job.company).includes(needle));

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const name = String(values.get('name') ?? '').trim();
    const email = String(values.get('email') ?? '').trim().toLowerCase();
    if (!name || !email) return;
    const key = selected.id + ':' + email;
    if (applications.has(key)) {
      setFeedback({ message: 'Tento e-mail už má prihlášku na túto pozíciu.', duplicate: true });
      return;
    }
    setApplications(new Set([...applications, key]));
    setFeedback({ message: 'Prihláška je zapísaná v ukážke.', duplicate: false });
    form.reset();
  }

  return <><Header section="Pracovné ponuky"/><main>
    <div className="intro"><h1>Nájdi ďalší pracovný krok.</h1>
      <p>Ukážkové ponuky a prihlášky iba v prehliadači. Použi fiktívne kontaktné údaje.</p></div>
    <div className="toolbar">
      <label>Hľadať ponuku<input type="search" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <label>Pracovisko<select value={workplace} onChange={event => setWorkplace(event.target.value)}>
        <option value="">Všetky pracoviská</option><option>Na diaľku</option><option>Bratislava</option>
      </select></label>
    </div>
    <div className="grid">{visible.map(job => <article className="card stack" key={job.id}>
      <h2>{job.title}</h2><p>{job.company} · {job.workplace}</p>
      <button type="button" onClick={() => {
        setSelectedId(job.id);
        setFeedback(null);
      }}>Vybrať pozíciu {job.title}</button>
    </article>)}</div>
    {!visible.length && <EmptyState title="Žiadne ponuky" detail="Zmeň hľadaný výraz alebo pracovisko."/>}
    {selected && <form key={selected.id} className="card stack" style={{marginTop:20}}
        aria-label={'Prihláška · ' + selected.title} onSubmit={apply}>
      <h2>Prihláška · {selected.title}</h2>
      <label>Meno<input name="name" required maxLength={80}/></label>
      <label>E-mail<input name="email" type="email" required maxLength={120}/></label>
      <button className="primary">Zapísať prihlášku</button>
      {feedback && <p className="notice" role={feedback.duplicate ? 'alert' : 'status'}>{feedback.message}</p>}
    </form>}
  </main></>;
}`,
});
