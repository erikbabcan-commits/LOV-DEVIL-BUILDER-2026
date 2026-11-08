import { defineBlueprint } from '../factory';

export default defineBlueprint({
  id: 'invoice', title: 'Návrh faktúry',
  description: 'Položky s množstvom a cenou, súčet v eurách a náhľad návrhu pre odberateľa.',
  category: 'Biznis', icon: '▤', tags: ['faktúra', 'položky', 'cena'],
  features: ['Pridanie a odstránenie položiek', 'Prepočet súčtu', 'Náhľad návrhu'],
  followups: [
    'Pridaj samostatné nastavenia dodávateľa a odberateľa.',
    'Priprav serverové uloženie rozpracovaných dokladov.',
    'Doplň zobrazenie návrhu vhodné na tlač.',
  ],
  app: String.raw`import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Header } from './components/Header';
import { EmptyState } from './components/EmptyState';

type Line = { id: number; title: string; quantity: number; cents: number };
const euro = new Intl.NumberFormat('sk-SK', { style: 'currency', currency: 'EUR' });
const money = (cents: number) => euro.format(cents / 100);

function readCents(value: string): number | null {
  if (!/^\d{1,6}([,.]\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split(/[,.]/);
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export default function App() {
  const [customer, setCustomer] = useState('');
  const [title, setTitle] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [preview, setPreview] = useState(false);
  const nextLineId = useRef(0);
  const total = lines.reduce((sum, line) => sum + line.quantity * line.cents, 0);

  function addLine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const count = Number(quantity);
    const cents = readCents(price.trim());
    if (!title.trim() || !Number.isInteger(count) || count < 1 || count > 999 ||
        cents === null || lines.length >= 50) return;
    setLines([...lines, { id: ++nextLineId.current, title: title.trim(), quantity: count, cents }]);
    setTitle('');
    setPrice('');
    setQuantity('1');
  }

  return <><Header section="Fakturácia"/><main>
    <div className="intro">
      <h1>Priprav návrh faktúry.</h1>
      <p>Ukážka na výpočet položiek. Doklad sa neodosiela a údaje sa neukladajú.</p>
    </div>
    {preview ? <section className="card stack" aria-label="Náhľad faktúry">
      <h2>Náhľad faktúry</h2><p>Odberateľ · <b>{customer.trim()}</b></p>
      <ul className="list">{lines.map(line => <li className="row between" key={line.id}>
        <span>{line.title} · {line.quantity} × {money(line.cents)}</span>
        <b>{money(line.quantity * line.cents)}</b>
      </li>)}</ul>
      <p className="price">Spolu {money(total)}</p>
      <button type="button" onClick={() => setPreview(false)}>Späť na úpravy</button>
    </section> : <div className="stack">
      <label>Odberateľ<input maxLength={100} value={customer} onChange={event => setCustomer(event.target.value)}/></label>
      <form className="card stack" onSubmit={addLine}>
        <h2>Nová položka</h2>
        <label>Názov položky<input required maxLength={100} value={title} onChange={event => setTitle(event.target.value)}/></label>
        <label>Množstvo<input required type="number" min={1} max={999} step={1} value={quantity} onChange={event => setQuantity(event.target.value)}/></label>
        <label>Jednotková cena v EUR<input required inputMode="decimal" maxLength={9}
          value={price} onChange={event => setPrice(event.target.value)} placeholder="0,00"/></label>
        <button className="primary" disabled={!title.trim() || readCents(price.trim()) === null || lines.length >= 50}>Pridať položku</button>
      </form>
      <section className="card" aria-label="Položky faktúry">
        <h2>Položky faktúry</h2>
        {lines.length ? <ul className="list">{lines.map(line => <li className="row between" key={line.id}>
          <span>{line.title} · {line.quantity} × {money(line.cents)}</span>
          <button type="button" aria-label={'Odstrániť položku ' + line.title}
            onClick={() => setLines(lines.filter(item => item.id !== line.id))}>Odstrániť</button>
        </li>)}</ul> : <EmptyState title="Žiadne položky" detail="Pridaj prvú položku faktúry."/>}
        <p className="price" aria-live="polite">Spolu {money(total)}</p>
        <button type="button" disabled={!customer.trim() || !lines.length} onClick={() => setPreview(true)}>Zobraziť náhľad faktúry</button>
      </section>
    </div>}
  </main></>;
}`,
});
