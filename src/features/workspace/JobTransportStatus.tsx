import { useStore } from '../../stores/useAppStore';

export const JOB_TRANSPORT_TEXT = {
  reconnecting: 'Obnovujem prerušené spojenie...',
  background: 'Pokračujem v generovaní na pozadí',
  failed: 'Spojenie s behom sa nepodarilo obnoviť. Výsledok sa načíta po obnovení stránky.',
} as const;

/** Agent 2: live status of the durable job transport + server-side cancel. */
export function JobTransportStatus() {
  const transport = useStore(s => s.jobTransport),
    jobId = useStore(s => s.activeJobId),
    notice = useStore(s => s.jobNotice),
    cancelling = useStore(s => s.jobCancelling),
    cancel = useStore(s => s.cancelActiveJob);
  const text = transport === 'reconnecting'
    ? JOB_TRANSPORT_TEXT.reconnecting
    : transport === 'polling' || transport === 'background'
      ? JOB_TRANSPORT_TEXT.background
      : transport === 'failed' ? JOB_TRANSPORT_TEXT.failed : null;
  const canCancel = !!jobId && transport !== 'idle';
  if (!text && !canCancel && !notice) return null;
  return (
    <div className="job-transport-status cp-feedback" role="status" aria-live="polite" data-transport={transport}>
      {text && <span>{text}</span>}
      {notice && <span className="job-transport-notice"> {notice}</span>}
      {canCancel && (
        <button type="button" onClick={() => void cancel()} disabled={cancelling} aria-busy={cancelling}>
          Zrušiť prebiehajúci beh
        </button>
      )}
    </div>
  );
}
