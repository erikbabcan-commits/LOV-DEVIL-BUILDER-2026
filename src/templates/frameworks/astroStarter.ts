import { defineBlueprint } from '../factory';
import type { Blueprint } from '../types';

export const astroStarter: Blueprint = defineBlueprint({
  id: 'fw-astro',
  title: 'Astro 5 (Islands Architecture)',
  description: 'Ultra-rýchly content framework s nulovým zbytočným JavaScriptom a podporou moderných UI ostrovov (React, Svelte, Vue).',
  category: 'Obsah',
  icon: '🚀',
  tags: ['astro', 'islands', 'content', 'fast', 'seo'],
  features: ['Astro 5 Content Collections', 'Nulový defaultný JavaScript overhead', 'Špičkové 100/100 Lighthouse skóre'],
  followups: [
    'Pridaj blogový príspevok cez Markdown/MDX.',
    'Vlož interaktívny React ostrov client:load.',
    'Optimalizuj SEO metadáta a automatický sitemap generator.'
  ],
  data: `export const frameworkInfo = {
  name: "Astro 5",
  ecosystem: "Islands + Zero JS",
  stars: "48k+",
  repo: "withastro/astro"
};`,
  app: String.raw`import { useState } from 'react';
import { Header } from './components/Header';
import { frameworkInfo } from './data';

export default function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      <Header section="Astro 5 Islands" />
      <main className="flex-1 max-w-4xl w-full mx-auto p-6 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 mb-6 flex items-center justify-center rounded-2xl bg-purple-950/40 border border-purple-500/30 text-white shadow-xl shadow-purple-500/10">
          <svg className="w-12 h-12" viewBox="0 0 256 364">
            <defs>
              <linearGradient id="astro_grad_app" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#BC52EE"/>
                <stop offset="100%" stopColor="#6D28D9"/>
              </linearGradient>
              <linearGradient id="astro_flame_app" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#FF5D01"/>
                <stop offset="100%" stopColor="#FFBD38"/>
              </linearGradient>
            </defs>
            <path d="M128 0C128 0 88 56 88 140C88 196 116 236 128 252C140 236 168 196 168 140C168 56 128 0 128 0Z" fill="url(#astro_grad_app)"/>
            <path d="M128 252C118 274 100 300 80 320C110 324 140 310 152 290C140 278 132 264 128 252Z" fill="url(#astro_flame_app)"/>
            <path d="M64 164C64 164 40 196 40 248C56 248 80 240 96 228C84 204 74 182 64 164Z" fill="url(#astro_grad_app)"/>
            <path d="M192 164C192 164 216 196 216 248C200 248 176 240 160 228C172 204 182 182 192 164Z" fill="url(#astro_grad_app)"/>
          </svg>
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4 bg-clip-text text-transparent bg-gradient-to-r from-purple-400 via-pink-500 to-orange-400">
          {frameworkInfo.name} Islands
        </h1>
        <p className="text-zinc-400 text-lg max-w-xl mb-8">
          Web orientovaný na obsah s bezkonkurenčnou rýchlosťou. Zostavený tak, aby do prehliadača odosielal čisté HTML a JavaScript načítaval len tam, kde je to skutočne potrebné.
        </p>

        <div className="flex gap-4 items-center">
          <a
            href="https://astro.build"
            target="_blank"
            rel="noreferrer"
            className="px-6 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-orange-500 hover:opacity-90 text-white font-semibold transition shadow-lg shadow-orange-500/20 active:scale-95"
          >
            Astro.build Portál ↗
          </a>
        </div>
      </main>
    </div>
  );
}`
});
