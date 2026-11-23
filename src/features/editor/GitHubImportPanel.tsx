import { useEffect, useState } from 'react';
import { useStore } from '../../stores/useAppStore';
import { listGitHubRepos } from '../../services/githubImport';

export function GitHubImportPanel({ onClose }: { onClose: () => void }) {
  const pull = useStore(s => s.importFromGitHub);
  const connect = useStore(s => s.connectGitHub);
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [repos, setRepos] = useState<{ fullName: string; defaultBranch: string }[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void listGitHubRepos(page, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setRepos(previous => page === 1 ? result.repos : [...previous, ...result.repos]);
      setMore(result.more);
    }).catch(err => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Repozitáre sa nepodarilo načítať.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page]);

  return <form className="oce-form" onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    setError(''); setBusy(true);
    try { await pull(name.trim(), branch.trim() || undefined); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Import sa nepodaril.'); }
    finally { setBusy(false); }
  }}>
    <label className="oce-label">Repozitár
      <input className="oce-input" required list="github-import-repos" placeholder="vlastník/repozitár"
        value={name} onChange={event => setName(event.target.value)} disabled={busy} />
    </label>
    <datalist id="github-import-repos">{repos.map(repo => <option key={repo.fullName} value={repo.fullName} />)}</datalist>
    {loading && <p role="status">Načítavam repozitáre…</p>}
    {more && <button type="button" disabled={loading || busy} onClick={() => setPage(p => p + 1)}>Načítať ďalšie repozitáre</button>}
    <label className="oce-label">Vetva (voliteľná)
      <input className="oce-input" value={branch} onChange={event => setBranch(event.target.value)} disabled={busy}
        placeholder={repos.find(repo => repo.fullName === name)?.defaultBranch ?? 'Predvolená vetva'} />
    </label>
    <p className="oce-sub">Import vytvorí novú verziu projektu. Editor prijíma podporované textové súbory do 200 kB, najviac 40 súborov a 2 MB spolu.</p>
    {error && <p role="alert">{error}</p>}
    {error === 'Najprv pripoj svoj GitHub účet.' && <button type="button" onClick={connect}>Pripojiť GitHub</button>}
    <button className="btn-primary" type="submit" disabled={busy || !name.trim()}>{busy ? 'Importujem…' : 'Importovať do editora'}</button>
  </form>;
}
