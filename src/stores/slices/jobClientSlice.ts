import type { StateCreator } from 'zustand';
import type { AppState } from '../useAppStore';
import { AgentJobError, cancelAgentJob } from '../../services/ai/jobs';
import { answerFromEvents, loadJobResume, resumeJobEvents, runAgentJob, type JobTransport } from '../../services/ai/jobClient';
import { deleteJobCache } from '../../services/persistence/db';

/* Agent 2 slice (docs/plans/MOUNT-SEAMS.md): transport state of the active durable job. */
export interface JobClientSlice {
  jobTransport: JobTransport;
  activeJobId: string | null;
  /** Neutral, non-error feedback for the job status UI (e.g. job already finished). */
  jobNotice: string | null;
  jobCancelling: boolean;
  setJobTransport: (transport: JobTransport, jobId?: string | null) => void;
  /** POST /api/agent/jobs/:id/cancel for the active job; 409 job_not_cancellable is neutral. */
  cancelActiveJob: () => Promise<void>;
}

export const JOB_NOT_CANCELLABLE_NOTICE = 'Beh už skončil, nie je čo zrušiť.';
export const JOB_CANCEL_REQUESTED_NOTICE = 'Rušenie behu bolo odoslané.';

type Creator = StateCreator<AppState, [], [], JobClientSlice>;
export const createJobClientSlice = (set: Parameters<Creator>[0], get: Parameters<Creator>[1]): JobClientSlice => ({
  jobTransport: 'idle',
  activeJobId: null,
  jobNotice: null,
  jobCancelling: false,
  setJobTransport: (transport, jobId) => set(state => ({
    jobTransport: transport,
    activeJobId: transport === 'idle' ? null : jobId === undefined ? state.activeJobId : jobId,
    ...(transport === 'streaming' || transport === 'background' ? { jobNotice: null } : {}),
  })),
  cancelActiveJob: async () => {
    const id = get().activeJobId;
    if (!id || get().jobCancelling) return;
    set({ jobCancelling: true, jobNotice: null });
    try {
      const job = await cancelAgentJob(id);
      set({ jobNotice: JOB_CANCEL_REQUESTED_NOTICE });
      // No live client follows a failed transport: settle the state here.
      if (get().jobTransport === 'failed' && job.state !== 'queued' && job.state !== 'running') {
        set({ jobTransport: 'idle', activeJobId: null });
        void deleteJobCache(id).catch(() => {});
      }
    } catch (error) {
      if (error instanceof AgentJobError && error.code === 'job_not_cancellable') {
        set({ jobNotice: JOB_NOT_CANCELLABLE_NOTICE });
        if (get().jobTransport === 'failed') set({ jobTransport: 'idle', activeJobId: null });
      } else {
        get().toast('Beh sa nepodarilo zrušiť. Skús to znova.', 'warn');
      }
    } finally {
      set({ jobCancelling: false });
    }
  },
});

/** The only entry points `useAppStore.generateWithAi` / `resumeAgentJob` call. */
export const jobClient = { runAgentJob, resumeJobEvents, loadJobResume, answerFromEvents };
