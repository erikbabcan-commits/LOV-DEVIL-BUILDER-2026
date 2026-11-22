import React, { useState } from 'react';
import { useStore } from '../stores/useAppStore';
import type { QuotaInfo } from '../services/auth';

export function BottomStatusBar({ quota }: { quota?: QuotaInfo }) {
  const st = useStore();
  const [autocompleteOn, setAutocompleteOn] = useState(true);
  const storeQuota = useStore(s => (s as { quota?: QuotaInfo }).quota);

  const activeQuota = quota || storeQuota;
  const creditsRemaining = activeQuota ? activeQuota.remaining : 1240;
  const creditsTotal = activeQuota ? activeQuota.limit : 2000;
  const sandboxActive = !!st.sandboxHtml;

  const toggleAutocomplete = () => {
    setAutocompleteOn(prev => {
      const next = !prev;
      st.toast(`Autocomplete ${next ? 'zapnutý' : 'vypnutý'}`, 'info');
      return next;
    });
  };

  const handleReportIssue = () => {
    st.toast('Otváram formulár na hlásenie chýb…', 'info');
  };

  return (
    <footer className="ide-status-bar" role="contentinfo" aria-label="Stavový riadok IDE">
      <div className="status-bar-left">
        <button
          type="button"
          className={'status-item status-btn' + (autocompleteOn ? ' active' : '')}
          onClick={toggleAutocomplete}
          title={autocompleteOn ? 'Autocomplete je aktívny · klikni pre vypnutie' : 'Autocomplete je vypnutý · klikni pre zapnutie'}
        >
          <span className="status-icon" aria-hidden="true">⊘</span>
          <span className="status-text">Autocomplete</span>
        </button>

        <button
          type="button"
          className="status-item status-btn"
          onClick={handleReportIssue}
          title="Nahlásiť problém alebo spätú väzbu"
        >
          <span className="status-icon" aria-hidden="true">🐛</span>
          <span className="status-text">Report issue</span>
        </button>

        <div className="status-item" title={sandboxActive ? 'Sandbox je aktívny' : 'Sandbox je neaktívny'}>
          <span className="status-icon" aria-hidden="true">🛡</span>
          <span className="status-text">Sandbox: {sandboxActive ? 'On' : 'Off'}</span>
        </div>
      </div>

      <div className="status-bar-right">
        <div
          className="status-item status-quota"
          title={`Zostáva ${creditsRemaining} z ${creditsTotal} kreditov`}
        >
          <span className="status-icon quota-bars" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 20V10M12 20V4M6 20v-6" />
            </svg>
          </span>
          <span className="status-text">
            Vorkei Free <strong className="font-mono">{creditsRemaining} / {creditsTotal}</strong> updated just now
          </span>
        </div>

        <button
          type="button"
          className="status-item status-btn status-bell"
          onClick={() => st.toast('Žiadne nové oznámenia', 'info')}
          title="Oznámenia"
          aria-label="Oznámenia"
        >
          <span className="status-icon" aria-hidden="true">🔔</span>
        </button>
      </div>
    </footer>
  );
}
