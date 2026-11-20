import { z } from 'zod';
import { AgentEventSchema } from '../server/agent/schemas';

/** Durable agent job contracts shared by the Hono backend and the frontend. */
export const AgentJobId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const AgentJobState = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const MAX_JOB_EVENTS = 2000;
export const AgentJobViewSchema = z.object({
  id: AgentJobId,
  state: AgentJobState,
  events: z.array(AgentEventSchema).max(MAX_JOB_EVENTS),
  error: z.string().max(4000).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export const AgentJobListSchema = z.object({ jobs: z.array(AgentJobViewSchema).max(50) }).strict();
export const AgentJobReplaySchema = z.object({ job: AgentJobViewSchema, replayed: z.literal(true) }).strict();
export type AgentJobState = z.infer<typeof AgentJobState>;
export type AgentJobView = z.infer<typeof AgentJobViewSchema>;
