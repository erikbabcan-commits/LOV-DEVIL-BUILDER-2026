import { useEffect, useRef } from 'react';
import { useStore } from '../../stores/useAppStore';
import type { AppKind } from '../../lib/templates';

/* Port 1:1 z legacy <div class="home"> sekcie — rovnaké triedy/ID, React event handling. */
export function LandingPage() {
  const generate = useStore(s => s.generate);
  const isPublic = useStore(s => s.isPublic);
  const togglePublic = useStore(s => s.togglePublic);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const promptDraft = useStore(state => state.promptDraft);
  const setPromptDraft = useStore(state => state.setPromptDraft);
  const busy = useStore(state => state.generating || state.pendingReview !== null);
  useEffect(() => { if (promptDraft && document.activeElement !== inputRef.current) inputRef.current?.focus(); }, [promptDraft]);

  const submit = () => {
    const v = promptDraft.trim();
    if (!v || busy) return;
    setPromptDraft('');
    /* M2: AI (Mistral) model → reálny engine; inak template mód */
    const st = useStore.getState();
    if (st.model !== 'Instant Draft') {
      void st.generateWithAi(v, 'auto');
    } else {
      generate(v);
    }
  };

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-logo">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="#fff"><path d="M12 21s-7.5-4.7-10-9.3C.4 8.2 2.5 4.5 6.1 4.5c2.2 0 3.9 1.2 4.9 3-1.6-3-1-9 1-9s2.6 6 1 9c1-1.8 2.7-3 4.9-3 3.6 0 5.7 3.7 4.1 7.2C19.5 16.3 12 21 12 21Z"/></svg>
        </div>
        <h1>Čo chceš <em>postaviť</em>?</h1>
        <p className="sub">Od nápadu k prvému návrhu. Popíš, čo potrebuješ, a dolaď výsledok vo svojom tempe.</p>
        <div className="home-prompt">
          <textarea id="homeInput" ref={inputRef} rows={2} aria-label="Tvoj nápad" value={promptDraft} onChange={event => setPromptDraft(event.target.value)} placeholder={'Napríklad: prehľadný web pre moje štúdio s ponukou služieb…'}
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); submit(); } }} />
          <div className="hp-row">
            <div className="hp-left">
              <button className="icon-btn" id="homeAttach" title="Prílohy — pripravujeme" disabled style={{ padding: '0 7px' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.4 11.1-9.2 9.2a5.7 5.7 0 0 1-8-8l9-9a3.8 3.8 0 0 1 5.4 5.4l-9 9a1.9 1.9 0 0 1-2.7-2.7l8.3-8.2"/></svg>
              </button>
              <label className="public-check">
                <input type="checkbox" id="publicCheck" checked={isPublic} onChange={togglePublic} />
                <span>Verejný projekt</span>
              </label>
            </div>
            <button className="send-btn" id="homeSend" title="Vytvoriť návrh (Ctrl+Enter)" disabled={busy || !promptDraft.trim()} onClick={submit}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/></svg>
            </button>
          </div>
        </div>
        <div className="home-chips" id="homeChips">
          <button className="chip-pill" data-kind="saas" onClick={() => generate('Vytvor modernú SaaS landing page s hero sekciou, funkciami a cenami', 'saas' as AppKind)}>🚀 SaaS Landing</button>
          <button className="chip-pill" data-kind="kanban" onClick={() => generate('Vytvor Kanban board s drag & drop, 3 stĺpcami a tagmi', 'kanban' as AppKind)}>🗂️ Kanban Board</button>
          <button className="chip-pill" data-kind="settings" onClick={() => generate('Vytvor Settings dashboard so sidebarom, prepínačmi a profilom', 'settings' as AppKind)}>⚙️ Settings</button>
          <button className="chip-pill" data-kind="dashboard" onClick={() => generate('Vytvor CRM dashboard s metrikami a grafmi', 'dashboard' as AppKind)}>📊 CRM Dashboard</button>
          <button className="chip-pill" data-kind="dashboard" onClick={() => generate('Vytvor jednoduchý blog so zoznamom článkov', 'dashboard' as AppKind)}>📝 Blog</button>
        </div>
        <button className="home-template-link" onClick={() => { useStore.getState().goEditor(); useStore.getState().setEdTab('blueprints'); }}>Alebo začni zo šablóny <span aria-hidden="true">→</span></button>
        <div className="home-shortcuts">
          <span><span className="kbd">Ctrl</span> + <span className="kbd">Enter</span> odoslať</span>
          <span><span className="kbd">Ctrl</span> + <span className="kbd">K</span> zamerať prompt</span>
          <span><span className="kbd">Ctrl</span> + <span className="kbd">S</span> verzia</span>
        </div>
      </div>
    </div>
  );
}
