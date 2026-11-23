import { defineBlueprint } from '../factory';
import type { Blueprint } from '../types';

export const viteStarter: Blueprint = defineBlueprint({
  id: 'fw-vite',
  title: 'Vite 6 SPA (Pure TypeScript)',
  description: 'Bleskový, minimálny frontend stack postavený priamo na Vite 6 pre maximálnu kontrolu a nulový balast.',
  category: 'Produktivita',
  icon: '⚡',
  tags: ['vite', 'typescript', 'fast', 'minimal', 'bundler'],
  features: ['Vite 6 Native Rollup engine', 'Okamžitý Hot Module Replacement (HMR)', 'Minimálna veľkosť balíka'],
  followups: [
    'Nakonfiguruj Vite aliasy @/ pre čisté importy.',
    'Pridaj Tailwind CSS alebo vlastný CSS procesor.',
    'Vytvor samostatný state manager cez Zustand.'
  ],
  data: `export const frameworkInfo = {
  name: "Vite 6",
  ecosystem: "Native ESM + Rollup",
  stars: "72k+",
  repo: "vitejs/vite"
};`,
  app: String.raw`import { useState } from 'react';
import { Header } from './components/Header';
import { frameworkInfo } from './data';

export default function App() {
  const [speed, setSpeed] = useState(1);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans">
      <Header section="Vite 6 Core Starter" />
      <main className="flex-1 max-w-4xl w-full mx-auto p-6 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 mb-6 flex items-center justify-center rounded-2xl bg-gradient-to-tr from-cyan-950/60 to-purple-950/60 border border-purple-500/30 text-white shadow-xl shadow-purple-500/10">
          <svg className="w-12 h-12" viewBox="0 0 32 32">
            <defs>
              <linearGradient id="vite_g1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#41D1FF"/>
                <stop offset="100%" stopColor="#BD34FE"/>
              </linearGradient>
              <linearGradient id="vite_g2" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#FFEA83"/>
                <stop offset="100%" stopColor="#FFDD35"/>
              </linearGradient>
            </defs>
            <path d="M29.5 5.5L16.5 29.5L2.5 5.5L19 3L29.5 5.5Z" fill="url(#vite_g1)"/>
            <path d="M17.5 4L9 16.5H15.5L13.5 26L23 13.5H16.5L17.5 4Z" fill="url(#vite_g2)"/>
          </svg>
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4 bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-yellow-300 to-purple-400">
          {frameworkInfo.name} Core Stack
        </h1>
        <p className="text-neutral-400 text-lg max-w-xl mb-8">
          Extrémne rýchly nástroj pre moderný web. Natívne ES moduly pri vývoji a vysoko optimalizovaný Rollup build pre produkciu.
        </p>

        <div className="flex gap-4 items-center">
          <button
            onClick={() => setSpeed(s => s * 2 > 64 ? 1 : s * 2)}
            className="px-6 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-purple-500 hover:opacity-90 text-neutral-950 font-bold transition shadow-lg shadow-purple-500/20 active:scale-95"
          >
            HMR Rýchlosť: {speed}x ⚡
          </button>
        </div>
      </main>
    </div>
  );
}`
});
