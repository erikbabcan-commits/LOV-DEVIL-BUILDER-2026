import React, { useEffect, useState } from 'react';
import { useStore } from '../../stores/useAppStore';

export function LiveGenerationInspector() {
  const generating = useStore(s => s.generating);
  const activeGeneratingFile = useStore(s => s.activeGeneratingFile);
  const cancelAiRun = useStore(s => s.cancelAiRun);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!generating) {
      setElapsedMs(0);
      return;
    }
    const start = performance.now();
    const interval = window.setInterval(() => {
      setElapsedMs(Math.round(performance.now() - start));
    }, 100);
    return () => clearInterval(interval);
  }, [generating]);

  if (!generating) return null;

  const seconds = (elapsedMs / 1000).toFixed(1);
  const minutes = Math.floor(elapsedMs / 60000);
  const formattedSec = (elapsedMs % 60000 / 1000).toFixed(1).padStart(4, '0');
  const timerStr = `${String(minutes).padStart(2, '0')}:${formattedSec}s`;
  
  // Calculate simulated or dynamic streaming rate based on activity
  const estimatedTokens = Math.min(1800, Math.floor(elapsedMs * 0.052));
  const rateStr = elapsedMs > 500 ? '52 tok/s' : 'inicializácia…';

  const fileName = activeGeneratingFile
    ? activeGeneratingFile.replace(/^.*[\\/]/, '')
    : 'React Component';

  return (
    <div className="live-inspector-card" role="status" aria-live="polite">
      <div className="live-inspector-sweep-border" aria-hidden="true" />
      <div className="live-inspector-inner">
        <div className="live-inspector-header">
          <div className="live-inspector-title">
            <span className="live-beacon-dot" />
            <span className="live-inspector-spark">⚡</span>
            <span className="live-component-name" title={activeGeneratingFile || 'Generovanie'}>
              Synthesizing: <strong>{fileName}</strong>
            </span>
          </div>

          <div className="live-inspector-telemetry">
            <span className="live-telemetry-pill live-timer font-mono">{timerStr}</span>
            <span className="live-telemetry-pill live-rate font-mono hide-xs">{rateStr}</span>
            <button
              type="button"
              className="live-cancel-btn"
              onClick={cancelAiRun}
              title="Zrušiť generovanie"
              aria-label="Zrušiť generovanie"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 3-krokový pipeline status */}
        <div className="live-pipeline-row">
          <div className="pipeline-step step-done">
            <span className="step-num">1</span>
            <span className="step-txt">AST Map</span>
            <span className="step-check">✓</span>
          </div>
          <span className="pipeline-arrow">➔</span>
          <div className="pipeline-step step-active">
            <span className="step-num pulse">2</span>
            <span className="step-txt">Code Synthesis</span>
            <span className="step-wave" />
          </div>
          <span className="pipeline-arrow">➔</span>
          <div className="pipeline-step step-pending">
            <span className="step-num">3</span>
            <span className="step-txt">Type Validation</span>
          </div>
        </div>
      </div>
    </div>
  );
}
