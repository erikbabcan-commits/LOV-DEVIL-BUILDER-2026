import { defineBlueprint } from '../factory';

export default defineBlueprint({
  id: 'booking', title: 'Rezervácie termínov',
  description: 'Výber dátumu a voľného času, prehľad rezervácií a uvoľnenie zrušeného termínu.',
  category: 'Biznis', icon: '▦', tags: ['rezervácia', 'termín', 'služby'],
  features: ['Výber termínu', 'Obsadené časy', 'Zrušenie rezervácie'],
  followups: [
    'Pridaj typy služieb s rôznou dĺžkou termínu.',
    'Priprav serverové ukladanie s jedinečným termínom pre každého pracovníka.',
    'Doplň pracovné hodiny a dni voľna.',
  ],
  app: String.raw`import { useState } from 'react';
import type { FormEvent } from 'react';
import { Header } from './components/Header';
import { EmptyState } from './components/EmptyState';

const slots = ['09:00', '10:30', '13:00', '14:30', '16:00'];
type Booking = { date: string; time: string; name: string };

export default function App() {
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [name, setName] = useState('');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [notice, setNotice] = useState('');
  const occupied = new Set(bookings.filter(booking => booking.date === date).map(booking => booking.time));

  function reserve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const customer = name.trim();
    if (!date || !slots.includes(time) || occupied.has(time) || !customer) return;
    setBookings([...bookings, { date, time, name: customer }]);
    setNotice('Termín ' + time + ' je rezervovaný.');
    setTime('');
    setName('');
  }

  return <><Header section="Rezervácie"/><main>
    <div className="intro">
      <h1>Naplánuj si stretnutie.</h1>
      <p>Lokálny rozpis termínov. Rezervácie sa nezdieľajú a po obnovení stránky sa resetujú.</p>
    </div>
    <form className="card stack" onSubmit={reserve}>
      <label>Dátum<input required type="date" value={date} onChange={event => {
        setDate(event.target.value);
        setTime('');
      }}/></label>
      <label>Čas<select required disabled={!date} value={time} onChange={event => setTime(event.target.value)}>
        <option value="">Vyber čas</option>
        {slots.map(slot => <option key={slot} value={slot} disabled={occupied.has(slot)}>
          {slot}{occupied.has(slot) ? ' · obsadené' : ''}
        </option>)}
      </select></label>
      <label>Meno<input required maxLength={70} value={name} onChange={event => setName(event.target.value)}/></label>
      <button className="primary" disabled={!date || !time || !name.trim()}>Rezervovať termín</button>
      {notice && <p role="status" className="notice">{notice}</p>}
    </form>
    <section className="card" style={{marginTop: 20}}>
      <h2>Rezervované termíny</h2>
      {bookings.length ? <ul className="list">{[...bookings].sort((a, b) =>
        (a.date + a.time).localeCompare(b.date + b.time)
      ).map(booking => <li className="row between" key={booking.date + booking.time}>
        <span><b>{booking.name}</b> · {booking.date} o {booking.time}</span>
        <button type="button" aria-label={'Zrušiť termín ' + booking.date + ' o ' + booking.time}
          onClick={() => {
            setBookings(bookings.filter(item => item !== booking));
            setNotice('Termín ' + booking.time + ' je znovu voľný.');
          }}>Zrušiť</button>
      </li>)}</ul> : <EmptyState title="Žiadna rezervácia" detail="Vyber dátum a voľný čas."/>}
    </section>
  </main></>;
}`,
});
