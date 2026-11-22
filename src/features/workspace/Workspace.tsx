import { useRef, useEffect, useState, useMemo } from 'react';
import { useStore } from '../../stores/useAppStore';
import { esc, hl } from '../../lib/utils';
import { THUMBS } from '../../lib/templates';
import { withoutExternalScripts } from '../../lib/vfs';
import { CodePane } from './CodePane';
import { ReviewPanel } from './ReviewPanel';
import { JobTransportStatus } from './JobTransportStatus';
import { ProjectDiff } from './ProjectDiff';
import { BuildRepairAction } from './BuildRepairAction';
import { ConnectionPanel } from '../../components/ConnectionPanel';
import { LiveGenerationInspector } from './LiveGenerationInspector';
import {
  injectInspectorBridge,
  INSPECTOR_MESSAGE_TYPE,
  INSPECTOR_SET_MODE_TYPE,
  INSPECTOR_CLEAR_TYPE,
  type InspectedElement
} from './inspectorBridge';
import {
  injectRuntimeBoundary,
  RUNTIME_CRASH_MESSAGE_TYPE,
  RUNTIME_ERROR_DETECTED_TYPE,
  type RuntimeCrashPayload
} from './runtimeBoundary';

/* Workspace: chat panel + canvas panel — port 1:1 legacy štruktúry. */

