/* Port 1:1 z demo/index.html - demo/sablonovy rezim generovania (ziadny realny AI engine).
   Explicitne oznaceny template mod: rovnake sablony ako v legacy aplikacii. */

import { esc } from '../utils';

export type AppKind = 'saas' | 'kanban' | 'settings' | 'dashboard';
export interface KindInfo { kind: AppKind; file: string; name: string; re?: RegExp }

export function buildSaas(): string {
  return `<!doctype html>
<html lang="sk"><head><meta charset="utf-8"><title>Nimbus — AI SaaS</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
body{background:#fafafc;color:#0f172a}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
nav{display:flex;align-items:center;justify-content:space-between;padding:18px 0}
nav b{font-size:19px;letter-spacing:-.3px}
nav b i{color:#7c3aed;font-style:normal}
nav .links{display:flex;gap:26px;font-size:14px;color:#475569}
nav .cta{background:#7c3aed;color:#fff;padding:9px 18px;border-radius:9px;font-size:14px;font-weight:600}
.hero{text-align:center;padding:64px 0 76px;position:relative}
.hero .glow{position:absolute;inset:-40px;background:radial-gradient(420px 220px at 50% 30%,rgba(124,58,237,.16),transparent);pointer-events:none}
.badge{display:inline-block;background:#f3eefc;color:#7c3aed;font-size:12.5px;font-weight:600;padding:5px 14px;border-radius:30px;margin-bottom:20px}
h1{font-size:52px;letter-spacing:-1.5px;line-height:1.08}
h1 em{font-style:normal;background:linear-gradient(90deg,#7c3aed,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:#64748b;font-size:17px;max-width:520px;margin:18px auto 30px;line-height:1.6}
.btns{display:flex;gap:12px;justify-content:center}
.btn-p{background:#7c3aed;color:#fff;padding:13px 26px;border-radius:11px;font-size:15px;font-weight:600;box-shadow:0 8px 24px rgba(124,58,237,.3)}
.btn-g{background:#fff;border:1px solid #e2e8f0;color:#334155;padding:13px 26px;border-radius:11px;font-size:15px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:24px 0 64px}
.card{background:#fff;border:1px solid #eef0f5;border-radius:15px;padding:22px;transition:.2s}
.card:hover{transform:translateY(-3px);box-shadow:0 14px 34px rgba(15,23,42,.09)}
.card .ic{width:38px;height:38px;border-radius:10px;background:#f3eefc;display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:13px}
.card h3{font-size:16px;margin-bottom:7px}
.card p{font-size:13.5px;color:#64748b;line-height:1.6}
.stats{display:flex;justify-content:space-around;border-top:1px solid #eef0f5;border-bottom:1px solid #eef0f5;padding:28px 0;margin-bottom:56px;text-align:center}
.stats b{display:block;font-size:29px;letter-spacing:-.5px;color:#7c3aed}
.stats span{font-size:12.5px;color:#94a3b8}
footer{text-align:center;color:#94a3b8;font-size:13px;padding:26px 0;border-top:1px solid #eef0f5}
</style></head><body>
<div class="wrap">
  <nav><b>Nimbus<i>.</i></b><div class="links"><span>Produkt</span><span>Cenník</span><span>Dokumentácia</span><span>Blog</span></div><span class="cta">Začať zdarma</span></nav>
  <section class="hero"><div class="glow"></div>
    <div class="badge">✨ Nové: Nimbus AI 2.0 je tu</div>
    <h1>Škáluj rýchlejšie<br><em>s AI-driven analytikou</em></h1>
    <p class="sub">Nimbus prepája vaše dáta, notifikácie a reporting do jedného dashboardu. Bez kódu, bez čakania.</p>
    <div class="btns"><span class="btn-p">Začať zdarma</span><span class="btn-g">Žiadať demo →</span></div>
  </section>
  <section class="grid">
    <div class="card"><div class="ic">⚡</div><h3>Realtime rýchlosť</h3><p>Dotazy nad 50M riadkami vráti výsledok pod 90 ms vďaka edge replikám.</p></div>
    <div class="card"><div class="ic">🛡️</div><h3>Safety-first</h3><p>SOC 2 Type II, end-to-end šifrovanie a granulárne prístupové práva.</p></div>
    <div class="card"><div class="ic">🧩</div><h3>120+ integrácií</h3><p>Stripe, Slack, Notion, Linear a ďalšie — pripojenie na 2 kliky.</p></div>
  </section>
  <section class="stats">
    <div><b>12 400+</b><span>aktívnych tímov</span></div>
    <div><b>99.99%</b><span>uptime SLA</span></div>
    <div><b>4.9/5</b><span>na G2 &amp; Capterra</span></div>
    <div><b>38%</b><span>nižšie náklady</span></div>
  </section>
  <footer>© 2026 Nimbus, s.r.o. — Built with Forge</footer>
</div></body></html>`;
}

