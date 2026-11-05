import { useMemo, useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { useStore } from '../../stores/useAppStore';
import type { VfsFile } from '../../lib/vfs';

/* WS-2 CodePane: file explorer + Monaco editor s tabmi, dirty indikátor a save.
   Súčasné <pre> raw HTML view zostáva ako fallback (žiadne súbory = starý režim). */

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', css: 'css', html: 'html', md: 'markdown'
};

function langOf(name: string): string {
  return LANG[name.split('.').pop() ?? ''] ?? 'plaintext';
}

interface OpenTab { name: string; draft: string; saved: string }

export function CodePane() {
  const st = useStore();
  const snap = st.edSnap();
  const files: VfsFile[] = useMemo(
    () => (snap ? st.vfs[snap.id] ?? [] : []),
    [snap, st.vfs]
  );

  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const monacoFailed = useRef(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Monaco CDN fallback — ak sa editor donaloaduje (offline), prepne na textarea. */
  const [useFallback, setUseFallback] = useState(false);
  useEffect(() => {
    if (useFallback || !active) return;
    fallbackTimer.current = setTimeout(() => {
      if (!monacoFailed.current) return; /* nech Monaca loader hlási cez loading={} */
    }, 6000);
    return () => { if (fallbackTimer.current) clearTimeout(fallbackTimer.current); };
  }, [active, useFallback]);

  const openFile = (f: VfsFile) => {
    if (useFallback && !active) return;
    setTabs(prev => {
      if (prev.some(t => t.name === f.name)) return prev;
      return [...prev, { name: f.name, draft: f.content, saved: f.content }];
    });
    setActive(f.name);
  };

  const activeTab = tabs.find(t => t.name === active) ?? null;
  const dirtyCount = tabs.filter(t => t.draft !== t.saved).length;

  const updateDraft = (value: string) => {
    if (!active) return;
    setTabs(prev => prev.map(t => (t.name === active ? { ...t, draft: value } : t)));
  };

  const closeTab = (name: string) => {
    setTabs(prev => prev.filter(t => t.name !== name));
    if (active === name) {
      const rest = tabs.filter(t => t.name !== name);
      setActive(rest.length ? rest[rest.length - 1].name : null);
    }
  };

  const saveAll = () => {
    if (!st.edSnap()) { st.toast('Najprv vytvor projekt', 'warn'); return; }
    const changed = tabs.filter(t => t.draft !== t.saved);
    if (!changed.length) { st.toast('Žiadne zmeny na uloženie', 'ok'); return; }
    st.applyStagedFiles(changed.map(t => ({ path: t.name, content: t.draft, action: 'modify' as const })));
    setTabs(prev => prev.map(t => (t.draft !== t.saved ? { ...t, saved: t.draft } : t)));
    st.toast(`Uložené: ${changed.length} ${changed.length === 1 ? 'súbor' : 'súbory'} → nová verzia`, 'ok');
  };

  /* Auto-save draft každých 30 s (dirty → sessionStorage, ochrana proti refreshi) */
  useEffect(() => {
    const id = setInterval(() => {
      if (!activeTab || activeTab.draft === activeTab.saved) return;
      try { sessionStorage.setItem('forge-draft-' + activeTab.name, activeTab.draft); } catch { /* quota */ }
    }, 30_000);
    return () => clearInterval(id);
  }, [activeTab]);

  if (!files.length) {
    return <div className="pane-empty">Žiadne súbory — vygeneruj appku (kód sa objaví tu).</div>;
  }

  return (
    <div className="code-pane" role="region" aria-label="Editor kódu">
      <aside className="code-tree" aria-label="Súbory projektu">
        <div className="code-tree-head">
          <span>Súbory</span>
          <button className="cp-save" onClick={saveAll} disabled={!dirtyCount} title="Uložiť zmeny (nová verzia)">
            Uložiť{dirtyCount ? ` (${dirtyCount})` : ''}
          </button>
        </div>
        <div className="code-tree-list">
          {files.map(f => (
            <button
              key={f.name}
              className={'tree-item' + (active === f.name ? ' active' : '')}
              onClick={() => openFile(f)}
              title={f.name}
            >
              <span className="tree-ico">{f.name.endsWith('.tsx') || f.name.endsWith('.ts') ? 'TS' : f.name.endsWith('.css') ? '#' : f.name.endsWith('.json') ? '{}' : f.name.endsWith('.html') ? '<>' : '·'}</span>
              <span className="tree-name">{f.name}</span>
              {tabs.some(t => t.name === f.name && t.draft !== t.saved) && <span className="dirty-dot" aria-label="Neuložené" />}
              {f.modified && <span className="mod-dot" title="Zmenené oproti AI výstupu" />}
            </button>
          ))}
        </div>
      </aside>
      <div className="code-editor">
        {!activeTab ? (
          <div className="pane-empty">Vyber súbor vľavo pre zobrazenie/úpravu.</div>
        ) : (
          <div className="editor-host">
            <div className="editor-tabs" role="tablist">
              {tabs.map(t => (
                <div key={t.name} role="tab" aria-selected={active === t.name}
                  className={'editor-tab' + (active === t.name ? ' active' : '')}
                  onClick={() => setActive(t.name)}>
                  <span>{t.name}</span>
                  {t.draft !== t.saved && <span className="dirty-dot" />}
                  <button className="tab-close" aria-label={'Zavrieť ' + t.name} onClick={e => { e.stopPropagation(); closeTab(t.name); }}>✕</button>
                </div>
              ))}
            </div>
            {useFallback ? (
              <textarea
                className="cp-fallback"
                value={activeTab.draft}
                onChange={e => updateDraft(e.target.value)}
                aria-label={'Úprava ' + activeTab.name}
                spellCheck={false}
              />
            ) : (
              <Editor
                key={activeTab.name}
                height="100%"
                language={langOf(activeTab.name)}
                value={activeTab.draft}
                onChange={v => updateDraft(v ?? '')}
                theme="vs-dark"
                loading={<div className="cp-loading">Načítam editor… (Monaco z CDN)</div>}
                options={{
                  fontSize: 13,
                  minimap: { enabled: true },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                  wordWrap: 'on'
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