function ChatMessage({ m }: { m: ReturnType<typeof useStore.getState>['messages'][number] }) {
  const st = useStore();
  const isUser = m.role === 'user';
  return (
    <div className="msg" data-mid={m.id}>
      <div className={'avatar ' + m.role}>{isUser ? 'YH' : 'V'}</div>
      <div className="bubble">
        {m.plan && (
          <div className="plan">
            <div className="plan-title">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 8v4l2.5 2.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
              Agent Mode{m.planTitle ? ' · ' + m.planTitle : ''}
            </div>
            {m.plan.map((s, i) => (
              <div key={i} className={'plan-step ' + s.state}>
                <span className="pi">{s.state === 'done' ? '✓' : s.state === 'running' ? '⚡' : '○'}</span>
                <span className="plan-step-label">{s.label}</span>
              </div>
            ))}
          </div>
        )}
        {m.text && <div className="content" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>}
        {m.code && m.done && (
          <div className="code-block">
            <div className="code-head">
              <div className="code-head-left">
                <span className="code-lang-tag">
                  <i className="lang-dot" /> {m.file ? (m.file.endsWith('.sh') ? 'bash' : m.file.endsWith('.tsx') ? 'tsx' : m.file.replace(/^.*\./, '')) : 'bash'}
                </span>
                <span className="code-file-name">{esc(m.file || 'main.tsx')}</span>
              </div>
              <button
                type="button"
                className="code-copy-btn"
                title="Kopírovať kód"
                onClick={() => {
                  void navigator.clipboard?.writeText(m.code ?? '');
                  st.toast('Kód skopírovaný', 'ok');
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
              </button>
            </div>
            <pre dangerouslySetInnerHTML={{ __html: hl(m.code) }} />
          </div>
        )}
        {!isUser && m.done && (
          <div className="actions">
            <button className="qact" onClick={() => { void navigator.clipboard?.writeText(m.code ?? m.text).then(() => st.toast(m.code ? 'Kód skopírovaný' : 'Odpoveď skopírovaná', 'ok')).catch(() => st.toast('Prehliadač nepovolil kopírovanie. Text môžeš označiť ručne.', 'warn')); if (!navigator.clipboard) st.toast('Kopírovanie teraz nie je dostupné. Text môžeš označiť ručne.', 'warn'); }}>⧉ Kopírovať</button>
            <button className="qact" onClick={() => st.toast('Fork — nový projekt z verzie', 'ok')}>⑂ Fork</button>
            <button className="qact" onClick={() => { const position = st.messages.findIndex(message => message.id === m.id); const last = st.messages.slice(0, position).filter(x => x.role === 'user').pop(); if (last) { if (st.model === 'Instant Draft') st.generate(last.text); else void st.generateWithAi(last.text, 'auto'); } }}>↻ Re-run</button>
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
  const [previewRevision, setPreviewRevision] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const html = st.sandboxHtml ?? st.currentHtml();
  const iter = st.snapshots.length ? 'v' + st.snapshots.length : 'v1';
  const tokens = st.liveHtml ? Math.ceil(st.liveHtml.length / 4) : 0;
  const snapshot = st.edSnap();
  const needsCompile = !!snapshot && (st.vfs[snapshot.id] ?? []).some(file => file.name === 'src/main.tsx') && !st.sandboxHtml;

  const rawHtml = st.sandboxHtml ?? ('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">' + withoutExternalScripts(html ?? '') + '</body></html>');
  const previewDocument = useMemo(() => {
    const withBoundary = injectRuntimeBoundary(rawHtml);
    return injectInspectorBridge(withBoundary, st.editMode);
  }, [rawHtml, st.editMode]);

  /* Synchronizácia editMode režimu do preview iframe cez postMessage */
  useEffect(() => {
    const iframe = document.getElementById('previewFrame') as HTMLIFrameElement | null;
    iframe?.contentWindow?.postMessage({ type: INSPECTOR_SET_MODE_TYPE, enabled: st.editMode }, '*');
  }, [st.editMode]);

  /* Odchytávanie správ z inšpektora a runtime error boundary z preview iframe */
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!ev.data || typeof ev.data !== 'object') return;

      // 1. Inšpektor elementov
      if (ev.data.type === INSPECTOR_MESSAGE_TYPE) {
        const { tag, text, selector, outerHTML } = ev.data as { type: string } & InspectedElement;
        st.setInspectedElement({ tag, text, selector, outerHTML });

        // Predvyplnenie prompt draftu podľa požiadavky 3
        const snippet = text ? ` ("${text.length > 35 ? text.slice(0, 32) + '…' : text}")` : '';
        const promptContext = `Uprav tento prvok <${tag}>${snippet}: `;

        const current = useStore.getState().promptDraft.trim();
        let nextDraft = '';
        if (!current || current.startsWith('Uprav tento prvok <')) {
          nextDraft = promptContext;
        } else if (!current.includes(promptContext)) {
          nextDraft = `${promptContext}${current}`;
        } else {
          nextDraft = current;
        }
        st.setPromptDraft(nextDraft);

        // Focus na #promptInput
        if (inputRef.current) {
          inputRef.current.focus();
          try {
            inputRef.current.setSelectionRange(nextDraft.length, nextDraft.length);
          } catch {}
        }
        return;
      }

      // 2. Detekcia runtime chyby (pasívny zber & banner)
      if (ev.data.type === RUNTIME_ERROR_DETECTED_TYPE) {
        const payload = ev.data as { type: string } & RuntimeCrashPayload;
        st.setRuntimeCrash({
          message: payload.message,
          stack: payload.stack,
          component: payload.component,
          filename: payload.filename,
          lineno: payload.lineno,
          colno: payload.colno,
          timestamp: payload.timestamp || Date.now()
        });
        st.log(`[Preview Error] ${payload.message}`, 'error');
        return;
      }

      // 3. 1-Click AI oprava z crash overlayu v iframe
      if (ev.data.type === RUNTIME_CRASH_MESSAGE_TYPE) {
        const payload = ev.data as { type: string } & RuntimeCrashPayload;
        void st.triggerAiRuntimeRepair({
          message: payload.message,
          stack: payload.stack,
          component: payload.component,
          filename: payload.filename,
          lineno: payload.lineno,
          colno: payload.colno,
          timestamp: payload.timestamp || Date.now()
        });
        return;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [st.setInspectedElement, st.setPromptDraft, st.setRuntimeCrash, st.log, st.triggerAiRuntimeRepair]);

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
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
  }, [st.messages.length]);

  const submit = () => {
    const v = st.promptDraft.trim();
    if (!v || st.generating || st.pendingReview) return;
    st.setPromptDraft('');
    st.clearInspectedElement();
    const iframe = document.getElementById('previewFrame') as HTMLIFrameElement | null;
    iframe?.contentWindow?.postMessage({ type: INSPECTOR_CLEAR_TYPE }, '*');
    /* M2: AI (Mistral) model → reálny engine; Instant Draft / iné → template mód */
    if (st.model !== 'Instant Draft') {
      void st.generateWithAi(v, 'auto');
    } else {
      st.generate(v);
    }
  };

  /* legacy applyViewport parita: desktop = 100% šírky + auto-fit scale; tablet/mobile fixná šírka */
  const deviceW = st.viewport === 'desktop' ? '100%' : st.viewport === 'tablet' ? 768 : 390;

  return (
    <main id="workspaceView">
      <aside className="chat-panel" id="chatPanel">
        <div className="chat-head">
          <div className="iter">Verzia <span className="n" id="iterNum">{iter}</span></div>
          <button className="new-session" id="newSessionBtn" onClick={() => { st.newProject(); st.goHome(); }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
            Nový projekt
          </button>
        </div>
        <ConnectionPanel />
        <div className="chat-scroll" id="chatScroll" ref={scrollRef}>
          {st.messages.length === 0 && (
            <div className="empty-chat">
              <div className="ec-badge">V</div>
              <p>Popíš zmenu alebo sa opýtaj na projekt. Návrhy súborov skontroluješ pred použitím.</p>
            </div>
          )}
          {st.messages.map(m => <ChatMessage key={m.id} m={m} />)}
        </div>
        <LiveGenerationInspector />
        <JobTransportStatus />
        <ReviewPanel />
        {st.templateFollowups.length > 0 && !st.pendingReview && <div className="workspace-followups" aria-label="Nápady na ďalší krok">{st.templateFollowups.map(prompt => <button key={prompt} onClick={() => st.usePrompt(prompt)}>{prompt}</button>)}</div>}
        
        {st.messages.length > 2 && (
          <button
            type="button"
            className="floating-scroll-down-btn"
            onClick={() => scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
            title="Posunúť na najnovšiu správu"
            aria-label="Posunúť nadol"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          </button>
        )}

        <div className="composer">
          <div className="comp-box">
            {st.runtimeCrash && (
              <div className="runtime-crash-banner" id="runtimeCrashBanner" role="alert" aria-label="Zistená runtime chyba v náhľade">
                <div className="rcb-content">
                  <div className="rcb-badge">
                    <span className="rcb-pulse" />
                    <span className="rcb-icon">⚠️</span>
                    <strong>Chyba v náhľade:</strong>
                  </div>
                  <div className="rcb-info" title={st.runtimeCrash.message}>
                    {st.runtimeCrash.component && (
                      <code className="rcb-comp">&lt;{st.runtimeCrash.component}&gt;</code>
                    )}
                    <span className="rcb-msg">{st.runtimeCrash.message}</span>
                  </div>
                </div>
                <div className="rcb-actions">
                  <button
                    type="button"
                    className="rcb-repair-btn"
                    id="runtimeRepairBtn"
                    disabled={st.generating || !!st.pendingReview}
                    onClick={() => void st.triggerAiRuntimeRepair()}
                    title="Jedným klikom spustiť opravu cez AI (Mistral)"
                  >
                    <span className="spark-icon">⚡</span>
                    Opraviť cez AI ({st.model})
                  </button>
                  <button
                    type="button"
                    className="rcb-dismiss-btn"
                    id="dismissCrashBtn"
                    onClick={st.clearRuntimeCrash}
                    title="Zavrieť chybové hlásenie"
                    aria-label="Zavrieť chybové hlásenie"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
            {st.inspectedElement && (
              <div className="inspector-target-badge" id="inspectorTargetBadge" role="status" aria-label="Vybraný prvok na úpravu">
                <div className="itb-info">
                  <span className="itb-icon">🎯</span>
                  <span className="itb-label">Vybraný prvok:</span>
                  <strong className="itb-tag">&lt;{st.inspectedElement.tag}&gt;</strong>
                  {st.inspectedElement.text && (
                    <span className="itb-text" title={st.inspectedElement.text}>"{st.inspectedElement.text.slice(0, 30)}"</span>
                  )}
                  <code className="itb-selector" title={st.inspectedElement.selector}>{st.inspectedElement.selector}</code>
                </div>
                <button
                  type="button"
                  className="itb-clear"
                  id="clearInspectBtn"
                  onClick={() => {
                    st.clearInspectedElement();
                    const iframe = document.getElementById('previewFrame') as HTMLIFrameElement | null;
                    iframe?.contentWindow?.postMessage({ type: INSPECTOR_CLEAR_TYPE }, '*');
                  }}
                  title="Zrušiť výber prvku"
                  aria-label="Zrušiť výber prvku"
                >
                  ✕
                </button>
              </div>
            )}
            <textarea
              id="promptInput"
              ref={inputRef}
              rows={1}
              aria-label="Popíš zmenu"
              value={st.promptDraft}
              onChange={event => st.setPromptDraft(event.target.value)}
              placeholder="Ask anything or type @ to add context (Ctrl+Enter)"
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); } }}
            />
            <div className="comp-actions">
              <div className="comp-left">
                {/* Book / doc context icon (Image 3) */}
                <button
                  type="button"
                  className="icon-btn hp-action-btn mobile-only-btn"
                  title="Dokumentácia a kontext"
                  onClick={() => st.toast('Kontext projektu pripravený', 'info')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/></svg>
                </button>

                {/* Attach / + icon button */}
                <button
                  type="button"
                  className="icon-btn hp-action-btn"
                  id="attachBtn"
                  title="Prílohy a súbory"
                  disabled
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 5v14M5 12h14" /></svg>
                </button>

                {/* Model Pill (Image 3) */}
                <button
                  type="button"
                  className="chip mobile-composer-chip"
                  id="workspaceModelChip"
                  onClick={() => {
                    st.setModelMenuOpen(!st.modelMenuOpen);
                    document.getElementById('modelChip')?.focus();
                  }}
                  title={`Aktuálny model: ${st.model} · klikni pre zmenu`}
                >
                  <span className="spark-icon">✦</span>
                  <strong>{st.model}</strong>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6" /></svg>
                </button>

                {/* Optimization / Balance Pill (Image 3) */}
                <button
                  type="button"
                  className="chip mobile-composer-chip mobile-only-btn"
                  onClick={() => st.toast('Režim optimalizácie: Vyvážený (Balance)', 'info')}
                  title="Optimalizácia modelu"
                >
                  <span>Optimized for: Balance ▾</span>
                </button>

                {/* Speedometer Badge (Image 3) */}
                <span className="hp-speedometer-badge mobile-only-btn" title="Rýchlosť odpovede">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </span>

                <span className="token-count desktop-only" id="tokenCount">≈ {tokens} tok · kontext podľa modelu</span>
              </div>
              <div className="comp-right">
                {st.generating && st.aiAbort ? (
                  <button className="send-btn cancel-btn" id="cancelBtn" title="Zrušiť generovanie" onClick={st.cancelAiRun}>✕</button>
                ) : (
                  <button
                    className={'send-btn' + (st.promptDraft.trim() && !st.generating && !st.pendingReview ? ' neon-cta-active' : '')}
                    id="sendBtn"
                    title="Odoslať (Ctrl+Enter)"
                    disabled={st.generating || !!st.pendingReview || !st.promptDraft.trim()}
                    onClick={submit}
                    aria-label="Odoslať (Ctrl+Enter)"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" /></svg>
                  </button>
                )}
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
          if (e.key === 'ArrowLeft') { e.preventDefault(); document.documentElement.style.setProperty('--chat-w', Math.max(340, cur - 20) + 'px'); }
          if (e.key === 'ArrowRight') { e.preventDefault(); document.documentElement.style.setProperty('--chat-w', Math.min(560, cur + 20) + 'px'); }
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
            {st.tab === 'preview' && <>
              <button className={'edit-chip' + (st.editMode ? ' active' : '')} id="editToggle" title="Visual Edit mode — klikaj na elementy v preview" onClick={st.toggleEditMode}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                Edit
              </button>
              <div className="seg" id="viewportSeg">
                {(['desktop', 'tablet', 'mobile'] as const).map(vp => (
                  <button key={vp} data-vp={vp} className={st.viewport === vp ? 'active' : ''} title={vp === 'desktop' ? 'Desktop — 100%' : vp === 'tablet' ? 'Tablet — 768px' : 'Mobile — 390px'} onClick={() => st.setViewport(vp)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      {vp === 'desktop' ? <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></> :
                        vp === 'tablet' ? <><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M12 18h.01" /></> :
                          <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M12 18h.01" /></>}
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
                onClick={() => { if (!html) { st.toast('Zatiaľ žiadne HTML na obnovenie', 'warn'); return; } setPreviewRevision(value => value + 1); st.toast('Preview obnovený', 'ok'); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5" /></svg>
              </button>
              <button className="icon-btn hide-m" id="openTabBtn" title="Otvoriť v novom tabe" style={{ padding: '0 7px' }}
                onClick={() => st.toast('Sandbox upozornenie: otváram v novom tabe (demo)', 'warn')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" /></svg>
              </button>
            </>}
            <button className="icon-btn" id="snapBtn" title="Uložiť verziu (Ctrl+S)" style={{ padding: '0 7px' }} onClick={st.manualSnapshot}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z" /><circle cx="12" cy="13" r="4" /></svg>
            </button>
          </div>
        </div>
        <div className="canvas-body">
          <div className={'pane' + (st.tab === 'preview' ? ' active' : '')} data-pane="preview">
            <div className="viewport-wrap" id="viewportWrap" ref={wrapRef}>
              {st.viewing && (
                <div className="hist-banner show" id="histBanner">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
                  <span id="histBannerText">Prezeráš historickú verziu v{st.viewing.v}</span>
                  <button className="back" id="backToLive" onClick={st.backToLive}>Späť na live verziu</button>
                </div>
              )}
              {st.sandboxBuilding ? <div className="product-empty" role="status"><span className="spinner" /><h3>Pripravujem tvoj náhľad…</h3><p>Kompilujem súbory projektu.</p><button className="btn-ghost" onClick={st.stopSandbox}>Zrušiť build</button></div> : st.sandboxErrors.length ? <div className="product-empty" role="alert"><h3>Náhľad sa nepodarilo zostaviť.</h3>{st.sandboxErrors.map((error, index) => <p key={index}>{error.file}: {error.message}</p>)}<BuildRepairAction /><button className="btn-ghost" onClick={() => void st.runSandbox()}>Skúsiť znova</button></div> : needsCompile ? <div className="product-empty"><h3>Tvoj projekt je pripravený.</h3><p>Spusti náhľad a vyskúšaj jeho funkcie.</p><button className="btn-primary" onClick={() => void st.runSandbox()}>Spustiť náhľad</button></div> : html ? (
                <div className="device" id="device" style={{ width: deviceW, height: 'calc(100% - 8px)' }}>
                  {/* Compiled HTML keeps CSP form-action 'none'; allow-forms lets local React submit handlers run. */}
                  <iframe id="previewFrame" key={(st.sandboxHtml ? 'compiled-' : 'html-') + previewRevision} srcDoc={previewDocument} sandbox={st.sandboxHtml ? 'allow-scripts allow-forms' : 'allow-scripts'} title="Live preview" />
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
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                  Edit mode — prejdi kurzorom po preview a vyber element na úpravu
                </div>
              )}
            </div>
          </div>
          <div className={'pane' + (st.tab === 'code' ? ' active' : '')} data-pane="raw">
            <div className="pane-inner">
              <CodePane />
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
              {st.tab === 'diff' && <ProjectDiff key={st.projectId} />}
            </div>
          </div>
        </div>
        <div className={'history' + (st.historyExpanded ? ' expanded' : '')} id="historyBar">
          <div className="hist-head">
            <div className="hist-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v5h5M3.05 13A9 9 0 1 0 6 5.3L3 8M12 7v5l3 3" /></svg>
              História verzií <span className="count" id="snapCount">{st.snapshots.length}</span>
            </div>
            <button className="icon-btn" id="histToggle" onClick={st.toggleHistoryExpanded}>
              <span id="histToggleTxt">{st.historyExpanded ? 'Zbaliť' : 'Expandovať'}</span>
              <svg id="histChevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6" /></svg>
            </button>
          </div>
          <div className="hist-list" id="histList">
            {st.snapshots.length === 0 ? <div className="pane-empty">Žiadne verzie — vygeneruj appku (Ctrl+Enter) alebo ulož checkpoint (Ctrl+S).</div> :
              [...st.snapshots].reverse().map(s => (
                <div key={s.id} role="button" tabIndex={0}
                  className={'snap' + (s.pinned ? ' pinned' : '') + (!st.viewing && s.id === st.liveId ? ' current' : '')} data-snap={s.id}
                  onClick={() => st.viewSnapshot(s.id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.viewSnapshot(s.id); } }}>
                  <div className="snap-thumb" style={{ background: (THUMBS as Record<string, string>)[s.kind] || THUMBS.dashboard }}><span className="snap-thumb-label">v{s.v}</span></div>
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