export function buildKanban(): string {
  return `<!doctype html>
<html lang="sk"><head><meta charset="utf-8"><title>FlowDeck — Kanban</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
body{background:#101014;min-height:100%;color:#e4e4e7;padding:22px}
.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.head h1{font-size:19px;letter-spacing:-.3px}
.head h1 i{color:#a855f7;font-style:normal}
.head p{font-size:12px;color:#71717a;margin-top:3px}
.add{background:#a855f7;color:#fff;font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px}
.board{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.col{background:#17171c;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:13px;min-height:320px}
.col-h{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;margin-bottom:12px}
.tag-dot{width:8px;height:8px;border-radius:50%}
.count{margin-left:auto;font-size:11px;color:#71717a;background:rgba(255,255,255,.06);padding:1px 8px;border-radius:12px}
.card{background:#1f1f26;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px;margin-bottom:10px;transition:.18s;cursor:grab}
.card:hover{transform:translateY(-2px);border-color:rgba(168,85,247,.5)}
.card h4{font-size:13px;font-weight:600;margin-bottom:8px}
.chips{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px}
.chip{font-size:10px;padding:2px 8px;border-radius:11px;font-weight:600}
.c-design{background:rgba(168,85,247,.16);color:#d8b4fe}
.c-bug{background:rgba(248,113,113,.14);color:#fca5a5}
.c-feat{background:rgba(52,211,153,.13);color:#6ee7b7}
.c-doc{background:rgba(251,191,36,.13);color:#fcd34d}
.row{display:flex;align-items:center;justify-content:space-between}
.due{font-size:10.5px;color:#71717a}
.av{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff}
.new-card{width:100%;border:1px dashed rgba(255,255,255,.15);border-radius:9px;padding:9px;color:#71717a;font-size:12px;background:none;cursor:pointer}
.new-card:hover{color:#a1a1aa;border-color:rgba(168,85,247,.5)}
</style></head><body>
<div class="head">
  <div><h1>FlowDeck <i>· Šprint 42</i></h1><p>3 stĺpce · 7 kariet · update pred 2 min</p></div>
  <button class="add">+ Nová karta</button>
</div>
<div class="board">
  <div class="col">
    <div class="col-h"><span class="tag-dot" style="background:#f87171"></span>Todo<span class="count">3</span></div>
    <div class="card"><h4>Redizajn onboarding flow</h4><div class="chips"><span class="chip c-design">design</span><span class="chip c-feat">v2.0</span></div><div class="row"><span class="due">📅 12. okt</span><span class="av" style="background:#7c3aed">MK</span></div></div>
    <div class="card"><h4>Migrácia DB na Postgres 16</h4><div class="chips"><span class="chip c-bug">infra</span></div><div class="row"><span class="due">📅 18. okt</span><span class="av" style="background:#0ea5e9">JT</span></div></div>
    <div class="card"><h4>Docs: API reference v2</h4><div class="chips"><span class="chip c-doc">docs</span></div><div class="row"><span class="due">Backlog</span><span class="av" style="background:#f59e0b">LA</span></div></div>
    <button class="new-card">+ Pridať kartu</button>
  </div>
  <div class="col">
    <div class="col-h"><span class="tag-dot" style="background:#fbbf24"></span>Rozpracované<span class="count">2</span></div>
    <div class="card"><h4>Refaktor auth modulu</h4><div class="chips"><span class="chip c-bug">bug #341</span><span class="chip c-design">prio</span></div><div class="row"><span class="due">📅 9. okt</span><span class="av" style="background:#a855f7">ZK</span></div></div>
    <div class="card"><h4>A/B test pricing page</h4><div class="chips"><span class="chip c-feat">growth</span></div><div class="row"><span class="due">📅 10. okt</span><span class="av" style="background:#10b981">NP</span></div></div>
    <button class="new-card">+ Pridať kartu</button>
  </div>
  <div class="col">
    <div class="col-h"><span class="tag-dot" style="background:#34d399"></span>Hotovo<span class="count">2</span></div>
    <div class="card"><h4>✅ Dark mode pre celý app</h4><div class="chips"><span class="chip c-feat">v1.8</span></div><div class="row"><span class="due">Hotové 6. okt</span><span class="av" style="background:#f43f5e">EV</span></div></div>
    <div class="card"><h4>✅ Optimalizácia bundle o 41%</h4><div class="chips"><span class="chip c-doc">perf</span></div><div class="row"><span class="due">Hotové 5. okt</span><span class="av" style="background:#7c3aed">MK</span></div></div>
    <button class="new-card">+ Pridať kartu</button>
  </div>
</div></body></html>`;
}

