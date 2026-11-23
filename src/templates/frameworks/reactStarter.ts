import { defineBlueprint } from '../factory';
import type { Blueprint } from '../types';

export const reactStarter: Blueprint = defineBlueprint({
  id: 'fw-react',
  title: 'React 19 + TypeScript',
  description: 'Oficiálny moderný Single Page App stack s React 19, Vite 6, Tailwind CSS a Lucide ikonami.',
  category: 'Aplikácie',
  icon: '⚛️',
  tags: ['react', 'vite', 'tailwind', 'spa', 'typescript'],
  features: ['React 19 Server/Client Hooks', 'Tailwind CSS v3', 'Vite 6 Ultra-fast HMR'],
  followups: [
    'Pridaj navigačný bar so sekciami a responzívnym mobilným menu.',
    'Vytvor interaktívny dashboard s dátovými kartami a grafmi.',
    'Nastav tmavú tému s plynulým prepínaním.'
  ],
  data: `export const frameworkInfo = {
  name: "React 19",
  ecosystem: "Vite 6 + Tailwind CSS",
  stars: "230k+",
  repo: "facebook/react"
};`,
  app: String.raw`import { useState } from 'react';
import { Header } from './components/Header';
import { frameworkInfo } from './data';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Header section="React 19 Starter" />
      <main className="flex-1 max-w-4xl w-full mx-auto p-6 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 mb-6 flex items-center justify-center rounded-2xl bg-cyan-950/40 border border-cyan-500/30 text-cyan-400 shadow-lg shadow-cyan-500/10">
          <svg className="w-12 h-12 animate-[spin_12s_linear_infinite]" viewBox="-11.5 -10.23174 23 20.46348">
            <circle cx="0" cy="0" r="2.05" fill="#61dafb"/>
            <g stroke="#61dafb" strokeWidth="1" fill="none">
              <ellipse rx="11" ry="4.2"/>
              <ellipse rx="11" ry="4.2" transform="rotate(60)"/>
              <ellipse rx="11" ry="4.2" transform="rotate(120)"/>
            </g>
          </svg>
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4 bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-blue-500">
          {frameworkInfo.name} + TypeScript
        </h1>
        <p className="text-slate-400 text-lg max-w-xl mb-8">
          Produkčne pripravený React starter projekt. Zostavený na Vite 6, pripravený na export na GitHub a okamžitý deploy na Vercel/Netlify.
        </p>

        <div className="flex gap-4 items-center">
          <button
            onClick={() => setCount(c => c + 1)}
            className="px-6 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold transition shadow-lg shadow-cyan-500/20 active:scale-95"
          >
            Počet kliknutí: {count}
          </button>
          <a
            href="https://lov.vorkei.com"
            target="_blank"
            rel="noreferrer"
            className="px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold transition border border-slate-700"
          >
            VORKEI Builder ↗
          </a>
        </div>
      </main>
    </div>
  );
}`
});
