import { useRef, useEffect, useState } from 'react';
import { useStore } from '../../stores/useAppStore';
import { filesFor, VfsFile } from '../../lib/vfs/filesFor';
import { hl } from '../../lib/utils';
import { BLUEPRINTS, PROMPT_LIB } from '../../lib/templates/editorData';

/* /editor dashboard — port 1:1 štruktúry; core flow: preview, súbory, história (M1 rozsah);
   blueprints/prompts/backend/team sú v legacy mock panely — pre M1 sú zachované ako
   zreteľne označené demo panely s pôvodným vzhľadom. */

const ED_TABS = [
  { id: 'preview', label: '🎨 Preview' },
  { id: 'files', label: '📁 Súbory' },
  { id: 'history', label: '🕘 History' },
  { id: 'blueprints', label: '🧱 Blueprints' },
  { id: 'prompts', label: '📝 Prompty' },
  { id: 'backend', label: '🗄️ Backend' },
  { id: 'team', label: '👥 Tím' },
  { id: 'gallery', label: '🌐 Galéria' },
] as const;

export const _ED_TAB_IDS = ED_TABS.map(t => t.id);

export function EditorDashboard() {
  const st = useStore();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [search, setSearch] = useState('');
  const [localTab, setLocalTab] = useState<string>('preview');
  const snap = st.edSnap();
  const html = st.currentHtml();

  const files: VfsFile[] = snap ? (st.vfs[snap.id] || filesFor(snap)) : [];

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !html) return;
    const doc = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">' + html + '</body></html>';
    if (frame.getAttribute('srcdoc') !== doc) frame.setAttribute('srcdoc', doc);
  }, [html, localTab]);

  const activeFile = files.find(f => f.name === st.edFile) || files[0];
  const filteredProjects = st.snapshots.filter(s => s.prompt.toLowerCase().includes(search.toLowerCase()));

  const edSave = () => {
    const ta = document.getElementById('edCodeTa') as HTMLTextAreaElement | null;
    if (ta) st.saveEdFile(ta.value);
    else if (activeFile) st.saveEdFile(activeFile.content);
  };

  return (
    <section id="editorView">
      <aside className="ed-side">
        <button className="ed-new" id="edNew" onClick={() => { st.newProject(); st.goHome(); }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
          New
        </button>
        <div className="ed-search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>
          <input id="edSearch" placeholder="Hľadať projekty…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div>
          <div className="ed-nav-title">Projekty</div>
          <div className="ed-projects" id="edProjectList">
            {filteredProjects.length === 0 ? <div className="pane-empty">Žiadne projekty.</div> :
              filteredProjects.map(s => (
                <button key={s.id} className={'ed-proj' + (s.id === st.liveId ? ' active' : '')}
                  onClick={() => st.restoreSnapshot(s.id)}>
                  <b>v{s.v}</b><span>{s.prompt.slice(0, 28)}</span>
                </button>
              ))}
          </div>
        </div>
        <div>
          <div className="ed-nav-title">Connectors</div>
          <div className="ed-conn-list">
            <button className="ed-conn" onClick={() => st.toast('GitHub connector — demo', 'warn')}>🖧 GitHub</button>
            <button className="ed-conn" onClick={() => st.toast('Figma connector — demo', 'warn')}>🎨 Figma</button>
            <button className="ed-conn" onClick={() => st.toast('Notion connector — demo', 'warn')}>📓 Notion</button>
          </div>
        </div>
        <div className="ed-build">
          <b>Forge Pro</b>
          <p>Odomyká private projekty, viac modelov a rýchlejšie buildy.</p>
          <button id="edUpgrade" onClick={() => st.toast('Upgrade — demo (M1)', 'warn')}>Upgrade to Pro</button>
        </div>
      </aside>
      <div className="ed-main">
        <div className="ed-top">
          <div className="ed-crumb">
            <span id="edProjectName">{st.projectTitle}</span>
            <span className="ed-ver" id="edVer">{snap ? 'v' + snap.v : 'v0'}</span>
          </div>
          <div className="ed-actions">
            <button className="ed-act" id="edPreviewBtn" onClick={() => { st.setMode('work'); }}>▶ Preview</button>
            <button className="ed-act" id="edShareBtn"
              onClick={() => { if (!st.publishedUrl){ st.toast('Najprv publikuj projekt', 'warn'); return; } st.toast('Share link skopírovaný', 'ok'); }}>↗ Share</button>
            <button className="ed-act primary" id="edPublishBtn" onClick={st.publish}>Publish</button>
          </div>
        </div>
        <div className="ed-tabs" id="edTabs">
          {ED_TABS.map(t => (
            <button key={t.id} data-edtab={t.id} className={'ed-tab' + (localTab === t.id ? ' active' : '')} onClick={() => { setLocalTab(t.id); st.setEdFile(null); }}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="ed-body">
          <div className={'ed-pane' + (localTab === 'preview' ? ' active' : '')} data-edpane="preview">
            <div className="ed-stage">
              <div className="ed-meta">
                <div className="ed-stat"><span>Súbor</span><b id="edFile">{snap ? 'index.html' : '—'}</b></div>
                <div className="ed-stat"><span>Verzia</span><b id="edVerStat">{snap ? 'v' + snap.v : '—'}</b></div>
                <div className="ed-stat"><span>Veľkosť</span><b id="edSize">{html ? Math.ceil(html.length / 1024) + ' kB' : '—'}</b></div>
                <div className="ed-stat"><span>Model</span><b id="edModel">{st.model}</b></div>
                <div className="ed-stat"><span>Stav</span><b id="edState">{st.viewing ? 'Read-only' : st.publishedUrl ? 'Publikované' : html ? 'Draft' : 'Prázdne'}</b></div>
              </div>
              <div className="ed-frame-wrap">
                {html ? <iframe id="editorFrame" ref={frameRef} sandbox="allow-scripts" title="Editor live preview" /> : (
                  <div className="ed-empty" id="edEmpty">
                    <div className="ed-empty-ic">▦</div>
                    <b>Zatiaľ žiadny projekt</b>
                    <p>Vygeneruj appku v chatovacom režime alebo cez blueprint.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className={'ed-pane' + (localTab === 'files' ? ' active' : '')} data-edpane="files">
            {snap ? (
              <div className="ed-split">
                <div className="ed-files">
                  {files.map(f => (
                    <button key={f.name} className={'ed-fileitem' + (activeFile?.name === f.name ? ' active' : '')}
                      onClick={() => { st.setEdFile(f.name); st.startEdEditing(); }}>
                      <span className="fi-nm">{f.name}</span>{f.modified ? <span className="mod">M</span> : null}
                    </button>
                  ))}
                </div>
                <div className="ed-code">
                  <div className="ed-code-head">
                    <b id="edCodeFile">{activeFile?.name || 'index.html'}</b>
                    <span id="edFileMeta">{activeFile ? activeFile.content.split('\n').length + ' riadkov · ' + (activeFile.content.length / 1024).toFixed(1) + ' kB' : '—'}</span>
                    {st.edEditing ? (
                      <>
                        <button className="ed-code-btn" id="edFileSave" onClick={edSave}>💾 Uložiť (Ctrl+Enter)</button>
                        <button className="ed-code-btn" onClick={() => st.setEdTab(st.edTab)}>Zrušiť</button>
                      </>
                    ) : (
                      <button className="ed-code-btn" id="edFileEdit" onClick={st.startEdEditing}>Upraviť</button>
                    )}
                  </div>
                  {st.edEditing ? (
                    <textarea id="edCodeTa" defaultValue={activeFile?.content || ''}
                      onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); edSave(); } }}
                      style={{ flex: 1, width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: 'none', outline: 'none', padding: '12px', fontFamily: 'var(--mono)', fontSize: '12px', resize: 'none' }} />
                  ) : (
                    <div className="ed-code-view" id="edCodeView" style={{ overflow: 'auto', flex: 1, padding: '10px 0' }}>
                      {(activeFile?.content || '').split('\n').slice(0, 800).map((l, i) => (
                        <div key={i} className="ed-cl">
                          <span className="ed-ln">{i + 1}</span>
                          <span className="ed-lc" dangerouslySetInnerHTML={{ __html: hl(l) || '&nbsp;' }} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : <div className="pane-empty">Žiadny projekt — vygeneruj appku v chatovacom režime alebo cez blueprint.</div>}
          </div>
          <div className={'ed-pane' + (localTab === 'history' ? ' active' : '')} data-edpane="history">
            <div className="ed-commits" id="edCommits">
              {st.snapshots.length === 0 ? <div className="pane-empty">Žiadne commity.</div> :
                [...st.snapshots].reverse().map((s, idx) => (
                  <div key={s.id} className={'ed-commit' + (idx === 0 ? ' head' : '')}>
                    <span className="hash">{s.id.slice(0, 7)}</span>
                    <span className="cmsg">{s.prompt.slice(0, 50)}</span>
                    <span className="cver">v{s.v} · {s.time}</span>
                    {idx === 0 && <span className="head-badge">HEAD</span>}
                    <button className="cact" onClick={() => st.restoreSnapshot(s.id)}>Obnoviť</button>
                    <button className="cact" onClick={() => st.viewSnapshot(s.id)}>Pozrieť</button>
                  </div>
                ))}
            </div>
          </div>
          <div className={'ed-pane' + (localTab === 'blueprints' ? ' active' : '')} data-edpane="blueprints">
            <div className="pane-inner">
              <div className="ed-bp-grid" id="edBpGrid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 12 }}>
                {BLUEPRINTS.map(bp => (
                  <div key={bp.id} className="ed-bp" data-bp={bp.id} role="button" tabIndex={0}
                    onClick={() => { st.generate('Blueprint: ' + bp.name + ' — ' + bp.desc, bp.kind); }}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); st.generate('Blueprint: ' + bp.name + ' — ' + bp.desc, bp.kind); } }}>
                    <div className="ed-bp-thumb" style={{ background: bp.demo }}>{bp.emoji}</div>
                    <b>{bp.emoji} {bp.name}</b>
                    <span className="desc">{bp.desc}</span>
                    <span className="stack">{bp.stack} · {bp.time}</span>
                    <span className="use">Použi blueprint</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className={'ed-pane' + (localTab === 'prompts' ? ' active' : '')} data-edpane="prompts">
            <div className="pane-inner">
              <div className="ed-prompt-grid" id="edPromptGrid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))', gap: 10 }}>
                {PROMPT_LIB.map((p, i) => (
                  <div key={i} className="ed-prompt" role="button" tabIndex={0}
                    onClick={() => { st.goHome(); st.toast('Prompt vložený — doplň [zástupné zátvorky]'); }}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); st.goHome(); st.toast('Prompt vložený — doplň [zástupné zátvorky]'); } }}>
                    <span className="cat">{p.cat}</span>
                    <b>{p.title}</b>
                    <span className="txt" style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>{p.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className={'ed-pane' + (localTab === 'backend' ? ' active' : '')} data-edpane="backend">
            <div className="pane-empty">
              🔒 Backend & data (DB schémy, data browser, auth) — mock panel ako v legacy; reálna implementácia až v M3.
            </div>
          </div>
          <div className={'ed-pane' + (localTab === 'team' ? ' active' : '')} data-edpane="team">
            <div className="pane-empty">
              👥 Tím & kolaborácia (seats, RBAC, komentáre v preview) — mock panel ako v legacy; reálna implementácia až v M4.
            </div>
          </div>
          <div className={'ed-pane' + (localTab === 'gallery' ? ' active' : '')} data-edpane="gallery">
            <div className="pane-empty">
              🌐 Komunitná galéria (publikácia blueprintov, hodnotenie, trending) — mock panel ako v legacy; reálna implementácia až v M6.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
