/* Port 1:1 z legacy demo/index.html — blueprint galéria a prompt knižnica (demo/mock dáta). */

export interface Blueprint {
  id: string;
  kind: 'saas' | 'kanban' | 'settings' | 'dashboard';
  emoji: string;
  name: string;
  desc: string;
  stack: string;
  time: string;
  demo: string;
}

export const BLUEPRINTS: Blueprint[] = [
  { id: 'bp-saas', kind: 'saas', emoji: '🚀', name: 'SaaS Landing', desc: 'Hero, features, pricing, CTA — one-page pre startup.', stack: 'HTML · CSS · JS', time: '~40 s', demo: 'linear-gradient(135deg,#2563eb,#38bdf8)' },
  { id: 'bp-kanban', kind: 'kanban', emoji: '📋', name: 'Kanban Board', desc: 'Drag & drop tickety, tímový board, tmavý panel.', stack: 'HTML · CSS · JS', time: '~45 s', demo: 'linear-gradient(135deg,#1e40af,#7c3aed)' },
  { id: 'bp-settings', kind: 'settings', emoji: '⚙️', name: 'Settings Dashboard', desc: 'Profil, notifikácie, billing, security sekcie.', stack: 'HTML · CSS · JS', time: '~40 s', demo: 'linear-gradient(135deg,#0ea5e9,#2563eb)' },
  { id: 'bp-crm', kind: 'dashboard', emoji: '📊', name: 'CRM Dashboard', desc: 'KPI karty, grafy, pipeline tabuľka s filtrami.', stack: 'HTML · CSS · JS', time: '~50 s', demo: 'linear-gradient(135deg,#2563eb,#0d9488)' },
  { id: 'bp-blog', kind: 'dashboard', emoji: '✍️', name: 'Blog SaaS', desc: 'Články, autori, tagy — redakčná obsahová platforma.', stack: 'HTML · CSS · JS', time: '~45 s', demo: 'linear-gradient(135deg,#38bdf8,#6366f1)' },
  { id: 'bp-eshop', kind: 'dashboard', emoji: '🛒', name: 'E-shop Dashboard', desc: 'Objednávky, produkty, tržby, conversion metriky.', stack: 'HTML · CSS · JS', time: '~50 s', demo: 'linear-gradient(135deg,#475569,#2563eb)' },
];

export interface PromptLibEntry { cat: string; title: string; text: string }

export const PROMPT_LIB: PromptLibEntry[] = [
  { cat: 'Build', title: 'Landing page s CTA', text: 'Postav modernú landing page pre [názov produktu] — hero, 3 benefity, pricing a CTA. Odvetvie: [odvetvie].' },
  { cat: 'Build', title: 'Dashboard s KPI', text: 'Vytvor dashboard pre [oblasť] s KPI kartami, grafom a tabuľkou. Obdobie: [mesiac].' },
  { cat: 'Edit', title: 'Prethemesuj na tmavé', text: 'Prethemesuj aplikáciu na tmavú tému — pozadie [hex], akcent [hex], zachovaj kontrast a čitateľnosť.' },
  { cat: 'Edit', title: 'Pridaj sekciu', text: 'Pridaj sekciu [názov] medzi [sekcia A] a [sekcia B]. Zachovaj existujúci štýl a spacing.' },
  { cat: 'Fix', title: 'Oprav layout bug', text: 'Oprav: [popis bugu]. Over, že na mobile (390 px) sa nič nepreleje.' },
  { cat: 'Explain', title: 'Vysvetli kód', text: 'Vysvetli, čo robí [súbor/funkcia] a prečo je to tak napísané. Stručne.' },
  { cat: 'Tests', title: 'Napíš testy', text: 'Napíš testy pre [funkcia] — happy path, edge cases a chybové stavy.' },
  { cat: 'SEO', title: 'SEO meta', text: 'Doplň SEO meta pre [stránku]: title, description, Open Graph. Kľúčové slová: [slová].' },
];
