import { defineBlueprint } from '../factory';
import type { Blueprint } from '../types';

export const nextjsStarter: Blueprint = defineBlueprint({
  id: 'fw-nextjs',
  title: 'Next.js 15 (App Router)',
  description: 'Full-stack React framework s podporou Server Components, optimalizácie assetov a priameho Vercel deployu.',
  category: 'Aplikácie',
  icon: '▲',
  tags: ['nextjs', 'react', 'fullstack', 'ssr', 'typescript'],
  features: ['Next.js 15 App Router štruktúra', 'Tailwind CSS & Server Components', 'Vercel 1-Click ready'],
  followups: [
    'Vytvor API route /api/hello pre backend dáta.',
    'Pridaj dynamickú stránku s routingom /blog/[slug].',
    'Integruj Server Action pre odosielanie formulárov.'
  ],
  data: `export const frameworkInfo = {
  name: "Next.js 15",
  ecosystem: "Vercel + App Router",
  stars: "130k+",
  repo: "vercel/next.js"
};`,
  app: String.raw`import { useState } from 'react';
import { Header } from './components/Header';
import { frameworkInfo } from './data';

export default function App() {
  const [activeTab, setActiveTab] = useState('app');

  return (
    <div className="min-h-screen bg-black text-white flex flex-col font-sans">
      <Header section="Next.js 15 App Router" />
      <main className="flex-1 max-w-4xl w-full mx-auto p-6 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 mb-6 flex items-center justify-center rounded-2xl bg-zinc-900 border border-zinc-800 text-white shadow-2xl">
          <svg className="w-12 h-12" viewBox="0 0 180 180">
            <circle cx="90" cy="90" r="88" fill="#000" stroke="#333" strokeWidth="2"/>
            <path d="M149.5 157.5L69.1 54H54V126H66.1V69.4L140 164.8C143.3 162.6 146.5 160.2 149.5 157.5Z" fill="#fff"/>
            <rect x="115" y="54" width="12" height="72" fill="#fff"/>
          </svg>
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4 bg-clip-text text-transparent bg-gradient-to-b from-white to-zinc-400">
          {frameworkInfo.name} App Router
        </h1>
        <p className="text-zinc-400 text-lg max-w-xl mb-8">
          Full-stack architektúra s podporou Server & Client komponentov. Po exporte na GitHub sa cez webhook automaticky nasadí na Vercel.
        </p>

        <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800 text-left max-w-md w-full mb-8 font-mono text-sm text-zinc-300">
          <div className="text-zinc-500 mb-2">// Projektová štruktúra:</div>
          <div>📁 app/</div>
          <div className="pl-4">📄 page.tsx (Server Component)</div>
          <div className="pl-4">📄 layout.tsx</div>
          <div>📁 components/</div>
          <div>📄 next.config.mjs</div>
        </div>

        <div className="flex gap-4">
          <a
            href="https://nextjs.org/docs"
            target="_blank"
            rel="noreferrer"
            className="px-6 py-3 rounded-xl bg-white hover:bg-zinc-200 text-black font-semibold transition shadow-lg active:scale-95"
          >
            Next.js Dokumentácia ↗
          </a>
        </div>
      </main>
    </div>
  );
}`
});
