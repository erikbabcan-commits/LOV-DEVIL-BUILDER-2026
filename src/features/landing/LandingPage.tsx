import { useEffect, useRef } from 'react';
import { useStore } from '../../stores/useAppStore';
import type { AppKind } from '../../lib/templates';
import { Sidebar } from '../../components/Sidebar';
import { initiateGitHubAuth } from '../../services/export/githubExport';

export function LandingPage() {
  const generate = useStore(s => s.generate);
  const isPublic = useStore(s => s.isPublic);
  const togglePublic = useStore(s => s.togglePublic);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const promptDraft = useStore(state => state.promptDraft);
  const setPromptDraft = useStore(state => state.setPromptDraft);
  const busy = useStore(state => state.generating || state.pendingReview !== null);
  const authState = useStore(s => s.githubAuthState);
  const checkGitHubAuth = useStore(s => s.checkGitHubAuth);

  useEffect(() => {
    if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'test') {
      void checkGitHubAuth();
    }
    if (promptDraft && document.activeElement !== inputRef.current) {
      inputRef.current?.focus();
    }
  }, [promptDraft, checkGitHubAuth]);

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

  return (
    <div className="home workspace-layout" style={{ display: 'flex', background: 'var(--background, #171717)', minHeight: 'calc(100vh - 56px)' }}>
      {/* 184 px Kompaktný Sidebar */}
      <Sidebar activeTab="overview" />

      {/* Hlavné pracovisko (vycentrované) */}
      <main className="workspace-main" style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '36px 32px 48px',
        maxWidth: '1040px',
        margin: '0 auto',
        boxSizing: 'border-box'
      }}>
        {/* Hlavný nadpis s presnou hierarchiou */}
        <div style={{ textAlign: 'center', marginBottom: '28px', marginTop: '8px' }}>
          <h1 style={{ fontSize: '32px', lineHeight: '40px', fontWeight: 600, color: 'var(--foreground, #EDEDED)', margin: 0 }}>
            Čo chceš <span style={{ color: 'var(--primary, #4ADE80)' }}>postaviť</span>?
          </h1>
          <p style={{ fontSize: '14px', lineHeight: '20px', color: 'var(--text-secondary, #B5B5B5)', marginTop: '8px', marginBottom: 0 }}>
            Opíš svoj nápad. Vytvoríme prvý návrh.
          </p>
        </div>

        {/* Prompt Composer (760 px, #202020, ohraničenie 8px) */}
        <div className="home-prompt prompt-composer" style={{
          width: '100%',
          maxWidth: '760px',
          background: 'var(--surface, #202020)',
          border: '1px solid var(--border-default, #404040)',
          borderRadius: 'var(--radius-panel, 8px)',
          padding: '16px',
          boxSizing: 'border-box',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)'
        }}>
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
              color: 'var(--foreground, #EDEDED)',
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

          {/* Ovládací riadok composeru */}
          <div className="hp-row" style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: '12px',
            borderTop: '1px solid var(--border-subtle, #2E2E2E)',
            paddingTop: '12px'
          }}>
            <div className="hp-left" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {/* Príloha 36x36 px */}
              <button
                className="icon-btn"
                id="homeAttach"
                title="Pridať prílohu"
                disabled
                style={{
                  width: '36px',
                  height: '36px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 'var(--radius-control, 6px)',
                  background: 'transparent',
                  border: '1px solid var(--border-subtle, #2E2E2E)',
                  color: 'var(--text-muted, #A3A3A3)',
                  cursor: 'not-allowed'
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.4 11.1-9.2 9.2a5.7 5.7 0 0 1-8-8l9-9a3.8 3.8 0 0 1 5.4 5.4l-9 9a1.9 1.9 0 0 1-2.7-2.7l8.3-8.2"/></svg>
              </button>

              {/* Model Chip (Mistral · Codestral) */}
              <button
                type="button"
                className="chip hide-xs"
                id="landingModelChip"
                onClick={() => {
                  const s = useStore.getState();
                  s.setModelMenuOpen(!s.modelMenuOpen);
                  document.getElementById('modelChip')?.focus();
                }}
                title={`Aktuálny model: ${useStore.getState().model}`}
                style={{
                  height: '36px',
                  padding: '0 12px',
                  background: 'var(--surface-hover, #292929)',
                  border: '1px solid var(--border-subtle, #2E2E2E)',
                  borderRadius: 'var(--radius-control, 6px)',
                  color: 'var(--foreground, #EDEDED)',
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  cursor: 'pointer'
                }}
              >
                <span style={{ color: 'var(--text-muted, #A3A3A3)' }}>Model:</span>
                <strong>{useStore(s => s.model)}</strong>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6" /></svg>
              </button>

              {/* Viditeľnosť — zámok Súkromné / Public */}
              <button
                type="button"
                onClick={togglePublic}
                style={{
                  height: '36px',
                  padding: '0 12px',
                  background: 'transparent',
                  border: '1px solid var(--border-subtle, #2E2E2E)',
                  borderRadius: 'var(--radius-control, 6px)',
                  color: isPublic ? 'var(--primary, #4ADE80)' : 'var(--text-muted, #A3A3A3)',
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  cursor: 'pointer'
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>{isPublic ? 'Verejný' : 'Súkromný'}</span>
              </button>
              {/* Skrytý checkbox pre backward compatibility E2E testov */}
              <input type="checkbox" id="publicCheck" checked={isPublic} onChange={togglePublic} style={{ display: 'none' }} />
            </div>

            {/* Primárne CTA "Vytvoriť" s tmavým textom na svetlej zelenej */}
            <button
              id="homeSend"
              className="send-btn"
              disabled={busy || !promptDraft.trim()}
              onClick={submit}
              style={{
                height: '36px',
                padding: '0 18px',
                borderRadius: 'var(--radius-control, 6px)',
                background: promptDraft.trim() && !busy ? 'var(--primary, #4ADE80)' : 'var(--surface-selected, #303030)',
                color: promptDraft.trim() && !busy ? 'var(--primary-foreground, #102116)' : 'var(--text-disabled, #525252)',
                fontWeight: 600,
                fontSize: '13px',
                border: 'none',
                cursor: promptDraft.trim() && !busy ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'background var(--duration-fast, 120ms)'
              }}
            >
              <span>{busy ? 'Vytváram…' : 'Vytvoriť'}</span>
              {busy ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 1s linear infinite' }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              )}
            </button>
          </div>
        </div>

        {/* 4 čisté návrhy s líniovými ikonami (bez emoji) */}
        <div className="home-chips" id="homeChips" style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button className="chip-pill" data-kind="saas" onClick={() => generate('Web pre štúdio s ponukou služieb', 'saas' as AppKind)} style={{ height: '32px', padding: '0 12px', background: 'var(--surface, #202020)', border: '1px solid var(--border-subtle, #2E2E2E)', borderRadius: 'var(--radius-control, 6px)', color: 'var(--text-secondary, #B5B5B5)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m10 15 5-3-5-3v6Z"/></svg>
            Web pre štúdio
          </button>
          <button className="chip-pill" data-kind="kanban" onClick={() => generate('Kanban board s 3 stĺpcami', 'kanban' as AppKind)} style={{ height: '32px', padding: '0 12px', background: 'var(--surface, #202020)', border: '1px solid var(--border-subtle, #2E2E2E)', borderRadius: 'var(--radius-control, 6px)', color: 'var(--text-secondary, #B5B5B5)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="6" height="14" x="4" y="5" rx="1"/><rect width="6" height="10" x="14" y="5" rx="1"/></svg>
            Kanban
          </button>
          <button className="chip-pill" data-kind="dashboard" onClick={() => generate('CRM Dashboard s prehľadom', 'dashboard' as AppKind)} style={{ height: '32px', padding: '0 12px', background: 'var(--surface, #202020)', border: '1px solid var(--border-subtle, #2E2E2E)', borderRadius: 'var(--radius-control, 6px)', color: 'var(--text-secondary, #B5B5B5)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
            CRM
          </button>
          <button className="chip-pill" data-kind="settings" onClick={() => generate('Jednoduchý blog so zoznamom článkov', 'settings' as AppKind)} style={{ height: '32px', padding: '0 12px', background: 'var(--surface, #202020)', border: '1px solid var(--border-subtle, #2E2E2E)', borderRadius: 'var(--radius-control, 6px)', color: 'var(--text-secondary, #B5B5B5)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/></svg>
            Blog
          </button>
          <button className="home-template-link" onClick={() => { useStore.getState().goEditor(); useStore.getState().setEdTab('blueprints'); }} style={{ background: 'none', border: 'none', color: 'var(--primary, #4ADE80)', fontSize: '12px', cursor: 'pointer', padding: '0 8px', fontWeight: 500 }}>
            Všetky šablóny →
          </button>
        </div>

        {/* Tri spodné moduly: Posledné projekty / Kredity / Konektory */}
        <div className="bottom-modules-grid" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '16px',
          width: '100%',
          maxWidth: '1016px',
          marginTop: '44px'
        }}>
          {/* Modul 1: Posledné projekty */}
          <div style={{ background: 'var(--surface, #202020)', border: '1px solid var(--border-default, #404040)', borderRadius: 'var(--radius-panel, 8px)', padding: '16px', height: '184px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--foreground, #EDEDED)' }}>Posledné projekty</span>
              <button onClick={() => useStore.getState().goEditor()} style={{ background: 'none', border: 'none', color: 'var(--primary, #4ADE80)', fontSize: '12px', cursor: 'pointer', padding: 0 }}>Všetky →</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary, #B5B5B5)' }}>
                <span style={{ fontWeight: 500 }}>Studio web</span><span style={{ color: 'var(--text-muted, #A3A3A3)', fontSize: '11px' }}>pred 2 h</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary, #B5B5B5)' }}>
                <span style={{ fontWeight: 500 }}>CRM Dashboard</span><span style={{ color: 'var(--text-muted, #A3A3A3)', fontSize: '11px' }}>včera</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary, #B5B5B5)' }}>
                <span style={{ fontWeight: 500 }}>Kanban</span><span style={{ color: 'var(--text-muted, #A3A3A3)', fontSize: '11px' }}>pred 3 d</span>
              </div>
            </div>
          </div>

          {/* Modul 2: Kredity (62 % bar, tabulárne číslice) */}
          <div style={{ background: 'var(--surface, #202020)', border: '1px solid var(--border-default, #404040)', borderRadius: 'var(--radius-panel, 8px)', padding: '16px', height: '184px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--foreground, #EDEDED)' }}>Kredity</span>
              <div style={{ marginTop: '12px', display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <span style={{ fontSize: '28px', lineHeight: '34px', fontWeight: 600, color: 'var(--foreground, #EDEDED)', fontVariantNumeric: 'tabular-nums' }}>1 240</span>
                <span style={{ fontSize: '12px', color: 'var(--text-muted, #A3A3A3)' }}>z 2 000 kreditov</span>
              </div>
            </div>
            <div>
              <div role="progressbar" aria-valuenow={62} aria-valuemin={0} aria-valuemax={100} style={{ width: '100%', height: '6px', background: '#303030', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ width: '62%', height: '100%', background: 'var(--primary, #4ADE80)', borderRadius: '3px', transition: 'width 0.3s ease' }} />
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted, #A3A3A3)', marginTop: '8px' }}>
                Obnova: 1. decembra
              </div>
            </div>
          </div>

          {/* Modul 3: Konektory (Mriežka 6 autentických služieb) */}
          <div id="connectorsModule" style={{ background: 'var(--surface, #202020)', border: '1px solid var(--border-default, #404040)', borderRadius: 'var(--radius-panel, 8px)', padding: '16px', height: '184px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--foreground, #EDEDED)' }}>Konektory</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted, #A3A3A3)' }}>Spravovať</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginTop: '4px' }}>
              {/* GitHub */}
              <div 
                onClick={() => {
                  if (!authState?.authenticated) {
                    initiateGitHubAuth();
                  }
                }}
                style={{ background: 'var(--surface-navigation, #191919)', padding: '6px', borderRadius: '4px', textAlign: 'center', border: '1px solid var(--border-subtle, #2E2E2E)', cursor: 'pointer' }}
              >
                <div style={{ fontSize: '11px', fontWeight: 600, color: '#EDEDED' }}>GitHub</div>
                <div style={{ fontSize: '9px', fontWeight: 500, color: authState?.authenticated ? 'var(--primary, #4ADE80)' : 'var(--text-muted, #A3A3A3)' }}>
                  {authState?.authenticated ? 'Pripojené' : 'Pripojiť'}
                </div>
              </div>
              {/* OpenAI */}
              <div style={{ background: 'var(--surface-navigation, #191919)', padding: '6px', borderRadius: '4px', textAlign: 'center', border: '1px solid var(--border-subtle, #2E2E2E)' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: '#EDEDED' }}>OpenAI</div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted, #A3A3A3)' }}>Pripojiť</div>
              </div>
              {/* Mistral */}
              <div style={{ background: 'var(--surface-navigation, #191919)', padding: '6px', borderRadius: '4px', textAlign: 'center', border: '1px solid var(--border-subtle, #2E2E2E)' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: '#EDEDED' }}>Mistral</div>
                <div style={{ fontSize: '9px', fontWeight: 500, color: 'var(--primary, #4ADE80)' }}>Aktívny</div>
              </div>
              {/* Stripe */}
              <div style={{ background: 'var(--surface-navigation, #191919)', padding: '6px', borderRadius: '4px', textAlign: 'center', border: '1px solid var(--border-subtle, #2E2E2E)' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: '#EDEDED' }}>Stripe</div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted, #A3A3A3)' }}>Pripojiť</div>
              </div>
              {/* Cloudflare */}
              <div style={{ background: 'var(--surface-navigation, #191919)', padding: '6px', borderRadius: '4px', textAlign: 'center', border: '1px solid var(--border-subtle, #2E2E2E)' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: '#EDEDED' }}>Cloudflare</div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted, #A3A3A3)' }}>Pripojiť</div>
              </div>
              {/* Google */}
              <div style={{ background: 'var(--surface-navigation, #191919)', padding: '6px', borderRadius: '4px', textAlign: 'center', border: '1px solid var(--border-subtle, #2E2E2E)' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: '#EDEDED' }}>Google</div>
                <div style={{ fontSize: '9px', color: 'var(--text-muted, #A3A3A3)' }}>Pripojiť</div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
