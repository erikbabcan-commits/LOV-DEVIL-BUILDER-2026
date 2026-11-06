import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/useAppStore';
import { LoginScreen } from '../components/LoginScreen';
import { AI_QUOTA_CHANGED } from '../services/ai/usage';
import { fetchAuthStatus, type AuthStatus } from '../services/auth';
import { selectPersistenceScope } from '../services/persistence/projectStore';
const PublishDialog=lazy(()=>import('../features/publish/PublishDialog').then(module=>({default:module.PublishDialog})));
const ProjectLibrary=lazy(()=>import('../features/projects/ProjectLibrary').then(module=>({default:module.ProjectLibrary})));

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
  const [libraryOpen,setLibraryOpen]=useState(false);

  /* WS-1: auth gate — ak server vyžaduje login a užívateľ je anonymný, zobraz LoginScreen */
  const [authState, setAuthState] = useState<AuthStatus>({ state: 'checking' });
  const authRequest = useRef({ sequence: 0 });
  const checkAuth = useCallback((hideEditor = true) => {
    const request = ++authRequest.current.sequence;
    if (hideEditor) setAuthState({ state: 'checking' });
    void fetchAuthStatus().then(status => { if (request === authRequest.current.sequence) setAuthState(status); });
  }, []);
  useEffect(() => {
    const requests = authRequest.current;
    checkAuth();
    const onFocus = () => checkAuth(false);
    const onVisibility = () => { if (document.visibilityState === 'visible') checkAuth(false); };
    window.addEventListener('focus', onFocus);
    window.addEventListener(AI_QUOTA_CHANGED, onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { requests.sequence++; window.removeEventListener('focus', onFocus); window.removeEventListener(AI_QUOTA_CHANGED, onFocus); document.removeEventListener('visibilitychange', onVisibility); };
  }, [checkAuth]);

  /* M2: obnova projektu po refreshi (IndexedDB) */
  const mayOpenEditor = authState.state === 'disabled' || authState.state === 'authenticated';
  const accountKey = authState.state === 'checking' ? null : authState.state === 'authenticated' ? 'account:' + authState.user.id : authState.state === 'disabled' ? 'pilot' : 'locked';
  const [readyAccount, setReadyAccount] = useState<string | null>(null);
  useEffect(() => {
    if (accountKey === null) return;
    const changed = selectPersistenceScope(accountKey === 'pilot' ? { kind: 'pilot' } : accountKey === 'locked' ? { kind: 'locked' } : { kind: 'account', userId: accountKey.slice(8) });
    if (changed) {
      setLibraryOpen(false);
      useStore.getState().newProject();
      useStore.getState().setMode('home');
      useStore.getState().setMview('chat');
      useStore.setState({ console: [], toasts: [], githubAuthState: { authenticated: false }, githubExportInProgress: false, model:'Instant Draft', aiModelId:undefined, aiFallbackIds:[], modelMenuOpen: false, settingsOpen: false, publishModalOpen: false, isPublic: false, editMode: false, historyExpanded: false, tab: 'preview', edTab: 'preview' });
    }
    setReadyAccount(null);
    if (!mayOpenEditor) return;
    let cancelled = false;
    void restoreFromDb().then(() => { if (!cancelled) setReadyAccount(accountKey); });
    return () => { cancelled = true; };
  }, [accountKey, mayOpenEditor, restoreFromDb]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 's'){ e.preventDefault(); if (mode === 'work'&&!libraryOpen) { if (st.tab === 'code') document.getElementById('codeSaveAll')?.click(); else manualSnapshot(); } }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k'){ e.preventDefault(); (document.getElementById('promptInput') || document.getElementById('homeInput'))?.focus(); }
      if (e.key === 'Escape'){ st.setPublishModalOpen(false); st.setModelMenuOpen(false); st.setSettingsOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, manualSnapshot, st,libraryOpen]);

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

  if (authState.state === 'checking' || authState.state === 'unavailable' || (mayOpenEditor && readyAccount !== accountKey)) {
    return <main className="auth-gate" aria-label="Overenie prístupu"><div className="auth-card">
      <b className="auth-brand">Forge<i>.</i></b>
      {authState.state !== 'unavailable' ? <div role="status"><h1>Overujem prístup…</h1><p>Pripájam sa k serveru.</p></div> : <>
        <div role="alert"><h1>Server teraz neodpovedá.</h1><p>Prístup sa nepodarilo overiť. Skontroluj pripojenie a skús to znova.</p></div>
        <button type="button" onClick={() => checkAuth()}>Skúsiť znova</button>
      </>}
    </div></main>;
  }
  if (authState.state === 'anonymous') {
    return <LoginScreen onAuthenticated={() => checkAuth()} />;
  }

  return (
    <>
      <TopBar onOpenProjects={()=>setLibraryOpen(true)} quota={authState.state==='authenticated'?authState.quota:undefined} />
      {libraryOpen&&<Suspense fallback={<p role="status">Načítavam projekty…</p>}><ProjectLibrary key={accountKey} enabled={authState.state==='authenticated'} userId={authState.state==='authenticated'?authState.user.id:undefined} quota={authState.state==='authenticated'?authState.quota:undefined} onRefreshQuota={()=>checkAuth(false)} onClose={()=>setLibraryOpen(false)}/></Suspense>}
      {st.publishModalOpen&&<Suspense fallback={<p role="status">Načítavam publikovanie…</p>}><PublishDialog key={accountKey+':'+st.projectId} userId={authState.state==='authenticated'?authState.user.id:undefined} onClose={()=>st.setPublishModalOpen(false)}/></Suspense>}
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
