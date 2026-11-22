import { useState } from 'react';
import { useStore } from '../stores/useAppStore';
import { QRCodeSvg } from './QRCodeSvg';

export function ShareModal() {
  const shareModalOpen = useStore(s => s.shareModalOpen);
  const lastShareUrl = useStore(s => s.lastShareUrl);
  const setShareModalOpen = useStore(s => s.setShareModalOpen);
  const toast = useStore(s => s.toast);

  const [copied, setCopied] = useState(false);

  if (!shareModalOpen || !lastShareUrl) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(lastShareUrl);
      setCopied(true);
      toast('Link skopírovaný do schránky! 🚀', 'ok');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Nepodarilo sa skopírovať do schránky', 'err');
    }
  };

  return (
    <div
      className="share-modal-backdrop"
      id="shareModalBackdrop"
      onClick={e => {
        if (e.target === e.currentTarget) setShareModalOpen(false);
      }}
    >
      <div className="share-modal-card" id="shareModalCard" role="dialog" aria-modal="true" aria-labelledby="shareModalTitle">
        <div className="sm-header">
          <div className="sm-title-box">
            <span className="sm-icon">🔗</span>
            <div>
              <h3 id="shareModalTitle">1-Click Instant Shareable Link</h3>
              <p className="sm-subtitle">Verejný náhľad pre klientov bez nutnosti prihlasovania.</p>
            </div>
          </div>
          <button
            type="button"
            className="sm-close-btn"
            id="closeShareModalBtn"
            onClick={() => setShareModalOpen(false)}
            aria-label="Zavrieť"
          >
            ✕
          </button>
        </div>

        <div className="sm-badge-row">
          <span className="sm-badge-pill">
            <span className="sm-pulse" /> Live & Public
          </span>
          <span className="sm-badge-info">Nevyžaduje účet ani heslo</span>
        </div>

        <div className="sm-url-box">
          <input
            type="text"
            className="sm-url-input"
            id="shareUrlInput"
            value={lastShareUrl}
            readOnly
            onClick={e => (e.target as HTMLInputElement).select()}
          />
          <button
            type="button"
            className={`sm-copy-btn ${copied ? 'copied' : ''}`}
            id="copyShareUrlBtn"
            onClick={() => void handleCopy()}
          >
            {copied ? '✓ Skopírované' : 'Kopírovať'}
          </button>
        </div>

        <div className="sm-qr-section">
          <div className="sm-qr-wrapper">
            <QRCodeSvg value={lastShareUrl} size={150} />
          </div>
          <div className="sm-qr-hint">
            <strong>Okamžitý náhľad na mobile</strong>
            <p>Namier fotoaparát mobilu (iPhone / Android) na tento QR kód a otestuj rozhranie priamo vo vrecku.</p>
            <a
              href={lastShareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="sm-open-link"
              id="openShareUrlLink"
            >
              Otvoriť v novom okne ↗
            </a>
          </div>
        </div>

        <div className="sm-footer">
          <span className="sm-footer-brand">
            ⚡ Powered by <strong>VORKEI Cloud Engine</strong>
          </span>
          <button
            type="button"
            className="btn-ghost sm-done-btn"
            onClick={() => setShareModalOpen(false)}
          >
            Hotovo
          </button>
        </div>
      </div>
    </div>
  );
}
