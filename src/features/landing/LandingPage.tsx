import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores/useAppStore';
import type { AppKind } from '../../lib/templates';
import type { QuotaInfo } from '../../services/auth';
import { Sidebar } from '../../components/Sidebar';
import { loadProjects, type StoredProject } from '../../services/persistence/db';

/* VORKEI Workspace landing: 100dvh lock, graphite canvas (#171717), hero 42px, neon composer,
   4 pilulky, 3 dynamické moduly (Projekty, Kredity, Konektory) podľa newUIUX.md. */

const PILLS: Array<{ kind: AppKind; label: string; prompt: string; icon: JSX.Element }> = [
  {
    kind: 'saas', label: 'Web pre štúdio', prompt: 'Web pre štúdio s ponukou služieb',
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="m10 15 5-3-5-3v6Z" /></svg>
  },
  {
    kind: 'kanban', label: 'Kanban', prompt: 'Kanban board s 3 stĺpcami',
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="6" height="14" x="4" y="5" rx="1" /><rect width="6" height="10" x="14" y="5" rx="1" /></svg>
  },
  {
    kind: 'dashboard', label: 'CRM', prompt: 'CRM Dashboard s prehľadom',
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
  },
  {
    kind: 'settings', label: 'Blog', prompt: 'Jednoduchý blog so zoznamom článkov',
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" /></svg>
  },
];

