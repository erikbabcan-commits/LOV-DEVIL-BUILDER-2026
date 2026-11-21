import { useEffect, useRef, useState } from 'react';
import { captureGitHubCallback, finishGitHubConnect } from '../services/githubConnect';

/* /github/callback — prijme ?code&state z GitHub OAuth (bridge režim), ihneď vyčistí
   adresu (žiadne code/state v histórii/URL), výmenu spustí používateľ tlačidlom
   a nakoniec presmeruje späť do aplikácie s ?github=connected|error. */

export function GitHubCallbackPage() {
  const captured = useRef<{ state: string; code: string } | null>(null);
  const [payload, setPayload] = useState<{ state: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    captured.current = captureGitHubCallback(window.location.href);
    /* Odstráň code/state z adresy hneď — nech nezostanú v histórii ani logoch. */
    window.history.replaceState(window.history.state, '', window.location.pathname);
    setPayload(captured.current);
  }, []);

  const finish = async () => {
    if (!payload || busy || done) return;
    setBusy(true);
    setError('');
    try {
      await finishGitHubConnect(payload.state, payload.code);
      setDone(true);
      window.setTimeout(() => { window.location.replace('/?github=connected'); }, 700);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Prepojenie zlyhalo.');
      setBusy(false);
    }
  };

  return (
    <main className="auth-gate" aria-label="GitHub callback">
      <div className="auth-card">
        <b className="auth-brand">VORKEI<i>.</i></b>
        <h1>{done ? 'GitHub je pripojený' : 'Dokonči prepojenie GitHub'}</h1>
        {done ? (
          <p role="status">Účet je pripravený na export projektov. Presmerúvam…</p>
        ) : !payload ? (
          <div role="alert">
            <p>Súhlas bol zrušený alebo odkaz nie je platný. Začni nové prepojenie v aplikácii.</p>
            <a href="/">Späť do VORKEI</a>
          </div>
        ) : (
          <>
            <p>Dokonči prepojenie jedným klikom — kód vymení server, nikdy sa nezobrazuje ani neloguje.</p>
            <button type="button" className="btn-primary" id="githubFinishBtn" disabled={busy} onClick={() => { void finish(); }}>
              {busy ? 'Pripájam…' : 'Dokončiť prepojenie'}
            </button>
          </>
        )}
        {error && <p role="alert" className="conn-error">{error}</p>}
        {!done && payload && error && (
          <button type="button" className="btn-ghost" onClick={() => { window.location.replace('/?github=error'); }}>
            Späť do VORKEI
          </button>
        )}
      </div>
    </main>
  );
}
