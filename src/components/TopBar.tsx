import { useRef, useEffect } from 'react';
import { useStore } from '../stores/useAppStore';

/* Port 1:1 legacy topbar — rovnaké triedy/ID, dropdowny via React state. */
const MODELS: { name: string; sub: string }[] = [
  { name: 'Lovable Cloud', sub: 'Agent 3 · plný stack, auth & DB' },
  { name: 'AI (Mistral)', sub: 'Reálny AI engine — M2' },
  { name: 'Instant Draft', sub: 'Šablóny bez AI (demo)' },
  { name: 'Claude 4.5 Sonnet', sub: 'Najlepší na UI/UX' },
  { name: 'GPT-5', sub: 'Silný na logiku' },
  { name: 'Llama 4', sub: 'Open-source' },
];

export function TopBar() {
  const st = useStore();
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (st.titleEditing) titleRef.current?.select(); }, [st.titleEditing]);

  const commitTitle = () => { st.setTitleEditing(false); };

  return (
    <header className="topbar">
      <div className="tb-group">
        <div className="logo-badge">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="#fff"><path d="M12 21s-7.5-4.7-10-9.3C.4 8.2 2.5 4.5 6.1 4.5c2.2 0 3.9 1.2 4.9 3-1.6-3-1-9 1-9s2.6 6 1 9c1-1.8 2.7-3 4.9-3 3.6 0 5.7 3.7 4.1 7.2C19.5 16.3 12 21 12 21Z"/></svg>
        </div>
        <span className="app-name">Forge</span>
        <div className="session">
          {st.titleEditing ? (
            <input ref={titleRef} className="session-title-input" value={st.projectTitle}
              onChange={e => st.setTitle(e.target.value)} onBlur={commitTitle}
              onKeyDown={e => { if (e.key === 'Enter') commitTitle(); }} />
          ) : (
            <span className="session-title" id="sessionTitle" title="Klikni pre premenovanie"
              onClick={() => st.setTitleEditing(true)}>{st.projectTitle}</span>
          )}
          <button className="icon-btn" id="editTitleBtn" title="Premenovať" style={{ padding: '0 5px' }}
            onClick={() => st.setTitleEditing(true)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
        </div>
        <div className="save-status"><i className="save-dot"></i><span id="saveStatus">Uložené</span></div>
        <span className="vis-chip hide-m" id="visChip">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span>{st.isPublic ? 'Public' : 'Súkromné'}</span>
        </span>
        <button className="chip" id="editorBtn" title="/editor — dashboard projektov" onClick={st.goEditor}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
          <span className="hide-s">Editor</span>
        </button>
      </div>
      <div className="tb-group">
        <div className="pop-wrap">
          <button className="chip" id="modelChip" onClick={() => st.setModelMenuOpen(!st.modelMenuOpen)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a4 4 0 0 1 4 4c2.5.5 4 2.5 4 5a5 5 0 0 1-3 4.6V18a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2v-2.4A5 5 0 0 1 4 11c0-2.5 1.5-4.5 4-5a4 4 0 0 1 4-4Z"/></svg>
            <span id="modelName">{st.model}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div className={'dropdown' + (st.modelMenuOpen ? ' open' : '')} id="modelMenu">
            {MODELS.map(m => (
              <button key={m.name} className="item" onClick={() => st.setModel(m.name)}>
                <span>{m.name}<div className="sub">{m.sub}</div></span>
                <span className="check">{st.model === m.name ? '✓' : ''}</span>
              </button>
            ))}
          </div>
        </div>
        <button className="btn-ghost hide-m" id="remixBtn" title="Remix komunitného projektu"
          onClick={() => { st.newProject(); st.goHome(); st.toast('Remix — projekt nahraný do promptu'); }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          Remix
        </button>
        <button className="btn-ghost hide-s" id="exportBtn"
          onClick={() => { if (!st.liveHtml) { st.toast('Najprv vygeneruj appku na export', 'warn'); return; } st.toast('Export ZIP: index.html + assets (demo)', 'ok'); }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          Export ZIP
        </button>
        <button className="btn-primary" id="publishBtn" onClick={st.publish}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2 0-2.8-.8-.7-2-.8-3 0Zm7-5.5 2 2c5-5 7-11 7-11s-6 2-11 7l2 2Zm-5 1c-2 1-3 3-3 5 1 0 3.5-.5 5-2"/></svg>
          <span id="publishBtnTxt">{st.publishedUrl ? 'Publikované ✓' : 'Publish'}</span>
        </button>
        <div className="pop-wrap">
          <button className="icon-btn" id="settingsBtn" title="Nastavenia" style={{ padding: '0 7px' }}
            onClick={() => st.setSettingsOpen(!st.settingsOpen)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z"/></svg>
          </button>
          <div className={'settings-pop' + (st.settingsOpen ? ' open' : '')} id="settingsPop">
            <h4>Nastavenia projektu</h4>
            <div className="set-row">Public projekt
              <div className={'switch' + (st.isPublic ? ' on' : '')} id="pubSwitch" onClick={st.togglePublic}></div>
            </div>
            <div className="set-row">Auto-save <div className="switch on"></div></div>
            <div className="set-row">Skeleton pri generovaní <div className="switch on"></div></div>
          </div>
        </div>
        <div className="avatar-chip hide-m">YH</div>
      </div>
    </header>
  );
}