export function buildSettings(): string {
  return `<!doctype html>
<html lang="sk"><head><meta charset="utf-8"><title>Aurora — Settings</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
body{background:#f6f7f9;color:#0f172a;display:flex;min-height:100%}
.side{width:228px;background:#fff;border-right:1px solid #e6e8ee;padding:22px 14px;display:flex;flex-direction:column;gap:3px}
.side .logo{font-size:18px;font-weight:800;margin:0 10px 20px;letter-spacing:-.4px}
.side .logo i{color:#7c3aed;font-style:normal}
.side a{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:9px;font-size:13.5px;color:#475569;text-decoration:none}
.side a.on{background:#f3eefc;color:#6d28d9;font-weight:600}
.side a:hover{background:#f1f5f9}
.side .out{margin-top:auto;color:#94a3b8;font-size:12.5px}
main{flex:1;padding:30px 38px;max-width:760px}
.breadcrumb{font-size:12.5px;color:#94a3b8;margin-bottom:8px}
h1{font-size:23px;letter-spacing:-.4px;margin-bottom:20px}
.card{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:20px;margin-bottom:16px}
.card h2{font-size:14.5px;margin-bottom:4px}
.card .desc{font-size:12.5px;color:#94a3b8;margin-bottom:14px}
.profile{display:flex;align-items:center;gap:14px}
.pav{width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#a855f7);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:17px}
.profile b{font-size:15px}.profile span{font-size:12.5px;color:#94a3b8;display:block}
.row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f1f5f9}
.row:last-child{border-bottom:none}
.row .l b{font-size:13.5px;font-weight:600;display:block}
.row .l span{font-size:11.5px;color:#94a3b8}
.sw{width:38px;height:21px;border-radius:11px;background:#e2e8f0;position:relative;cursor:pointer;transition:.18s;flex-shrink:0}
.sw::after{content:"";position:absolute;top:2.5px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:.18s}
.sw.on{background:#7c3aed}
.sw.on::after{left:19px}
.save-bar{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}
.btn{padding:10px 20px;border-radius:9px;font-size:13.5px;font-weight:600}
.btn.ghost{background:#fff;border:1px solid #e2e8f0;color:#475569}
.btn.pri{background:#7c3aed;color:#fff;box-shadow:0 6px 18px rgba(124,58,237,.3)}
</style></head><body>
<aside class="side">
  <div class="logo">Aurora<i>.</i></div>
  <a href="#">📋 Prehľad</a>
  <a href="#" class="on">⚙️ Nastavenia</a>
  <a href="#">👥 Členovia</a>
  <a href="#">🔑 API kľúče</a>
  <a href="#">🧾 Fakturácia</a>
  <a href="#" class="out">↩ Odhlásiť sa</a>
</aside>
<main>
  <div class="breadcrumb">Workspace / Nastavenia</div>
  <h1>Nastavenia workspace</h1>
  <div class="card">
    <h2>Profil</h2><div class="desc">Tieto údaje sa zobrazujú ostatným členom tímu.</div>
    <div class="profile"><div class="pav">JH</div><div><b>Jana Hrušková</b><span>jana@aurora.app · Owner</span></div></div>
  </div>
  <div class="card">
    <h2>Preferencie</h2><div class="desc">Prispôsob si správanie workspace.</div>
    <div class="row"><div class="l"><b>Emailové notifikácie</b><span>Týždenný súhrn aktivít</span></div><div class="sw on"></div></div>
    <div class="row"><div class="l"><b>Dvojfaktorové overenie</b><span>Prihlásenie cez TOTP app</span></div><div class="sw on"></div></div>
    <div class="row"><div class="l"><b>Kompaktný režim</b><span>Hustejšie riadky v tabuľkách</span></div><div class="sw"></div></div>
    <div class="row"><div class="l"><b>Telemetria</b><span>Anonymné štatistiky používania</span></div><div class="sw"></div></div>
  </div>
  <div class="save-bar"><span class="btn ghost">Zrušiť</span><span class="btn pri">Uložiť zmeny</span></div>
</main></body></html>`;
}

