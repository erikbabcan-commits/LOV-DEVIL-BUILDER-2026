/**
 * ExportDialog - Unified Export & Cloud Deploy modal dialog
 * Tabs:
 *  - "GitHub Provision" -> Standalone repo generation
 *  - "Cloud Deploy" -> Vercel / Netlify Deploy Hook with status indicator (Queued -> Building -> Ready)
 *  - "ZIP Archív" -> Classic zip download
 */

import { useState } from 'react';
import { OneClickExportModal } from './OneClickExportModal';
import { apiUrl } from '../../lib/api';

export type ExportDialogTab = 'github' | 'cloud' | 'zip';

interface ExportDialogProps {
  projectTitle: string;
  htmlContent?: string | null;
  onClose: () => void;
  githubAuthenticated: boolean;
  githubUsername?: string;
  initialTab?: ExportDialogTab;
  onDownloadZip?: () => void;
}

type CloudDeployStatus = 'idle' | 'queued' | 'building' | 'ready' | 'error';

export function ExportDialog({
  projectTitle,
  htmlContent,
  onClose,
  githubAuthenticated,
  githubUsername,
  initialTab = 'github',
  onDownloadZip,
}: ExportDialogProps) {
  const [tab, setTab] = useState<ExportDialogTab>(initialTab);

  // Cloud deploy state
  const [webhookUrl, setWebhookUrl] = useState('');
  const [provider, setProvider] = useState<'vercel' | 'netlify'>('vercel');
  const [deployStatus, setDeployStatus] = useState<CloudDeployStatus>('idle');
  const [deployResult, setDeployResult] = useState<{ jobId?: string | null; statusUrl?: string | null } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleTriggerDeploy = async () => {
    if (!webhookUrl) return;
    setDeployStatus('queued');
    setErrorMessage(null);

    try {
      // Simulate state progression Queued -> Building
      const timer = setTimeout(() => {
        setDeployStatus('building');
      }, 1000);

      const res = await fetch(apiUrl('/api/github/deploy-hook'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl,
          provider,
        }),
      });

      clearTimeout(timer);

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage(data.error || `HTTP ${res.status}`);
        setDeployStatus('error');
        return;
      }

      const data = await res.json();
      setDeployResult({
        jobId: data.jobId,
        statusUrl: data.statusUrl,
      });
      setDeployStatus('ready');
    } catch (err) {
      setErrorMessage(String(err));
      setDeployStatus('error');
    }
  };

  return (
    <div className="one-click-export-overlay" role="dialog" aria-modal="true" aria-label="Export a Deploy">
      <div className="one-click-export-modal" style={{ maxWidth: '520px' }}>
        {/* Modal Header & Tabs */}
        <div className="oce-header" style={{ marginBottom: '8px' }}>
          <div className="oce-title" style={{ fontSize: '18px' }}>🚀 Export & Cloud Deploy</div>
          <button className="oce-close" onClick={onClose} aria-label="Zavrieť">✕</button>
        </div>

        <div className="oce-toggle-row">
          <button
            className={`oce-toggle${tab === 'github' ? ' active' : ''}`}
            onClick={() => setTab('github')}
          >
            🐙 GitHub Provision
          </button>
          <button
            className={`oce-toggle${tab === 'cloud' ? ' active' : ''}`}
            onClick={() => setTab('cloud')}
          >
            ☁️ Cloud Deploy
          </button>
          <button
            className={`oce-toggle${tab === 'zip' ? ' active' : ''}`}
            onClick={() => setTab('zip')}
          >
            📦 ZIP Archív
          </button>
        </div>

        {/* Tab 1: GitHub Provision */}
        {tab === 'github' && (
          <div style={{ marginTop: '8px' }}>
            <OneClickExportModal
              projectTitle={projectTitle}
              htmlContent={htmlContent}
              onClose={onClose}
              githubAuthenticated={githubAuthenticated}
              githubUsername={githubUsername}
            />
          </div>
        )}

        {/* Tab 2: Cloud Deploy */}
        {tab === 'cloud' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '8px' }}>
            <div className="oce-sub">
              Automatický build a nasadenie cez webhook (Vercel Deploy Hook alebo Netlify Build Hook).
            </div>

            <label className="oce-label">
              Poskytovateľ
              <div className="oce-toggle-row">
                <button
                  className={`oce-toggle${provider === 'vercel' ? ' active' : ''}`}
                  onClick={() => setProvider('vercel')}
                >
                  ▲ Vercel
                </button>
                <button
                  className={`oce-toggle${provider === 'netlify' ? ' active' : ''}`}
                  onClick={() => setProvider('netlify')}
                >
                  ◆ Netlify
                </button>
              </div>
            </label>

            <label className="oce-label">
              Webhook URL
              <input
                className="oce-input"
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder={
                  provider === 'vercel'
                    ? 'https://api.vercel.com/v1/integrations/deploy/prj_.../...'
                    : 'https://api.netlify.com/build_hooks/...'
                }
              />
            </label>

            {/* Status indicator: Queued -> Building -> Ready */}
            {deployStatus !== 'idle' && (
              <div className="oce-progress">
                <div className="oce-steps">
                  <div className={`oce-step${deployStatus === 'queued' ? ' active' : deployStatus === 'building' || deployStatus === 'ready' ? ' done' : ''}`}>
                    <span className="oce-step-dot">{deployStatus === 'queued' ? '…' : deployStatus === 'building' || deployStatus === 'ready' ? '✓' : '○'}</span>
                    <span className="oce-step-label">Queued (Čaká v poradí)</span>
                  </div>
                  <div className={`oce-step${deployStatus === 'building' ? ' active' : deployStatus === 'ready' ? ' done' : ''}`}>
                    <span className="oce-step-dot">{deployStatus === 'building' ? '…' : deployStatus === 'ready' ? '✓' : '○'}</span>
                    <span className="oce-step-label">Building (Kompilácia v cloude)</span>
                  </div>
                  <div className={`oce-step${deployStatus === 'ready' ? ' done' : ''}`}>
                    <span className="oce-step-dot">{deployStatus === 'ready' ? '✓' : '○'}</span>
                    <span className="oce-step-label">Ready (Nasadené na produkcii)</span>
                  </div>
                </div>
              </div>
            )}

            {deployStatus === 'error' && errorMessage && (
              <div className="oce-error-box">❌ Chyba deployu: {errorMessage}</div>
            )}

            {deployStatus === 'ready' && deployResult && (
              <div className="oce-success" style={{ padding: '8px 0' }}>
                <div className="oce-success-icon" style={{ fontSize: '24px' }}>🎉</div>
                <div className="oce-success-title" style={{ fontSize: '15px' }}>Build bol úspešne spustený!</div>
                {deployResult.statusUrl && (
                  <a
                    href={deployResult.statusUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="oce-btn primary"
                    style={{ textDecoration: 'none' }}
                  >
                    Otvoriť Cloud Dashboard ↗
                  </a>
                )}
              </div>
            )}

            <button
              className="oce-btn primary full"
              disabled={!webhookUrl || deployStatus === 'queued' || deployStatus === 'building'}
              onClick={handleTriggerDeploy}
            >
              {deployStatus === 'queued' || deployStatus === 'building'
                ? '⏳ Spúšťam build…'
                : '🚀 Spustiť Cloud Deploy'}
            </button>
          </div>
        )}

        {/* Tab 3: ZIP Archív */}
        {tab === 'zip' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '8px' }}>
            <div className="oce-sub">
              Stiahni si kompletný projekt ako ZIP archív pripravený na lokálny vývoj alebo manuálny hosting.
            </div>
            <button
              className="oce-btn primary full"
              onClick={() => {
                onDownloadZip?.();
                onClose();
              }}
            >
              📦 Stiahnuť ZIP archív
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
