import { useEffect, useRef } from 'react';
import { useStore } from '../../stores/useAppStore';
import type { AppKind } from '../../lib/templates';
import type { QuotaInfo } from '../../services/auth';
import { Sidebar } from '../../components/Sidebar';

/* LUMEN landing: 100dvh lock, carbon canvas, hero 42px, neon composer, 4 pilulky, 3 carbon karty. */

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

const CARDS = [
  {
    name: 'Studio web', meta: 'Upravené pred 2 h',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.9 5.6 3.9 9S14.5 18.4 12 21c-2.5-2.6-3.9-5.6-3.9-9S9.5 5.6 12 3Z" /></svg>
  },
  {
    name: 'CRM Dashboard', meta: 'Upravené včera',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
  },
  {
    name: 'Kanban', meta: 'Upravené pred 3 dňami',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect width="5" height="14" x="3.5" y="5" rx="1" /><rect width="5" height="9" x="10" y="5" rx="1" /><rect width="5" height="17" x="16.5" y="5" rx="1" /></svg>
  },
];

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

        {/* 3 vizuálne karty projektov (.carbon-card, max-w 960px) */}
        <div
          className="lumen-cards"
          style={{
            width: '100%',
            maxWidth: '960px',
            margin: '0 auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '16px',
            flexShrink: 0,
            paddingBottom: '4px'
          }}
        >
          {CARDS.map(card => (
            <button
              key={card.name}
              type="button"
              className="carbon-card"
              onClick={() => useStore.getState().goEditor()}
              aria-label={`Otvoriť projekt ${card.name}`}
            >
              <div className="carbon-thumb" aria-hidden="true">{card.icon}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', height: '36px' }}>
                <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary, #FAFAFA)' }}>{card.name}</span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted, #71717A)' }}>{card.meta}</span>
              </div>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
