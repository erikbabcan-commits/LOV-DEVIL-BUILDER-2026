import React from 'react';
import { useStore } from '../stores/useAppStore';

export function Sidebar({ activeTab = 'overview', onSelect }: { activeTab?: string; onSelect?: (tab: string) => void }) {
  const st = useStore();

  const navItems = [
    {
      id: 'overview',
      label: 'Prehľad',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ),
      action: () => st.goEditor()
    },
    {
      id: 'templates',
      label: 'Šablóny',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      ),
      action: () => {
        const el = document.getElementById('connectorsModule');
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }
    }
  ];

  return (
    <aside aria-label="Navigácia pracoviska" className="workspace-sidebar" style={{
      width: '184px',
      height: 'calc(100vh - 56px)',
      background: 'var(--surface-navigation, #191919)',
      borderRight: '1px solid var(--border-subtle, #2E2E2E)',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: '12px 8px',
      boxSizing: 'border-box',
      flexShrink: 0
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {navItems.map(item => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => {
                if (item.action) item.action();
                if (onSelect) onSelect(item.id);
              }}
              style={{
                width: '100%',
                height: '38px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '0 10px',
                borderRadius: 'var(--radius-control, 6px)',
                background: isActive ? 'var(--surface-selected, #303030)' : 'transparent',
                color: isActive ? 'var(--foreground, #EDEDED)' : 'var(--text-secondary, #B5B5B5)',
                border: 'none',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: isActive ? 500 : 400,
                transition: 'background var(--duration-fast, 120ms), color var(--duration-fast, 120ms)',
                textAlign: 'left'
              }}
            >
              <span style={{ color: isActive ? 'var(--primary, #4ADE80)' : 'inherit', display: 'flex' }}>
                {item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      <div style={{ borderTop: '1px solid var(--border-subtle, #2E2E2E)', paddingTop: '8px' }}>
        <button
          onClick={() => st.setSettingsOpen(true)}
          style={{
            width: '100%',
            height: '38px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '0 10px',
            borderRadius: 'var(--radius-control, 6px)',
            background: 'transparent',
            color: 'var(--text-muted, #A3A3A3)',
            border: 'none',
            cursor: 'pointer',
            fontSize: '13px',
            transition: 'color var(--duration-fast, 120ms)'
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
          <span>Nastavenia</span>
        </button>
      </div>
    </aside>
  );
}
