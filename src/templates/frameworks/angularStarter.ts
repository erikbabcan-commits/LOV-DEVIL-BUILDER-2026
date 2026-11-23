import { defineBlueprint } from '../factory';
import type { Blueprint } from '../types';

export const angularStarter: Blueprint = defineBlueprint({
  id: 'fw-angular',
  title: 'Angular 19 (Signals & Standalone)',
  description: 'Robustný enterprise framework s novým reaktívnym modelom Signals, Standalone komponentmi a vysokou typovou bezpečnosťou.',
  category: 'Aplikácie',
  icon: '🅰️',
  tags: ['angular', 'signals', 'enterprise', 'typescript'],
  features: ['Angular 19 Signals reaktivita', 'Standalone komponenty bez NgModule', 'Enterprise architektúra'],
  followups: [
    'Pridaj signál pre správu stavu používateľa.',
    'Vytvor data service s dependency injection.',
    'Pridaj validáciu reaktívneho formulára.'
  ],
  data: `export const frameworkInfo = {
  name: "Angular 19",
  ecosystem: "Google + Signals",
  stars: "96k+",
  repo: "angular/angular"
};`,
  app: String.raw`import { useState } from 'react';
import { Header } from './components/Header';
import { frameworkInfo } from './data';

export default function App() {
  const [signalValue, setSignalValue] = useState('active');

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans">
      <Header section="Angular 19 Standalone" />
      <main className="flex-1 max-w-4xl w-full mx-auto p-6 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 mb-6 flex items-center justify-center rounded-2xl bg-gradient-to-tr from-pink-950/60 to-purple-950/60 border border-pink-500/30 text-white shadow-xl shadow-pink-500/10">
          <svg className="w-12 h-12" viewBox="0 0 250 250">
            <defs>
              <linearGradient id="ang_grad_main" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#E91E63"/>
                <stop offset="50%" stopColor="#BD10E0"/>
                <stop offset="100%" stopColor="#9C27B0"/>
              </linearGradient>
            </defs>
            <polygon points="125,18 226,54 209,190 125,236 41,190 24,54" fill="url(#ang_grad_main)"/>
            <polygon points="125,48 190,180 162,180 148,148 102,148 88,180 60,180" fill="#ffffff"/>
            <polygon points="125,82 110,124 140,124" fill="url(#ang_grad_main)"/>
          </svg>
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4 bg-clip-text text-transparent bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500">
          {frameworkInfo.name} Signals
        </h1>
        <p className="text-slate-300 text-lg max-w-xl mb-8">
          Enterprise štartér s modernou Signals reaktivitou a Standalone komponentmi. Žiadny starý boilerplate, len čistý a rýchly TypeScript.
        </p>

        <div className="flex gap-4 items-center">
          <button
            onClick={() => setSignalValue(v => v === 'active' ? 'computed' : 'active')}
            className="px-6 py-3 rounded-xl bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 text-white font-semibold transition shadow-lg shadow-purple-500/25 active:scale-95"
          >
            Signál stav: {signalValue}()
          </button>
        </div>
      </main>
    </div>
  );
}`
});
