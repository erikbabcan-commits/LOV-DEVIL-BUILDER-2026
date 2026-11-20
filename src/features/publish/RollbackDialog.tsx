import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { apiHeaders } from '../../lib/csrf';
import { apiUrl } from '../../lib/api';

const Version = z
  .object({
    requestId: z.string().uuid(),
    revision: z.number().int().positive(),
    snapshotId: z.string().min(1),
    createdAt: z.string(),
    artifactBytes: z.number().nullable(),
    isLive: z.boolean(),
  })
  .strict();

type Version = z.infer<typeof Version>;

async function loadVersions(projectId: string, signal: AbortSignal): Promise<Version[]> {
  const response = await fetch(apiUrl('/api/publish/project/' + encodeURIComponent(projectId) + '/versions'), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'publish_unavailable');
  return z.array(Version).parse(data);
}

async function rollback(
  projectId: string,
  requestId: string,
  expectedVersion: string | null,
  signal: AbortSignal,
) {
  const response = await fetch(
    apiUrl('/api/publish/project/' + encodeURIComponent(projectId) + '/rollback'),
    {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      signal,
      headers: apiHeaders(),
      body: JSON.stringify({ requestId, expectedVersion, confirmed: true }),
    },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'publish_unavailable');
  return data;
}

/** Choose an older published version and switch the live address to it. */
export function RollbackDialog({
  projectId,
  liveVersion,
  onClose,
  onRolledBack,
}: {
  projectId: string;
  liveVersion: string | null;
  onClose: () => void;
  onRolledBack?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    if (node) {
      if (node.showModal) node.showModal();
      else node.setAttribute('open', '');
    }
    const pending = new AbortController();
    void loadVersions(projectId, pending.signal)
      .then((rows) => {
        if (pending.signal.aborted) return;
        setVersions(rows);
        const fallback = rows.find((row) => !row.isLive) ?? rows[0];
        if (fallback) setSelected(fallback.requestId);
      })
      .catch((reason) => {
        if (!pending.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Načítanie verzií zlyhalo.');
      });
    return () => {
      pending.abort();
      node?.close?.();
      previous?.focus();
    };
  }, [projectId]);

  async function submit() {
    if (!selected || busy || !confirming) return;
    setBusy(true);
    setError('');
    const pending = new AbortController();
    try {
      await rollback(projectId, selected, liveVersion, pending.signal);
      onRolledBack?.();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Rollback zlyhal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="project-library"
      aria-labelledby={listId + '-title'}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="project-library-head">
        <h2 id={listId + '-title'}>Obnoviť predchádzajúcu verziu</h2>
        <button type="button" onClick={onClose} aria-label="Zavrieť rollback">
          ×
        </button>
      </div>
      <p>Archív publikácií sa nemení. Prepne sa len živá adresa na zvolenú verziu.</p>
      {!versions && !error ? <p role="status">Načítavam verzie…</p> : null}
      {versions && versions.length === 0 ? (
        <p role="status">Zatiaľ nie je žiadna publikovaná verzia na obnovenie.</p>
      ) : null}
      {versions && versions.length > 0 ? (
        <fieldset>
          <legend id={listId}>Publikované verzie</legend>
          <ul aria-labelledby={listId} style={{ listStyle: 'none', padding: 0 }}>
            {versions.map((row) => (
              <li key={row.requestId}>
                <label>
                  <input
                    type="radio"
                    name="publish-rollback-version"
                    value={row.requestId}
                    checked={selected === row.requestId}
                    disabled={busy || row.isLive}
                    onChange={() => {
                      setSelected(row.requestId);
                      setConfirming(false);
                    }}
                  />{' '}
                  Revízia {row.revision}
                  {row.isLive ? ' (aktuálne živá)' : ''} · {new Date(row.createdAt).toLocaleString()}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      <label>
        <input
          type="checkbox"
          checked={confirming}
          disabled={busy || !selected}
          onChange={(event) => setConfirming(event.target.checked)}
        />{' '}
        Potvrdzujem prepnutie živej adresy na zvolenú verziu.
      </label>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <button type="button" onClick={onClose} disabled={busy}>
          Zrušiť
        </button>
        <button
          type="button"
          disabled={busy || !confirming || !selected}
          onClick={() => void submit()}
        >
          {busy ? 'Prepínam…' : 'Obnoviť zvolenú verziu'}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </dialog>
  );
}
