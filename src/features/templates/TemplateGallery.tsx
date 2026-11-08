import { useState } from 'react';
import { BLUEPRINT_REGISTRY, searchBlueprints } from '../../templates/registry';
import { brandBlueprint } from '../../templates/factory';
import type { Blueprint } from '../../templates/types';
import { useStore } from '../../stores/useAppStore';

const categories = ['Všetky', 'Biznis', 'Produktivita', 'Obsah', 'Aplikácie'];
export function TemplateGallery() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Všetky');
  const [selected, setSelected] = useState<Blueprint | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2563eb');
  const stageTemplate = useStore(state => state.stageTemplate);
  const insertPrompt = useStore(state => state.usePrompt);
  const busy = useStore(state => state.generating || state.pendingReview !== null);
  const templates = searchBlueprints(query, category);

  return <section className="template-gallery" aria-label="Šablóny projektov">
    <div className="section-intro"><span className="section-eyebrow">Rýchly štart bez AI volania</span><h2>Začni bližšie k svojej predstave.</h2>
      <p>{BLUEPRINT_REGISTRY.length} funkčných React základov. Vyber si šablónu, dolaď názov a farbu a prezri si súbory pred použitím.</p></div>
    <div className="template-tools"><label className="field-label">Hľadať šablónu<input type="search" placeholder="Napríklad CRM, blog, úlohy…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="template-categories" aria-label="Kategórie šablón">{categories.map(value => <button key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{value}</button>)}</div></div>
    <p className="template-count" role="status">{templates.length} z {BLUEPRINT_REGISTRY.length} šablón</p>
    {selected && <form className="template-brand" aria-label="Prispôsobiť šablónu" onSubmit={event => {
      event.preventDefault(); stageTemplate(brandBlueprint(selected, { name, color })); setSelected(null);
    }}><div><span className="section-eyebrow">{selected.title}</span><h3>Daj projektu vlastný rukopis.</h3><p>Použitie vytvorí novú verziu. Pôvodná zostane v histórii.</p></div>
      <label className="field-label">Názov značky<input required maxLength={60} value={name} onChange={event => setName(event.target.value)} autoFocus /></label>
      <label className="field-label brand-color">Hlavná farba<input type="color" value={color} onChange={event => setColor(event.target.value)} /></label>
      <div className="template-brand-actions"><button className="btn-ghost" type="button" onClick={() => setSelected(null)}>Zrušiť</button><button className="btn-primary" disabled={busy}>Prezrieť súbory →</button></div>
    </form>}
    <div className="template-grid">{templates.map(template => <article className={'template-card' + (selected?.id === template.id ? ' selected' : '')} key={template.id}>
      <div className="template-card-top"><span className="template-icon" aria-hidden="true">{template.icon}</span><span className="template-category">{template.category}</span></div>
      <h3>{template.title}</h3><p>{template.description}</p><span className="template-stack">React · TypeScript · {template.files.length} súborov</span>
      <button className="template-use" disabled={busy} onClick={() => { setSelected(template); setName(template.title); }}>Použiť šablónu <span aria-hidden="true">↗</span></button>
      <details className="template-followups"><summary>Nápady na ďalší krok</summary>{template.followups.map(prompt => <button key={prompt} onClick={() => insertPrompt(prompt)}>{prompt}</button>)}</details>
    </article>)}</div>
    {!templates.length && <div className="product-empty"><h3>Takú šablónu zatiaľ nemáme.</h3><p>Skús iné slovo alebo zobraz všetky kategórie.</p><button className="btn-ghost" onClick={() => { setQuery(''); setCategory('Všetky'); }}>Zobraziť všetky šablóny</button></div>}
    <p className="template-note">Šablóny pracujú s lokálnymi ukážkovými dátami. Databázu, platby a skutočné prihlasovanie treba pripojiť samostatne.</p>
  </section>;
}
