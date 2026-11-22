/**
 * OneClickExportModal – 1-Click GitHub provisioner + Vercel/Netlify deploy hook
 * Features:
 *  - Repo name input (auto-prefilled: lov-project-{slug})
 *  - Public / Private toggle
 *  - Optional Vercel or Netlify webhook URL
 *  - Status indicator: Idle → Creating → Committing → Deploying → Done / Error
 *  - Post-success: "Open on GitHub ↗" + "Copy clone URL" buttons
 */

import { useState, useCallback } from 'react';
import { apiUrl } from '../../lib/api';
import { checkGitHubAuth } from '../../services/export/githubExport';

// ─── Types ────────────────────────────────────────────────────────────────────

type DeployProvider = 'vercel' | 'netlify';
type ExportStep = 'idle' | 'creating' | 'committing' | 'deploying' | 'done' | 'error';

interface ExportResult {
  repoUrl: string;
  cloneUrl: string;
  repoFullName: string;
  commitSha: string;
  filesUploaded: number;
  deployJobId?: string | null;
  deployStatusUrl?: string | null;
  deployProvider?: DeployProvider;
}

interface OneClickExportModalProps {
  /** Current project title — used to generate default repo name */
  projectTitle: string;
  /** Current project HTML (optional — packed into public/preview.html) */
  htmlContent?: string | null;
  /** Called when user wants to close the modal */
  onClose: () => void;
  /** Whether the user is currently GitHub-authenticated */
  githubAuthenticated: boolean;
  /** GitHub username, shown in heading */
  githubUsername?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(title: string): string {
  return (
    'lov-project-' +
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70) || 'untitled'
  );
}

