import { useEffect } from 'react';
import { useStore } from '../stores/useAppStore';
import { TopBar } from './TopBar';
import { MobileTabs } from './MobileTabs';
import { LandingPage } from '../features/landing/LandingPage';
import { Workspace } from '../features/workspace/Workspace';
import { EditorDashboard } from '../features/editor/EditorDashboard';

/* AppShell — rovnaké body[data-mode]/data-view správanie ako legacy. */
export function AppShell() {
  const mode = useStore(s => s.mode);
  const manualSnapshot = useStore(s => s.manualSnapshot);
  const st = useStore();

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
    const onDoc = () => { st.setModelMenuOpen(false); st.setSettingsOpen(false); };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [st]);

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
