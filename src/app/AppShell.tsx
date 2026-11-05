import { useEffect, useState } from 'react';
import { useStore } from '../stores/useAppStore';
import { LoginScreen } from '../components/LoginScreen';
import { fetchAuthStatus, type AuthStatus } from '../services/auth';

/* E2E test hook */
(window as unknown as { __forgeStore: typeof useStore }).__forgeStore = useStore;
import { TopBar } from './TopBar';
import { MobileTabs } from './MobileTabs';
import { LandingPage } from '../features/landing/LandingPage';
import { Workspace } from '../features/workspace/Workspace';
import { EditorDashboard } from '../features/editor/EditorDashboard';

/* AppShell — rovnaké body[data-mode]/data-view správanie ako legacy. */
export function AppShell() {
  const mode = useStore(s => s.mode);
  const manualSnapshot = useStore(s => s.manualSnapshot);
  const restoreFromDb = useStore(s => s.restoreFromDb);
  const st = useStore();

  /* WS-1: auth gate — ak server vyžaduje login a užívateľ je anonymný, zobraz LoginScreen */
  const [authState, setAuthState] = useState<AuthStatus>({ state: 'disabled' });
  const checkAuth = () => { void fetchAuthStatus().then(setAuthState); };
  useEffect(() => { checkAuth(); }, []);

  /* M2: obnova projektu po refreshi (IndexedDB) */
  useEffect(() => { void restoreFromDb(); }, [restoreFromDb]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's'){ e.preventDefault(); if (mode === 'work') manualSnapshot(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k'){ e.preventDefault(); (document.getElementById('promptInput') || document.getElementById('homeInput'))?.focus(); }
      if (e.key === 'Escape'){ st.setPublishModalOpen(false); st.setModelMenuOpen(false); st.setSettingsOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, manualSnapshot, st]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      /* ignoruj kliky vnútri pop-wrap (model menu / settings) — inak by sa zatvoril hneď pri otvorení */
      if ((e.target as HTMLElement)?.closest?.('.pop-wrap')) return;
      st.setModelMenuOpen(false);
      st.setSettingsOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [st]);

  if (authState.state === 'anonymous') {
    return <LoginScreen onAuthenticated={checkAuth} />;
  }

  return (
    <>
      <TopBar />
      <MobileTabs />
      {mode === 'home' && <LandingPage />}
      {mode === 'work' && <Workspace />}
      {mode === 'editor' && <EditorDashboard />}
      <div className="toasts" id="toasts">
        {st.toasts.map(t => (
          <div key={t.id} className={'toast ' + t.kind}><span className="dot"></span>{t.msg}</div>
        ))}
      </div>
    </>
  );
}