function detectProvider(url: string): DeployProvider | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('vercel')) return 'vercel';
    if (u.hostname.includes('netlify')) return 'netlify';
  } catch {
    // ignore
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OneClickExportModal({
  projectTitle,
  htmlContent,
  onClose,
  githubAuthenticated,
  githubUsername,
}: OneClickExportModalProps) {
  const [repoName, setRepoName] = useState(() => slugify(projectTitle));
  const [isPrivate, setIsPrivate] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [step, setStep] = useState<ExportStep>('idle');
  const [result, setResult] = useState<ExportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const repoNameValid =
    repoName.length >= 1 &&
    repoName.length <= 100 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(repoName);

  const webhookProvider = webhookUrl ? detectProvider(webhookUrl) : null;
  const webhookValid = !webhookUrl || webhookProvider !== null;

  const handleExport = useCallback(async () => {
    if (!repoNameValid || !webhookValid || step !== 'idle') return;

    // Public repo confirmation
    if (!isPrivate) {
      const ok = window.confirm(
        `Vytvorí sa VEREJNÝ repozitár "${repoName}" viditeľný pre všetkých.\n\nPokračovať?`
      );
      if (!ok) return;
    }

    setStep('creating');
    setErrorMsg(null);

    try {
      // 1. Get fresh CSRF token
      const auth = await checkGitHubAuth();
      if (!auth.authenticated || !auth.csrfToken) {
        setErrorMsg('GitHub nie je pripojený. Pripoj GitHub a skús znovu.');
        setStep('error');
        return;
      }

      // 2. Provision repository
      const provisionRes = await fetch(apiUrl('/api/github/provision'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
        body: JSON.stringify({
          repoName,
          isPrivate,
          description: `Exported from LOV-DEVIL Builder – https://lov.vorkei.com`,
          appTitle: projectTitle,
          htmlContent: htmlContent ?? '',
        }),
      });

      setStep('committing');

      const provisionData = (await provisionRes.json()) as Record<string, unknown>;
      if (!provisionRes.ok || !provisionData.ok) {
        setErrorMsg(String(provisionData.error ?? 'Nepodarilo sa vytvoriť repozitár'));
        setStep('error');
        return;
      }

      const exportResult: ExportResult = {
        repoUrl: String(provisionData.repoUrl),
        cloneUrl: String(provisionData.cloneUrl),
        repoFullName: String(provisionData.repoFullName),
        commitSha: String(provisionData.commitSha),
        filesUploaded: Number(provisionData.filesUploaded),
      };

      // 3. Trigger deploy hook (optional)
      if (webhookUrl && webhookProvider) {
        setStep('deploying');
        const deployRes = await fetch(apiUrl('/api/github/deploy-hook'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
          body: JSON.stringify({
            webhookUrl,
            provider: webhookProvider,
            repoFullName: exportResult.repoFullName,
          }),
        });

        if (deployRes.ok) {
          const deployData = (await deployRes.json()) as Record<string, unknown>;
          exportResult.deployJobId = typeof deployData.jobId === 'string' ? deployData.jobId : null;
          exportResult.deployStatusUrl =
            typeof deployData.statusUrl === 'string' ? deployData.statusUrl : null;
          exportResult.deployProvider = webhookProvider;
        }
      }

      setResult(exportResult);
      setStep('done');
    } catch (err) {
      setErrorMsg('Sieťová chyba: ' + String(err));
      setStep('error');
    }
  }, [repoName, isPrivate, webhookUrl, webhookValid, repoNameValid, step, projectTitle, htmlContent, webhookProvider]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.cloneUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [result]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="one-click-export-overlay" role="dialog" aria-modal="true" aria-label="Export na GitHub">
      <div className="one-click-export-modal">
        {/* Header */}
        <div className="oce-header">
          <span className="oce-logo">🐙</span>
          <div>
            <div className="oce-title">1-Click GitHub Export</div>
            {githubUsername && (
              <div className="oce-sub">Prihlásený ako <strong>{githubUsername}</strong></div>
            )}
          </div>
          <button className="oce-close" onClick={onClose} aria-label="Zavrieť">✕</button>
        </div>

        {/* Body */}
        {step === 'done' && result ? (
          <div className="oce-success">
            <div className="oce-success-icon">✅</div>
            <div className="oce-success-title">Repozitár vytvorený!</div>
            <div className="oce-success-meta">
              <span>📦 {result.filesUploaded} súborov</span>
              <span>🔀 {result.commitSha.slice(0, 7)}</span>
              {result.deployProvider && (
                <span>🚀 {result.deployProvider === 'vercel' ? 'Vercel' : 'Netlify'} deploy spustený</span>
              )}
            </div>
            <div className="oce-btn-row">
              <a
                href={result.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="oce-btn primary"
              >
                Otvoriť na GitHube ↗
              </a>
              <button className="oce-btn secondary" onClick={() => void handleCopy()}>
                {copied ? '✓ Skopírované!' : '📋 Kopírovať clone URL'}
              </button>
            </div>
            {result.deployStatusUrl && (
              <a
                href={result.deployStatusUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="oce-deploy-link"
              >
                Zobraziť deploy status ↗
              </a>
            )}
          </div>
        ) : (
          <>
            {/* Repo name */}
            <label className="oce-label">
              Názov repozitára
              <input
                className={`oce-input${!repoNameValid && repoName ? ' oce-input-err' : ''}`}
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                disabled={step !== 'idle'}
                placeholder="lov-project-moja-aplikacia"
                maxLength={100}
                spellCheck={false}
              />
              {!repoNameValid && repoName && (
                <span className="oce-err-hint">
                  Len a-z, 0-9, bodka, pomlčka. Nesmie začínať/končiť špeciálnym znakom.
                </span>
              )}
            </label>

            {/* Visibility */}
            <div className="oce-label">
              Viditeľnosť
              <div className="oce-toggle-row">
                <button
                  className={`oce-toggle${!isPrivate ? ' active' : ''}`}
                  onClick={() => setIsPrivate(false)}
                  disabled={step !== 'idle'}
                >
                  🌍 Verejný
                </button>
                <button
                  className={`oce-toggle${isPrivate ? ' active' : ''}`}
                  onClick={() => setIsPrivate(true)}
                  disabled={step !== 'idle'}
                >
                  🔒 Súkromný
                </button>
              </div>
              {!isPrivate && (
                <span className="oce-warn-hint">⚠️ Kód bude viditeľný pre všetkých</span>
              )}
            </div>

            {/* Deploy hook (optional) */}
            <label className="oce-label">
              Deploy Hook URL <span className="oce-optional">(voliteľné)</span>
              <input
                className={`oce-input${webhookUrl && !webhookValid ? ' oce-input-err' : ''}`}
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                disabled={step !== 'idle'}
                placeholder="https://api.vercel.com/v1/integrations/deploy/… alebo netlify"
                type="url"
              />
              {webhookUrl && webhookProvider && (
                <span className="oce-ok-hint">
                  {webhookProvider === 'vercel' ? '▲ Vercel' : '◆ Netlify'} webhook detekovaný
                </span>
              )}
              {webhookUrl && !webhookProvider && (
                <span className="oce-err-hint">Zadaj Vercel alebo Netlify webhook URL</span>
              )}
            </label>

            {/* Status / Progress */}
            {step !== 'idle' && step !== 'error' && (
              <div className="oce-progress">
                <StepIndicator current={step} />
              </div>
            )}

            {step === 'error' && errorMsg && (
              <div className="oce-error-box">❌ {errorMsg}</div>
            )}

            {/* Action */}
            {!githubAuthenticated ? (
              <div className="oce-error-box">
                🔗 Najprv sa pripoj k GitHub cez panel "Connect GitHub".
              </div>
            ) : (
              <button
                className="oce-btn primary full"
                disabled={!repoNameValid || !webhookValid || step !== 'idle' && step !== 'error'}
                onClick={() => {
                  if (step === 'error') setStep('idle');
                  else void handleExport();
                }}
              >
                {step === 'idle' ? '🚀 Exportovať na GitHub' : step === 'error' ? '🔄 Skúsiť znovu' : '⏳ Spracováva sa…'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Step indicator ───────────────────────────────────────────────────────────

const STEPS: Array<{ key: ExportStep; label: string }> = [
  { key: 'creating', label: 'Vytváranie repozitára' },
  { key: 'committing', label: 'Nahrávanie súborov' },
  { key: 'deploying', label: 'Spúšťanie deploy' },
];

function StepIndicator({ current }: { current: ExportStep }) {
  return (
    <div className="oce-steps">
      {STEPS.map(({ key, label }) => {
        const stepOrder: ExportStep[] = ['creating', 'committing', 'deploying', 'done'];
        const currentIdx = stepOrder.indexOf(current);
        const stepIdx = stepOrder.indexOf(key);
        const done = currentIdx > stepIdx;
        const active = currentIdx === stepIdx;
        return (
          <div key={key} className={`oce-step${active ? ' active' : done ? ' done' : ''}`}>
            <span className="oce-step-dot">{done ? '✓' : active ? '…' : '○'}</span>
            <span className="oce-step-label">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