export function buildDashboard(prompt: string): string {
  const p = esc(prompt).slice(0,40);
  return `<!doctype html>
<html lang="sk"><head><meta charset="utf-8"><title>Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
body{background:#f6f5f1;color:#1c1b17;padding:24px}
h1{font-size:20px;letter-spacing:-.3px;margin-bottom:4px}
.sub{font-size:12.5px;color:#8a867c;margin-bottom:22px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid #e9e6de;border-radius:14px;padding:16px}
.kpi span{font-size:11.5px;color:#8a867c}
.kpi b{display:block;font-size:24px;margin:6px 0 4px;letter-spacing:-.5px}
.delta{font-size:11px;font-weight:600}
.up{color:#059669}.down{color:#dc2626}
.chart{background:#fff;border:1px solid #e9e6de;border-radius:14px;padding:20px;margin-bottom:18px}
.chart h3{font-size:13.5px;margin-bottom:16px}
.bars{display:flex;align-items:flex-end;gap:14px;height:150px}
.bar{flex:1;background:linear-gradient(180deg,#a855f7,#7c3aed);border-radius:6px 6px 2px 2px;position:relative;transition:.2s}
.bar:hover{filter:brightness(1.15)}
.bar i{position:absolute;top:-20px;left:50%;transform:translateX(-50%);font-style:normal;font-size:10.5px;color:#8a867c}
.legend{display:flex;gap:8px;margin-top:14px}
.legend span{font-size:11px;color:#8a867c;background:#f4f2ec;padding:4px 10px;border-radius:12px}
</style></head><body>
<h1>Dashboard</h1>
<div class="sub">Generované z promptu: „${p}…“</div>
<div class="kpis">
  <div class="kpi"><span>Navštevy</span><b>48 210</b><span class="delta up">▲ 12.4%</span></div>
  <div class="kpi"><span>Konverzia</span><b>3.8%</b><span class="delta up">▲ 0.6 pp</span></div>
  <div class="kpi"><span>Priem. čas</span><b>2m 41s</b><span class="delta down">▼ 8.1%</span></div>
  <div class="kpi"><span>Chyby</span><b>0.02%</b><span class="delta up">▲ stab.</span></div>
</div>
<div class="chart">
  <h3>Týždenná aktivita</h3>
  <div class="bars">
    <div class="bar" style="height:44%"><i>44</i></div><div class="bar" style="height:62%"><i>62</i></div>
    <div class="bar" style="height:38%"><i>38</i></div><div class="bar" style="height:81%"><i>81</i></div>
    <div class="bar" style="height:95%"><i>95</i></div><div class="bar" style="height:71%"><i>71</i></div>
    <div class="bar" style="height:56%"><i>56</i></div>
  </div>
  <div class="legend"><span>Posledných 7 dní</span><span>Update: práve teraz</span></div>
</div></body></html>`;
}

export const SNIPPETS = {
  saas: `<section class="hero">
  <span class="badge">✨ Nové: Nimbus AI 2.0</span>
  <h1>Škáluj rýchlejšie <em>s AI</em></h1>
</section>`,
  kanban: `<div class="board">
  <div class="col">
    <div class="col-h">Todo <span class="count">3</span></div>
    <div class="card">…</div>
  </div>
</div>`,
  settings: `<div class="card">
  <h2>Preferencie</h2>
  <div class="row">…</div>
</div>`,
  dashboard: `<div class="kpis">
  <div class="kpi"><b>48 210</b></div>
</div>`
};
export const THUMBS = {
  saas:'linear-gradient(135deg,#7c3aed,#ec4899)', kanban:'linear-gradient(135deg,#1f1f26,#a855f7)',
  settings:'linear-gradient(135deg,#7c3aed,#0ea5e9)', dashboard:'linear-gradient(135deg,#a855f7,#f59e0b)'
};


export const KINDS: KindInfo[] = [
  { re:/landing|saas|hero|web|blog/i, kind:'saas', file:'index.html', name:'SaaS Landing Page' },
  { re:/kanban|board|stĺpc/i, kind:'kanban', file:'board.html', name:'Kanban Board' },
  { re:/settings|nastaven|dashboard|profil|crm/i, kind:'settings', file:'settings.html', name:'Settings Dashboard' },
];
export const KIND_INFO = {
  saas: { file:'index.html', name:'SaaS Landing Page' },
  kanban: { file:'board.html', name:'Kanban Board' },
  settings: { file:'settings.html', name:'Settings Dashboard' },
  dashboard: { file:'dashboard.html', name:'Dashboard' },
};
export function detectKind(text: string): KindInfo {
  for (const k of KINDS) if (k.re && k.re.test(text)) return k;
  return { kind:'dashboard', file:'dashboard.html', name:'Dashboard' };
}
