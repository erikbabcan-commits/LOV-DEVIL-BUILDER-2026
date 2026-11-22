import React from 'react';
import { useStore } from '../stores/useAppStore';

/* LUMEN: 54px ikonový rail — #09090B, vpravo hairline, hore neon logo + 4 ikony, dole avatar. */

export function Sidebar({ activeTab = 'overview', onSelect }: { activeTab?: string; onSelect?: (tab: string) => void }) {
  const isOpen = useStore(s => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useStore(s => s.setMobileSidebarOpen);
  const goEditor = useStore(s => s.goEditor);
  const setEdTab = useStore(s => s.setEdTab);
  const setSettingsOpen = useStore(s => s.setSettingsOpen);
  const exportToZip = useStore(s => s.exportToZip);
  const exportToGitHub = useStore(s => s.exportToGitHub);
  const toggleGitHubConnection = useStore(s => s.toggleGitHubConnection);
  const githubAuthState = useStore(s => s.githubAuthState);
  const githubExportInProgress = useStore(s => s.githubExportInProgress);

  const navItems = [
    {
      id: 'overview',
      label: 'Prehľad',
      icon: (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="9" rx="1.5" />
          <rect x="14" y="3" width="7" height="5" rx="1.5" />
          <rect x="14" y="12" width="7" height="9" rx="1.5" />
          <rect x="3" y="16" width="7" height="5" rx="1.5" />
        </svg>
      )
    },
    {
      id: 'projects',
      label: 'Projekty',
      icon: (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ),
      action: () => goEditor()
    },
    {
      id: 'templates',
      label: 'Šablóny',
      icon: (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
      ),
      action: () => { goEditor(); setEdTab('blueprints'); }
    },
    {
      id: 'connectors',
      label: 'Konektory',
      icon: (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      ),
      action: () => { goEditor(); }
    }
  ];

  return (
    <>
      {isOpen && <div className="sidebar-backdrop" onClick={() => setMobileSidebarOpen(false)} aria-hidden="true" />}
      <aside
        aria-label="Navigácia pracoviska"
        className={'workspace-sidebar' + (isOpen ? ' mobile-open' : '')}
      >
        <div className="sidebar-top-group">
          {/* Mobilná hlavička so zatvorením */}
          <div className="sidebar-mobile-head">
            <div className="neon-logo" title="VORKEI" aria-label="VORKEI">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#EAFBF0" aria-hidden="true">
                <path d="M12 21s-7.5-4.7-10-9.3C.4 8.2 2.5 4.5 6.1 4.5c2.2 0 3.9 1.2 4.9 3-1.6-3-1-9 1-9s2.6 6 1 9c1-1.8 2.7-3 4.9-3 3.6 0 5.7 3.7 4.1 7.2C19.5 16.3 12 21 12 21Z" />
              </svg>
            </div>
            <span className="sidebar-mobile-title">VORKEI Workspace</span>
            <button
              type="button"
              className="icon-btn sidebar-close-btn"
              onClick={() => setMobileSidebarOpen(false)}
              aria-label="Zatvoriť menu"
            >
              ✕
            </button>
          </div>

          {/* Štandardné logo pre desktop */}
          <div
            className="neon-logo desktop-only"
            title="VORKEI"
            aria-label="VORKEI"
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '10px',
              background: 'var(--neon-green, #4ADE80)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '8px'
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#EAFBF0" aria-hidden="true">
              <path d="M12 21s-7.5-4.7-10-9.3C.4 8.2 2.5 4.5 6.1 4.5c2.2 0 3.9 1.2 4.9 3-1.6-3-1-9 1-9s2.6 6 1 9c1-1.8 2.7-3 4.9-3 3.6 0 5.7 3.7 4.1 7.2C19.5 16.3 12 21 12 21Z" />
            </svg>
          </div>

          {/* Navigačné položky */}
          <nav className="sidebar-nav-items">
            {navItems.map(item => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={'neon-icon-btn' + (isActive ? ' active' : '')}
                  aria-label={item.label}
                  aria-current={isActive ? 'page' : undefined}
                  title={item.label}
                  onClick={() => {
                    setMobileSidebarOpen(false);
                    if (item.action) item.action();
                    if (onSelect) onSelect(item.id);
                  }}
                >
                  {item.icon}
                  <span className="sidebar-item-label">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Mobilné rýchle akcie v draweri */}
          <div className="sidebar-mobile-actions">
            <button
              type="button"
              className="drawer-action-btn"
              onClick={() => { setMobileSidebarOpen(false); void exportToZip(); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
              <span>Export ZIP</span>
            </button>
            <button
              type="button"
              className="drawer-action-btn"
              onClick={() => { setMobileSidebarOpen(false); void toggleGitHubConnection(); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
              <span>{githubAuthState.authenticated ? (githubAuthState.username ? '@' + githubAuthState.username : 'GitHub Pripojený') : 'Pripojiť GitHub'}</span>
            </button>
            <button
              type="button"
              className="drawer-action-btn"
              disabled={githubExportInProgress || !githubAuthState.authenticated}
              onClick={() => { setMobileSidebarOpen(false); void exportToGitHub(); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg>
              <span>Export na GitHub</span>
            </button>
          </div>
        </div>

        {/* Spodná časť: nastavenia + avatar */}
        <div className="sidebar-bottom-group">
          <button
            type="button"
            className="neon-icon-btn"
            aria-label="Nastavenia"
            title="Nastavenia"
            onClick={() => { setMobileSidebarOpen(false); setSettingsOpen(true); }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z" />
            </svg>
            <span className="sidebar-item-label">Nastavenia</span>
          </button>
          <div
            className="avatar-chip"
            role="img"
            aria-label="Účet používateľa"
            title="Účet"
          >
            YH
          </div>
        </div>
      </aside>
    </>
  );
}
