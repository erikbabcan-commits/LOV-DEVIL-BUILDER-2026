import React from 'react';
import { useStore } from '../stores/useAppStore';

/* LUMEN: 54px ikonový rail — #09090B, vpravo hairline, hore neon logo + 4 ikony, dole avatar. */

export function Sidebar({ activeTab = 'overview', onSelect }: { activeTab?: string; onSelect?: (tab: string) => void }) {
  const st = useStore();

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
      action: () => st.goEditor()
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
      action: () => { st.goEditor(); st.setEdTab('blueprints'); }
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
      action: () => { st.goEditor(); }
    }
  ];

  return (
    <aside
      aria-label="Navigácia pracoviska"
      className="workspace-sidebar"
      style={{
        width: '54px',
        height: 'calc(100dvh - 56px)',
        background: 'var(--bg-sidebar, #09090B)',
        borderRight: '1px solid rgba(255, 255, 255, 0.06)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 0',
        boxSizing: 'border-box',
        flexShrink: 0
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
        {/* Logo 32x32, zelený neónový okraj */}
        <div
          className="neon-logo"
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

        {/* 4 ikonové tlačidlá 36x36 */}
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
                if (item.action) item.action();
                if (onSelect) onSelect(item.id);
              }}
            >
              {item.icon}
            </button>
          );
        })}
      </div>

      {/* Spodná časť: nastavenia + avatar 32px */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          borderTop: '1px solid rgba(255, 255, 255, 0.06)',
          paddingTop: '10px'
        }}
      >
        <button
          type="button"
          className="neon-icon-btn"
          aria-label="Nastavenia"
          title="Nastavenia"
          onClick={() => st.setSettingsOpen(true)}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
        </button>
        <div
          className="avatar-chip"
          role="img"
          aria-label="Účet používateľa"
          title="Účet"
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            background: 'var(--surface-carbon-top, #161719)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            color: 'var(--text-secondary, #A1A1AA)',
            fontSize: '11px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none'
          }}
        >
          YH
        </div>
      </div>
    </aside>
  );
}
