import { defineBlueprint } from '../factory';

export default defineBlueprint({
  id: 'blog-cms', title: 'Blog s redakciou',
  description: 'Redakcia článkov s konceptmi a samostatným čitateľským pohľadom.',
  category: 'Obsah', icon: '✎', tags: ['blog', 'cms', 'redakcia'],
  features: ['Tvorba konceptu', 'Zverejnenie vybranej verzie', 'Čitateľský pohľad'],
  followups: [
    'Ulož koncepty a zverejnené verzie článkov na serveri.',
    'Pridaj overené roly autora a redaktora.',
    'Doplň kategórie a adresy jednotlivých článkov.',
  ],
  app: String.raw`import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Header } from './components/Header';
import { EmptyState } from './components/EmptyState';

type Content = { title: string; body: string };
type Article = Content & { id: number; published?: Content };
const initial = { title: 'Vitaj v redakcii', body: 'Tento ukážkový článok už vidia čitatelia.' };

export default function App() {
  const [articles, setArticles] = useState<Article[]>([{ ...initial, id: 1, published: initial }]);
  const [editing, setEditing] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reader, setReader] = useState(false);
  const [notice, setNotice] = useState('');
  const nextId = useRef(2);
  const publicArticles = articles.flatMap(({id, published}) => published ? [{id, ...published}] : []);

  function edit(article?: Article) {
    setEditing(article?.id ?? null);
    setTitle(article?.title ?? '');
    setBody(article?.body ?? '');
    setNotice('');
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = { title: title.trim(), body: body.trim() };
    if (!content.title || !content.body) return;
    if (editing === null) {
      const id = nextId.current++;
      setArticles([...articles, { ...content, id }]);
      setEditing(id);
    } else {
      setArticles(articles.map(article => article.id === editing ? { ...article, ...content } : article));
    }
    setNotice('Koncept uložený v ukážke.');
  }

  function publish(article: Article) {
    setArticles(articles.map(entry => entry.id === article.id
      ? { ...entry, published: { title: entry.title, body: entry.body } } : entry));
    setNotice('Čitateľský pohľad bol aktualizovaný.');
  }

  return <><Header section={reader ? 'Čitateľský pohľad' : 'Redakcia'}/><main>
    <div className="intro"><h1>Príbeh začína konceptom.</h1>
      <p>Lokálna redakčná ukážka. Zverejnenie sa prejaví v čitateľskom pohľade tejto karty.</p></div>
    <div className="row" role="group" aria-label="Pohľad blogu" style={{marginBottom:20}}>
      <button type="button" aria-pressed={!reader} onClick={() => setReader(false)}>Redakcia</button>
      <button type="button" aria-pressed={reader} onClick={() => setReader(true)}>Čitateľ</button>
    </div>
    {reader ? <section className="stack" aria-label="Zverejnené články">
      <h2>Zverejnené články</h2>
      {publicArticles.length ? publicArticles.map(article => <article className="card" key={article.id}>
        <h3>{article.title}</h3><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{article.body}</p>
      </article>) : <EmptyState title="Žiadny článok" detail="Zverejni koncept v redakcii."/>}
    </section> : <div className="stack">
      <form className="card stack" aria-label="Koncept článku" onSubmit={save}>
        <h2>{editing === null ? 'Nový koncept' : 'Úprava konceptu'}</h2>
        <label>Nadpis článku<input required maxLength={100} value={title} onChange={event => setTitle(event.target.value)}/></label>
        <label>Text článku<textarea required maxLength={4000} rows={5} value={body} onChange={event => setBody(event.target.value)}/></label>
        <button className="primary" disabled={!title.trim() || !body.trim()}>Uložiť koncept</button>
        {editing !== null && <button type="button" onClick={() => edit()}>Začať nový článok</button>}
        {notice && <p className="notice" role="status">{notice}</p>}
      </form>
      <section className="card" aria-label="Články v redakcii">
        <h2>Články v redakcii</h2>
        <ul className="list">{articles.map(article => {
          const published = article.published;
          const synchronized = !!published && published.title === article.title && published.body === article.body;
          return <li className="stack" key={article.id}>
            <b style={{overflowWrap:'anywhere'}}>{article.title}</b>
            <span className="muted">{!published ? 'Koncept' : synchronized ? 'Zverejnený' : 'Nové zmeny v koncepte'}</span>
            <div className="row">
              <button type="button" aria-label={'Upraviť · ' + article.title} onClick={() => edit(article)}>Upraviť</button>
              <button type="button" disabled={synchronized} aria-label={'Zverejniť · ' + article.title} onClick={() => publish(article)}>Zverejniť</button>
            </div>
          </li>;
        })}</ul>
      </section>
    </div>}
  </main></>;
}`,
});