function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return 'Práve teraz';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Upravené pred ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `Upravené pred ${diffHours} h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Upravené včera';
  if (diffDays < 7) return `Upravené pred ${diffDays} dňami`;
  return new Date(timestamp).toLocaleDateString('sk-SK');
}

export function LandingPage({ quota }: { quota?: QuotaInfo }) {
  const generate = useStore(s => s.generate);
  const isPublic = useStore(s => s.isPublic);
  const togglePublic = useStore(s => s.togglePublic);
  const model = useStore(s => s.model);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const promptDraft = useStore(state => state.promptDraft);
  const setPromptDraft = useStore(state => state.setPromptDraft);
  const busy = useStore(state => state.generating || state.pendingReview !== null);
  const checkGitHubAuth = useStore(s => s.checkGitHubAuth);
  const githubAuthState = useStore(s => s.githubAuthState);
  const storeQuota = useStore(s => (s as { quota?: QuotaInfo }).quota);
  const [projects, setProjects] = useState<StoredProject[]>([]);

  useEffect(() => {
    let active = true;
    loadProjects().then(list => {
      if (active) setProjects(list);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'test') {
      void checkGitHubAuth();
    }
    if (promptDraft && document.activeElement !== inputRef.current) {
      inputRef.current?.focus();
    }
  }, [promptDraft, checkGitHubAuth]);

  const activeQuota = quota || storeQuota;
  const creditsRemaining = activeQuota ? activeQuota.remaining : 1240;
  const creditsTotal = activeQuota ? activeQuota.limit : 2000;
  const creditsUsed = activeQuota ? (activeQuota.limit - activeQuota.remaining) : (2000 - 1240);
  const creditsPercent = Math.min(100, Math.max(0, Math.round((creditsRemaining / creditsTotal) * 100)));

  const handleOpenProject = async (projectId: string) => {
    try {
      const { openLocalWorkspace } = await import('../../services/projects/workspace');
      await openLocalWorkspace(projectId, new AbortController().signal);
    } catch {
      useStore.getState().goEditor();
    }
  };

  const handleGitHubClick = async () => {
    if (githubAuthState.authenticated) {
      useStore.getState().toast(`GitHub pripojený (${githubAuthState.username || 'aktívny'})`, 'info');
    } else {
      try {
        const { startGitHubConnect } = await import('../../services/githubConnect');
        await startGitHubConnect();
      } catch {
        useStore.getState().toast('GitHub pripojenie zlyhalo', 'error');
      }
    }
  };

  const submit = () => {
    const v = promptDraft.trim();
    if (!v || busy) return;
    setPromptDraft('');
    const st = useStore.getState();
    if (st.model !== 'Instant Draft') {
      void st.generateWithAi(v, 'auto');
    } else {
      generate(v);
    }
  };

  const sendActive = !!promptDraft.trim() && !busy;

  return (
    <div
      className="carbon-canvas"
      style={{
        display: 'flex',
        height: 'calc(100dvh - 56px)',
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      <Sidebar activeTab="overview" />

      <main
        className="lumen-main"
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '20px 48px',
          boxSizing: 'border-box'
        }}
      >
        {/* Horná lišta 32px: značka + Carbon Core vľavo, kredity + Upgradovať vpravo */}
        <div style={{ height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary, #FAFAFA)' }}>VORKEI</span>
            <span style={{ color: 'var(--text-muted, #71717A)', fontSize: '13px' }}>/</span>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary, #A1A1AA)' }}>Štúdio</span>
            <span className="carbon-core-badge"><i aria-hidden="true" />Carbon Core</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span className="font-mono" style={{ fontSize: '12px', color: 'var(--text-secondary, #A1A1AA)', fontVariantNumeric: 'tabular-nums' }}>
              {quota ? `${quota.remaining} kreditov` : 'Pilot režim'}
            </span>
            <button
              type="button"
              className="neon-btn-outline"
              style={{ height: '32px', padding: '0 14px', fontSize: '12px', fontWeight: 500, cursor: 'pointer' }}
              onClick={() => useStore.getState().toast('Upgrade plán — čoskoro', 'warn')}
            >
              Upgradovať
            </button>
          </div>
        </div>

        {/* Hero + Composer (vertikálne centrované) */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <h1 className="lumen-h1" style={{ margin: 0, textAlign: 'center' }}>
            Čo chceš <span style={{ color: 'var(--neon-green, #4ADE80)' }}>postaviť</span>?
          </h1>
          <p style={{ margin: '8px 0 0', fontSize: '14px', lineHeight: '20px', color: 'var(--text-secondary, #A1A1AA)', textAlign: 'center', maxWidth: '460px' }}>
            Opíš svoj nápad. Vytvoríme prvý návrh.
          </p>

          {/* Rotujúci neónový border okolo composeru */}
          <div className="neon-composer-shell" style={{ width: '100%', maxWidth: '730px', marginTop: '24px' }}>
            <div className="carbon-composer-inner">
              <textarea
                id="homeInput"
                ref={inputRef}
                rows={3}
                className="custom-scrollbar"
                aria-label="Tvoj nápad"
                value={promptDraft}
                onChange={e => setPromptDraft(e.target.value)}
                placeholder="Napríklad: web pre moje štúdio s ponukou služieb…"
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--text-primary, #FAFAFA)',
                  fontSize: '15px',
                  lineHeight: '24px',
                  resize: 'none',
                  fontFamily: 'inherit'
                }}
                onKeyDown={e => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
              />

              {/* Spodný ovládací riadok composeru */}
              <div
                className="hp-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: '12px',
                  borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                  paddingTop: '12px'
                }}
              >
                <div className="hp-left" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {/* Príloha 36x36 */}
                  <button
                    className="icon-btn"
                    id="homeAttach"
                    title="Pridať prílohu"
                    aria-label="Pridať prílohu"
                    disabled
                    style={{
                      width: '36px',
                      height: '36px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 'var(--radius-control, 6px)',
                      background: 'transparent',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      color: 'var(--text-muted, #71717A)',
                      cursor: 'not-allowed'
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.4 11.1-9.2 9.2a5.7 5.7 0 0 1-8-8l9-9a3.8 3.8 0 0 1 5.4 5.4l-9 9a1.9 1.9 0 0 1-2.7-2.7l8.3-8.2" /></svg>
                  </button>

                  {/* Výber modelu */}
                  <button
                    type="button"
                    className="chip hide-xs"
                    id="landingModelChip"
                    onClick={() => {
                      const s = useStore.getState();
                      s.setModelMenuOpen(!s.modelMenuOpen);
                      document.getElementById('modelChip')?.focus();
                    }}
                    title={`Aktuálny model: ${model}`}
                    style={{
                      height: '32px',
                      padding: '0 12px',
                      background: 'var(--surface-control, rgba(255,255,255,0.04))',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '999px',
                      color: 'var(--text-primary, #FAFAFA)',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      cursor: 'pointer'
                    }}
                  >
                    <span style={{ color: 'var(--text-muted, #71717A)' }}>Model:</span>
                    <strong>{model}</strong>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                  </button>

                  {/* Jedna kontrola viditeľnosti */}
                  <button
                    type="button"
                    onClick={togglePublic}
                    aria-pressed={isPublic}
                    style={{
                      height: '32px',
                      padding: '0 12px',
                      background: 'transparent',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '999px',
                      color: isPublic ? 'var(--neon-green, #4ADE80)' : 'var(--text-muted, #71717A)',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      cursor: 'pointer'
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <span>{isPublic ? 'Verejný' : 'Súkromný'}</span>
                  </button>
                  {/* Skrytý checkbox pre backward compatibility E2E testov */}
                  <input type="checkbox" id="publicCheck" checked={isPublic} onChange={togglePublic} style={{ display: 'none' }} />
                </div>

                {/* Primárne CTA — aktívne = neónová zelená s tmavým textom */}
                <button
                  id="homeSend"
                  className={'send-btn' + (sendActive ? ' neon-cta-active' : '')}
                  disabled={busy || !promptDraft.trim()}
                  onClick={submit}
                  style={{
                    height: '36px',
                    padding: '0 18px',
                    borderRadius: '999px',
                    background: sendActive ? undefined : 'var(--surface-control, rgba(255,255,255,0.04))',
                    color: sendActive ? undefined : 'var(--text-disabled, #52525B)',
                    fontWeight: 600,
                    fontSize: '13px',
                    border: sendActive ? 'none' : '1px solid rgba(255, 255, 255, 0.08)',
                    cursor: sendActive ? 'pointer' : 'not-allowed',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}
                >
                  <span>{busy ? 'Vytváram…' : 'Vytvoriť'}</span>
                  {busy ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 1s linear infinite' }}>
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* 4 pilulkové návrhy */}
          <div id="homeChips" style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap', justifyContent: 'center' }}>
            {PILLS.map(pill => (
              <button
                key={pill.kind}
                className="chip-pill lumen-pill"
                data-kind={pill.kind}
                onClick={() => generate(pill.prompt, pill.kind)}
                style={{
                  padding: '0 14px',
                  background: 'var(--surface-control, rgba(255,255,255,0.04))',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-secondary, #A1A1AA)',
                  fontSize: '12px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                {pill.icon}
                {pill.label}
              </button>
            ))}
            <button
              className="home-template-link"
              onClick={() => { useStore.getState().goEditor(); useStore.getState().setEdTab('blueprints'); }}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted, #71717A)', fontSize: '12px', cursor: 'pointer', padding: '0 8px', alignSelf: 'center' }}
            >
              Všetky šablóny →
            </button>
          </div>
        </div>

        {/* 3 dynamické moduly VORKEI Workspace (Projekty, Kredity, Konektory) podľa newUIUX.md */}
        <section className="modules" data-t="modules" aria-label="Prehľad pracoviska">
          {/* Modul 1: Posledné projekty */}
          <section className="panel" aria-labelledby="t-projects">
            <div className="panel-head">
              <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 18V6A1.5 1.5 0 0 1 5 4.5h4.2a1.5 1.5 0 0 1 1.2.6L12 7.5h7A1.5 1.5 0 0 1 20.5 9v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18Z"/></svg>
              <h2 className="panel-title" id="t-projects">Posledné projekty</h2>
              <button
                type="button"
                className="panel-link"
                onClick={() => { useStore.getState().goEditor(); useStore.getState().setEdTab('blueprints'); }}
              >
                Všetky <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
              </button>
            </div>
            {projects.length > 0 ? (
              <div className="projects">
                {projects.slice(0, 3).map((p, idx) => (
                  <button
                    key={p.id}
                    type="button"
                    className="proj"
                    onClick={() => handleOpenProject(p.id)}
                    aria-label={`Otvoriť projekt ${p.title}`}
                  >
                    <div className="thumb" aria-hidden="true">
                      {idx === 0 ? (
                        <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5S9.5 5.8 12 3.5Z"/></svg>
                      ) : idx === 1 ? (
                        <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
                      ) : (
                        <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect width="4.5" height="13" x="4" y="4" rx="1.2"/><rect width="4.5" height="9" x="9.75" y="4" rx="1.2"/><rect width="4.5" height="16" x="15.5" y="4" rx="1.2"/></svg>
                      )}
                    </div>
                    <div className="proj-text">
                      <div className="proj-name">{p.title}</div>
                      <div className="proj-meta">{formatRelativeTime(p.updatedAt || p.createdAt)}</div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="projects-empty">
                <span className="projects-empty-text">Zatiaľ žiadne projekty</span>
                <button
                  type="button"
                  className="panel-link"
                  style={{ color: 'var(--primary)', padding: '4px 8px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-control)' }}
                  onClick={() => { useStore.getState().goEditor(); useStore.getState().setEdTab('blueprints'); }}
                >
                  Preskúmať šablóny →
                </button>
              </div>
            )}
          </section>

          {/* Modul 2: Kredity */}
          <section className="panel" aria-labelledby="t-credits">
            <div className="panel-head">
              <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
              <h2 className="panel-title" id="t-credits">Kredity</h2>
            </div>
            <div className="credits-body">
              <span className="credits-num">{creditsRemaining.toLocaleString('sk-SK')}</span>
              <span className="credits-sub">z {creditsTotal.toLocaleString('sk-SK')} kreditov</span>
            </div>
            <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={creditsTotal} aria-valuenow={creditsRemaining} aria-label="Využité kredity">
              <div className="bar-fill" style={{ width: `${creditsPercent}%` }} />
            </div>
            <p className="credits-note">Obnova: 1. decembra</p>
          </section>

          {/* Modul 3: Konektory */}
          <section className="panel panel-connectors" aria-labelledby="t-connectors">
            <div className="panel-head">
              <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13.5a4 4 0 0 0 6 .4l3-3a4.24 4.24 0 0 0-6-6l-1.7 1.7"/><path d="M14 10.5a4 4 0 0 0-6-.4l-3 3a4.24 4.24 0 0 0 6 6l1.7-1.7"/></svg>
              <h2 className="panel-title" id="t-connectors">Konektory</h2>
              <button
                type="button"
                className="panel-link"
                onClick={() => useStore.getState().toast('Správa konektorov v nastaveniach', 'info')}
              >
                Spravovať
              </button>
            </div>
            <div className="conn-grid">
              {/* GitHub (živé zrkadlenie stavu cez checkGitHubAuth) */}
              <button
                type="button"
                className="conn"
                onClick={handleGitHubClick}
                aria-label={`GitHub — ${githubAuthState.authenticated ? 'Pripojené' : 'Pripojiť'}`}
              >
                <span className="conn-icon" style={{ color: '#EDEDED' }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
                </span>
                <span className="conn-text">
                  <span className="conn-name">GitHub</span><br />
                  <span className={'conn-status' + (githubAuthState.authenticated ? ' connected' : '')}>
                    {githubAuthState.authenticated ? 'Pripojené' : 'Pripojiť'}
                  </span>
                </span>
              </button>

              {/* OpenAI */}
              <button
                type="button"
                className="conn"
                onClick={() => useStore.getState().toast('OpenAI konektor — čoskoro', 'info')}
                aria-label="OpenAI — Pripojiť"
              >
                <span className="conn-icon" style={{ color: '#EDEDED' }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.28 9.82a6 6 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.5-2.9A6.07 6.07 0 0 0 4.98 4.18a6 6 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 6 6 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.2 6 6 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.08z"/></svg>
                </span>
                <span className="conn-text">
                  <span className="conn-name">OpenAI</span><br />
                  <span className="conn-status">Pripojiť</span>
                </span>
              </button>

              {/* Mistral */}
              <button
                type="button"
                className="conn"
                onClick={() => useStore.getState().toast('Mistral konektor — čoskoro', 'info')}
                aria-label="Mistral — Pripojiť"
              >
                <span className="conn-icon" style={{ color: '#FF7000' }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#FF7000" d="M17.14 3.43v3.43h-3.43v3.43h-3.43V6.86H6.86V3.43H3.43v13.71H0v3.43h10.29v-3.43H6.86v-3.43h3.43v3.43h3.43v-3.43h3.43v3.43h-3.43v3.43H24v-3.43h-3.43V3.43z"/></svg>
                </span>
                <span className="conn-text">
                  <span className="conn-name">Mistral</span><br />
                  <span className="conn-status">Pripojiť</span>
                </span>
              </button>

              {/* Stripe */}
              <button
                type="button"
                className="conn"
                onClick={() => useStore.getState().toast('Stripe konektor — čoskoro', 'info')}
                aria-label="Stripe — Pripojiť"
              >
                <span className="conn-icon" style={{ color: '#635BFF' }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#635BFF" d="M13.98 9.15c-2.17-.8-3.36-1.42-3.36-2.4 0-.84.69-1.31 1.9-1.31 2.23 0 4.52.86 6.1 1.63l.88-5.5C18.25.98 15.7 0 12.17 0 9.67 0 7.59.65 6.1 1.87 4.56 3.15 3.76 5 3.76 7.22c0 4.04 2.47 5.76 6.48 7.22 2.58.92 3.44 1.57 3.44 2.58 0 .98-.84 1.55-2.35 1.55-1.88 0-4.97-.92-7-2.11l-.89 5.55C5.18 23 8.39 24 11.72 24c2.64 0 4.84-.62 6.33-1.81 1.66-1.3 2.52-3.24 2.52-5.73 0-4.13-2.52-5.85-6.59-7.31z"/></svg>
                </span>
                <span className="conn-text">
                  <span className="conn-name">Stripe</span><br />
                  <span className="conn-status">Pripojiť</span>
                </span>
              </button>

              {/* Cloudflare */}
              <button
                type="button"
                className="conn"
                onClick={() => useStore.getState().toast('Cloudflare konektor — čoskoro', 'info')}
                aria-label="Cloudflare — Pripojiť"
              >
                <span className="conn-icon" style={{ color: '#F38020' }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#F38020" d="M16.5 16.84c.15-.5.09-.97-.15-1.31-.23-.32-.61-.5-1.07-.52l-8.65-.11c-.05-.08-.03-.16 0-.21l8.74-.12c1.03-.04 2.16-.88 2.55-1.91l.5-1.3c-.56-2.55-2.84-4.45-5.55-4.45-2.5 0-4.63 1.62-5.39 3.86-.49-.36-1.12-.56-1.8-.5-1.2.12-2.16 1.08-2.28 2.29-.03.3-.01.61.06.89C1.57 13.17 0 14.78 0 16.75c0 .18.01.35.04.53h15.98l.12-.43h.36z"/></svg>
                </span>
                <span className="conn-text">
                  <span className="conn-name">Cloudflare</span><br />
                  <span className="conn-status">Pripojiť</span>
                </span>
              </button>

              {/* Google */}
              <button
                type="button"
                className="conn"
                onClick={() => useStore.getState().toast('Google konektor — čoskoro', 'info')}
                aria-label="Google — Pripojiť"
              >
                <span className="conn-icon">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/><path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"/></svg>
                </span>
                <span className="conn-text">
                  <span className="conn-name">Google</span><br />
                  <span className="conn-status">Pripojiť</span>
                </span>
              </button>
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}
