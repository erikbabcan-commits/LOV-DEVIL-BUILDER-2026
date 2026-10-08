import { useRef, useEffect, useState } from 'react';
import { useStore } from '../../stores/useAppStore';
import { esc, hl } from '../../lib/utils';
import { THUMBS } from '../../lib/templates';

/* Workspace: chat panel + canvas panel — port 1:1 legacy štruktúry. */

function ChatMessage({ m }: { m: ReturnType<typeof useStore.getState>['messages'][number] }) {
  const st = useStore();
  const isUser = m.role === 'user';
  return (
    <div className="msg" data-mid={m.id}>
      <div className={'avatar ' + m.role}>{isUser ? 'YH' : 'F'}</div>
      <div className="bubble">
        {m.plan && (
          <div className="plan">
            <div className="plan-title">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 8v4l2.5 2.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>
              Agent Mode{m.planTitle ? ' · ' + m.planTitle : ''}
            </div>
            {m.plan.map((s, i) => (
              <div key={i} className={'plan-step ' + s.state}><span className="pi">{s.state === 'done' ? '✓' : ''}</span>{s.label}</div>
            ))}
          </div>
        )}
        {m.text && <div className="content" dangerouslySetInnerHTML={{ __html: m.text }} />}
        {m.code && m.done && (
          <div className="code-block">
            <div className="code-head"><span>{esc(m.file || 'index.html')}</span></div>
            <pre dangerouslySetInnerHTML={{ __html: hl(m.code) }} />
          </div>
        )}
        {!isUser && m.done && (
          <div className="actions">
            <button className="qact" onClick={() => st.toast('Kód skopírovaný', 'ok')}>⧉ Kopírovať</button>
            <button className="qact" onClick={() => st.toast('Fork — nový projekt z verzie', 'ok')}>⑂ Fork</button>
            <button className="qact" onClick={() => { const last = st.messages.filter(x => x.role === 'user').pop(); if (last) st.generate(last.text); }}>↻ Re-run</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Workspace() {
  const st = useStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const html = st.currentHtml();
  const iter = st.snapshots.length ? 'v' + st.snapshots.length : 'v1';
  const tokens = st.liveHtml ? Math.ceil(st.liveHtml.length / 4) : 0;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !html) return;
    const doc = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">' + html + '</body></html>';
    if (frame.getAttribute('srcdoc') !== doc) frame.setAttribute('srcdoc', doc);
  }, [html]);

  /* applyViewport port: auto-fit scale, rovnaký výpočet ako legacy */
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrap = wrapRef.current, device = document.getElementById('device');
    if (!wrap || !device) return;
    let scale = st.zoomPct / 100;
    const cs = getComputedStyle(wrap);
    const avail = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const intended = device.style.width === '100%' ? avail : parseInt(device.style.width);
    if (st.zoomPct <= 100 && intended * scale > avail) scale = (avail / intended) * scale;
    device.style.transform = `scale(${scale})`;
  }, [st.viewport, st.zoomPct, html]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [st.messages.length]);

  const submit = () => {
    const v = inputRef.current?.value ?? '';
    if (inputRef.current) { inputRef.current.value = ''; inputRef.current.style.height = 'auto'; }
    st.generate(v);
  };

  /* legacy applyViewport parita: desktop = 100% šírky + auto-fit scale; tablet/mobile fixná šírka */
  const deviceW = st.viewport === 'desktop' ? '100%' : st.viewport === 'tablet' ? 768 : 390;

  return (
    <main id="workspaceView">
      <aside className="chat-panel" id="chatPanel">
        <div className="chat-head">
          <div className="iter">Verzia <span className="n" id="iterNum">{iter}</span></div>
          <button className="new-session" id="newSessionBtn" onClick={() => { st.newProject(); st.goHome(); }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
            Nový projekt
          </button>
        </div>
        <div className="chat-scroll" id="chatScroll" ref={scrollRef}>
          {st.messages.length === 0 && (
            <div className="empty-chat">
              <div className="ec-badge">F</div>
              <p>Napíš prompt a Agent Mode ti naplánuje, vygeneruje a nasadí appku.</p>
            </div>
          )}
          {st.messages.map(m => <ChatMessage key={m.id} m={m} />)}
        </div>
        <div className="composer">
          <div className="comp-box">
            <textarea id="promptInput" ref={inputRef} rows={1} placeholder="Popíš zmenu… (Ctrl+Enter)"
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); submit(); } }} />
            <div className="comp-actions">
              <div className="comp-left">
                <button className="icon-btn" id="attachBtn" title="Prílohy" style={{ padding: '0 7px' }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.4 11.1-9.2 9.2a5.7 5.7 0 0 1-8-8l9-9a3.8 3.8 0 0 1 5.4 5.4l-9 9a1.9 1.9 0 0 1-2.7-2.7l8.3-8.2"/></svg>
                </button>
                <span className="token-count" id="tokenCount">≈ {tokens} tok · 200k ctx</span>
              </div>
              <div className="comp-right">
                <button className="send-btn" id="sendBtn" title="Odoslať (Ctrl+Enter)" disabled={st.generating} onClick={submit}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>
      <div className={'resizer' + (dragging ? ' dragging' : '')} id="resizer" title="Potiahni · dvojklik = reset"
        role="separator" aria-orientation="vertical" aria-label="Zmeniť šírku chat panelu"
        tabIndex={0}
        onPointerDown={e => { setDragging(true); (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
        onPointerMove={e => {
          if (!dragging) return;
          document.documentElement.style.setProperty('--chat-w', Math.min(560, Math.max(340, e.clientX)) + 'px');
        }}
        onPointerUp={() => setDragging(false)}
        onDoubleClick={() => document.documentElement.style.setProperty('--chat-w', '420px')}
        onKeyDown={e => {
          const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-w')) || 420;
          if (e.key === 'ArrowLeft'){ e.preventDefault(); document.documentElement.style.setProperty('--chat-w', Math.max(340, cur - 20) + 'px'); }
          if (e.key === 'ArrowRight'){ e.preventDefault(); document.documentElement.style.setProperty('--chat-w', Math.min(560, cur + 20) + 'px'); }
        }} />
      <section className="canvas-panel">
        <div className="canvas-tabs">
          <div className="ct-tabs" id="ctTabs">
            {(['preview', 'raw', 'console', 'diff'] as const).map(tab => (
              <button key={tab} className={'ct-tab' + (st.tab === (tab === 'raw' ? 'code' : tab === 'preview' ? 'preview' : tab) ? ' active' : '')}
                data-tab={tab === 'raw' ? 'raw' : tab}
                onClick={() => st.setTab(tab === 'raw' ? 'code' : tab)}>
                {tab === 'preview' ? ' Preview' : tab === 'raw' ? ' Code' : tab === 'console' ? ' Console' : ' Diff'}
              </button>
            ))}
          </div>
          <div className="ct-actions">
            <button className={'edit-chip' + (st.editMode ? ' active' : '')} id="editToggle" title="Visual Edit mode — klikaj na elementy v preview" onClick={st.toggleEditMode}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
              Edit
            </button>
            <div className="seg" id="viewportSeg">
              {(['desktop', 'tablet', 'mobile'] as const).map(vp => (
                <button key={vp} data-vp={vp} className={st.viewport === vp ? 'active' : ''} title={vp === 'desktop' ? 'Desktop — 100%' : vp === 'tablet' ? 'Tablet — 768px' : 'Mobile — 390px'} onClick={() => st.setViewport(vp)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {vp === 'desktop' ? <><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></> :
                     vp === 'tablet' ? <><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 18h.01"/></> :
                     <><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 18h.01"/></>}
                  </svg>
                </button>
              ))}
            </div>
            <div className="zoom-ctl">
              <button id="zoomOut" title="Zmenšiť" onClick={() => st.setZoom(st.zoomPct - 10)}>−</button>
              <span id="zoomVal">{st.zoomPct}%</span>
              <button id="zoomIn" title="Zväčšiť" onClick={() => st.setZoom(st.zoomPct + 10)}>+</button>
            </div>
            <button className="icon-btn" id="refreshBtn" title="Obnoviť preview" style={{ padding: '0 7px' }}
              onClick={() => { if (!html){ st.toast('Zatiaľ žiadne HTML na obnovenie', 'warn'); return; } const f = frameRef.current; if (f) f.setAttribute('srcdoc', ''); setTimeout(() => st.toast('Preview obnovený', 'ok'), 50); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/></svg>
            </button>
            <button className="icon-btn hide-m" id="openTabBtn" title="Otvoriť v novom tabe" style={{ padding: '0 7px' }}
              onClick={() => st.toast('Sandbox upozornenie: otváram v novom tabe (demo)', 'warn')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/></svg>
            </button>
            <button className="icon-btn" id="snapBtn" title="Uložiť verziu (Ctrl+S)" style={{ padding: '0 7px' }} onClick={st.manualSnapshot}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"/><circle cx="12" cy="13" r="4"/></svg>
            </button>
          </div>
        </div>
        <div className="canvas-body">
          <div className={'pane' + (st.tab === 'preview' ? ' active' : '')} data-pane="preview">
            <div className="viewport-wrap" id="viewportWrap" ref={wrapRef}>
              {st.viewing && (
                <div className="hist-banner show" id="histBanner">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
                  <span id="histBannerText">Prezeráš historickú verziu v{st.viewing.v}</span>
                  <button className="back" id="backToLive" onClick={st.backToLive}>Späť na live verziu</button>
                </div>
              )}
              {html ? (
                <div className="device" id="device" style={{ width: deviceW, height: 'calc(100% - 8px)' }}>
                  <iframe id="previewFrame" ref={frameRef} sandbox="allow-scripts" title="Live preview" />
                  {st.generating && (
                    <div className="skeleton show" id="skeleton">
                      <div className="sk-gen"><span className="spinner"></span><span id="skModel">Agent · {st.model}</span></div>
                      <div className="sk-bar" style={{ height: '36px', width: '55%' }}></div>
                      <div className="sk-bar" style={{ height: '12px', width: '82%' }}></div>
                      <div className="sk-bar" style={{ height: '12px', width: '64%' }}></div>
                      <div style={{ display: 'flex', gap: '12px' }}>
                        <div className="sk-bar" style={{ height: '66px', flex: 1 }}></div>
                        <div className="sk-bar" style={{ height: '66px', flex: 1 }}></div>
                        <div className="sk-bar" style={{ height: '66px', flex: 1 }}></div>
                      </div>
                      <div className="sk-bar" style={{ height: '100px', flex: 1 }}></div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="pane-empty">Vygeneruj appku — tu sa zobrazí live preview.</div>
              )}
              {st.editMode && (
                <div className="edit-tip" id="editTip">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                  Edit mode — prejdi kurzorom po preview a vyber element na úpravu
                </div>
              )}
            </div>
          </div>
          <div className={'pane' + (st.tab === 'code' ? ' active' : '')} data-pane="raw">
            <div className="pane-inner">
              {html ? <pre className="raw-pre" id="rawPre" dangerouslySetInnerHTML={{ __html: hl(html) }} /> : <div className="pane-empty">Žiadny kód — vygeneruj appku.</div>}
            </div>
          </div>
          <div className={'pane' + (st.tab === 'console' ? ' active' : '')} data-pane="console">
            <div className="pane-inner" id="consoleInner">
              {st.console.length === 0 ? <div className="pane-empty">Konzola je prázdna.</div> :
                st.console.map((c, i) => (
                  <div key={i} className={'con-line ' + c.cls}><span className="con-t">{c.t}</span>{c.txt}</div>
                ))}
            </div>
          </div>
          <div className={'pane' + (st.tab === 'diff' ? ' active' : '')} data-pane="diff">
            <div className="pane-inner" id="diffInner">
              {st.snapshots.length < 2 ? <div className="pane-empty">Diff potrebuje aspoň 2 verzie — vygeneruj alebo ulož ďalšiu.</div> : (
                <div className="diff-content">
                  <div className="diff-head">v{st.snapshots[st.snapshots.length - 2].v} → v{st.snapshots[st.snapshots.length - 1].v}</div>
                  {(() => {
                    const a = (st.snapshots[st.snapshots.length - 2].html || '').split('\n');
                    const b = (st.snapshots[st.snapshots.length - 1].html || '').split('\n');
                    const setA = new Map<string, number>();
                    a.forEach(l => setA.set(l, (setA.get(l) || 0) + 1));
                    const added: string[] = [];
                    b.forEach(l => {
                      const n = setA.get(l) || 0;
                      if (n > 0) setA.set(l, n - 1); else added.push(l);
                    });
                    return (
                      <>
                        {added.map((l, i) => <div key={'a' + i} className="diff-line add">+ {l || ' '}</div>)}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className={'history' + (st.historyExpanded ? ' expanded' : '')} id="historyBar">
          <div className="hist-head">
            <div className="hist-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v5h5M3.05 13A9 9 0 1 0 6 5.3L3 8M12 7v5l3 3"/></svg>
              História verzií <span className="count" id="snapCount">{st.snapshots.length}</span>
            </div>
            <button className="icon-btn" id="histToggle" onClick={st.toggleHistoryExpanded}>
              <span id="histToggleTxt">{st.historyExpanded ? 'Zbaliť' : 'Expandovať'}</span>
              <svg id="histChevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6"/></svg>
            </button>
          </div>
          <div className="hist-list" id="histList">
            {st.snapshots.length === 0 ? <div className="pane-empty">Žiadne verzie — vygeneruj appku (Ctrl+Enter) alebo ulož checkpoint (Ctrl+S).</div> :
              [...st.snapshots].reverse().map(s => (
                <div key={s.id} role="button" tabIndex={0}
                  className={'snap' + (s.pinned ? ' pinned' : '') + (!st.viewing && s.id === st.liveId ? ' current' : '')} data-snap={s.id}
                  onClick={() => st.viewSnapshot(s.id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); st.viewSnapshot(s.id); } }}>
                  <div className="snap-thumb" style={{ background: (THUMBS as Record<string, string>)[s.kind] || THUMBS.dashboard }}>v{s.v}</div>
                  <div className="snap-row"><span className="snap-ver">v{s.v}</span><span className="snap-time">{s.time}</span></div>
                  <div className="snap-prompt">{s.prompt}</div>
                  <div className="snap-btns">
                    <button className="snap-btn" onClick={() => st.restoreSnapshot(s.id)}>↺ Restore</button>
                    <button className={'snap-btn pin-btn' + (s.pinned ? ' active' : '')} onClick={() => st.pinSnapshot(s.id)}>★ Pin</button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </section>
    </main>
  );
}
