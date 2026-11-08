import { defineBlueprint } from '../factory';

export default defineBlueprint({
  id: 'event-registration', title: 'Registrácia na podujatie',
  description: 'Výber podujatia, lokálna registrácia a prehľad zostávajúcich miest.',
  category: 'Aplikácie', icon: '◈', tags: ['podujatie', 'registrácia', 'kapacita'],
  features: ['Výber podujatia', 'Kontrola voľných miest', 'Zrušenie registrácie'],
  followups: [
    'Pridaj dátum, miesto a program podujatia.',
    'Priprav serverové ukladanie registrácií s atómovou kontrolou kapacity.',
    'Pridaj export zoznamu účastníkov.',
  ],
  app: String.raw`import { useState } from 'react';
import type { FormEvent } from 'react';
import { Header } from './components/Header';
import { EmptyState } from './components/EmptyState';

const events = [
  { id: 'design', title: 'Workshop dizajnu', capacity: 3 },
  { id: 'web', title: 'Tvorba prvého webu', capacity: 5 },
];
type Registration = { event: string; name: string; email: string; seats: number };

export default function App() {
  const [eventId, setEventId] = useState(events[0].id);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [seats, setSeats] = useState('1');
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const selected = events.find(event => event.id === eventId) ?? events[0];
  const active = registrations.filter(entry => entry.event === selected.id);
  const available = selected.capacity - active.reduce((total, entry) => total + entry.seats, 0);

  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const count = Number(seats), address = email.trim().toLowerCase();
    if (!name.trim() || !address || !Number.isInteger(count) || count < 1 || count > available) return;
    if (active.some(entry => entry.email === address)) {
      setFeedback({ message: 'Tento e-mail už má registráciu na vybrané podujatie.', error: true });
      return;
    }
    setRegistrations([...registrations, { event: selected.id, name: name.trim(), email: address, seats: count }]);
    setName('');
    setEmail('');
    setSeats('1');
    setFeedback({ message: 'Registrácia je zapísaná v ukážke.', error: false });
  }

  return <><Header section="Podujatia"/><main>
    <div className="intro">
      <h1>Rezervuj si miesto.</h1>
      <p>Registrácie sú lokálne. Použi ukážkové údaje. Potvrdenia sa neposielajú.</p>
    </div>
    <form className="card stack" onSubmit={register}>
      <label>Podujatie<select value={selected.id} onChange={event => {
        setEventId(event.target.value);
        setSeats('1');
        setFeedback(null);
      }}>{events.map(event => <option key={event.id} value={event.id}>{event.title}</option>)}</select></label>
      <p aria-live="polite"><b>Voľné miesta: {available} z {selected.capacity}</b></p>
      <label>Meno<input required maxLength={70} value={name} onChange={event => setName(event.target.value)}/></label>
      <label>E-mail<input required type="email" maxLength={100} value={email} onChange={event => setEmail(event.target.value)}/></label>
      <label>Počet miest<input required type="number" step={1} min={1} max={Math.max(1, available)} value={seats}
        onChange={event => setSeats(event.target.value)}/></label>
      <button className="primary" disabled={!available || !name.trim() || !email.trim()}>Registrovať</button>
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className="notice">{feedback.message}</p>}
    </form>
    <section className="card" style={{marginTop: 20}}>
      <h2>Registrácie</h2>
      {active.length ? <ul className="list">{active.map(entry => <li className="row between" key={entry.email}>
        <span><b>{entry.name}</b> · počet miest {entry.seats}</span>
        <button type="button" aria-label={'Zrušiť registráciu ' + entry.name} onClick={() => {
          setRegistrations(registrations.filter(item => item !== entry));
          setFeedback({ message: 'Registrácia zrušená. Miesta sú znovu voľné.', error: false });
        }}>Zrušiť</button>
      </li>)}</ul> : <EmptyState title="Žiadna registrácia" detail="Vyplň formulár pre vybrané podujatie."/>}
    </section>
  </main></>;
}`,
});
