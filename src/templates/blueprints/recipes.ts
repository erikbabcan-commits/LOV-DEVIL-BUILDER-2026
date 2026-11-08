import { defineBlueprint } from '../factory';

export default defineBlueprint({
  id: 'recipes', title: 'Receptár a nákupný zoznam',
  description: 'Detail receptu, množstvá podľa porcií a odškrtávanie surovín.',
  category: 'Obsah', icon: '◇', tags: ['recept', 'varenie', 'suroviny'],
  features: ['Výber receptu', 'Prepočet porcií', 'Nákupný zoznam'],
  followups: [
    'Pridaj vlastné recepty a kategórie.',
    'Pridaj plánovanie jedál na týždeň.',
    'Doplň export nákupného zoznamu.',
  ],
  app: String.raw`import { useState } from 'react';
import { Header } from './components/Header';

const recipes = [
  { id: 'pasta', title: 'Cestoviny s paradajkami',
    ingredients: [{name:'Cestoviny', amount:180, unit:'g'}, {name:'Paradajky', amount:240, unit:'g'}, {name:'Olivový olej', amount:2, unit:'PL'}],
    steps: ['Uvar cestoviny podľa obalu.', 'Paradajky krátko podus na oleji.', 'Zmiešaj a podávaj teplé.'] },
  { id: 'porridge', title: 'Ovsená kaša',
    ingredients: [{name:'Ovsené vločky', amount:100, unit:'g'}, {name:'Mlieko', amount:300, unit:'ml'}, {name:'Jablko', amount:1, unit:'ks'}],
    steps: ['Vločky zohrej v mlieku.', 'Za stáleho miešania var do zhustnutia.', 'Pridaj nakrájané jablko.'] },
];
const number = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 2 });

export default function App() {
  const [recipeId, setRecipeId] = useState(recipes[0].id);
  const [portions, setPortions] = useState(2);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const recipe = recipes.find(item => item.id === recipeId) ?? recipes[0];

  return <><Header section="Receptár"/><main>
    <div className="intro"><h1>Od receptu k nákupu.</h1>
      <p>Vyber recept, uprav počet porcií a odškrtni suroviny. Zoznam sa po obnovení resetuje.</p></div>
    <div className="toolbar">
      <label>Recept<select value={recipe.id} onChange={event => {
        setRecipeId(event.target.value);
        setChecked(new Set());
      }}>{recipes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label>Počet porcií<select value={portions} onChange={event => setPortions(Number(event.target.value))}>
        {[1,2,3,4,5,6,7,8].map(count => <option key={count}>{count}</option>)}
      </select></label>
    </div>
    <h2>{recipe.title}</h2>
    <div className="grid">
      <section className="card" aria-label="Nákupný zoznam">
        <h3>Nákupný zoznam</h3>
        <p aria-live="polite">{checked.size} z {recipe.ingredients.length} pripravených</p>
        <ul className="list">{recipe.ingredients.map(ingredient => <li key={ingredient.name}>
          <label className="row"><input type="checkbox" checked={checked.has(ingredient.name)}
            onChange={event => {
              const next = new Set(checked);
              if (event.target.checked) next.add(ingredient.name);
              else next.delete(ingredient.name);
              setChecked(next);
            }}/>
            {ingredient.name} · {number.format(ingredient.amount * portions / 2)} {ingredient.unit}
          </label>
        </li>)}</ul>
      </section>
      <section className="card"><h3>Postup</h3><ol>{recipe.steps.map(step => <li key={step}>{step}</li>)}</ol></section>
    </div>
  </main></>;
}`,
});
