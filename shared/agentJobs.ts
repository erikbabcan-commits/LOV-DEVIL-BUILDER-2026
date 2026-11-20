/*
 * ============================================================================
 * FROZEN CONTRACT – zmena len cez BOSS
 * ----------------------------------------------------------------------------
 * Durable agent jobs API, shared by the Hono backend and the frontend.
 * Frozen in LOV-DEVIL step 0 (2026-11-20) on top of PR #77 (8d1989a).
 * Consumers: Agent 1 (server/agent/jobs.ts, worker), Agent 2 (job client),
 * Agent 9 (autofix), Agent 10 (E2E).
 *
 * Rules:
 *  - Section A is what PR #77 already implements. Do NOT change its shapes.
 *  - Section B is the reserved, not-yet-implemented extension that Agent 1
 *    implements (POST /api/agent/jobs, tokens, result patch, error payload).
 *    Field names and types are fixed; only BOSS may change them.
 *  - Additive changes go through BOSS; renames/removals are breaking.
 *
 * Naming map (MASTER ASSIGNMENT -> this contract):
 *  status -> state, user_id -> owner_id (DB) / not exposed in view,
 *  idempotency_key -> `Idempotency-Key` request header (DB column idempotency_key),
 *  error_payload -> error (A, string) + errorPayload (B, structured),
 *  result_patch -> resultPatch (B), tokens_used -> tokensUsed (B).
 * ============================================================================
 */
import { z } from 'zod';
import { AgentEventSchema, GeneratedFileSchema, GenerateRequestSchema } from '../server/agent/schemas';

/* ---------------- A. Implemented by PR #77 (unchanged) ---------------- */

export const AgentJobId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const AgentJobState = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const MAX_JOB_EVENTS = 2000;
/** Response of GET /api/agent/jobs/:id and POST /api/agent/jobs/:id/cancel. */
export const AgentJobViewSchema = z.object({
  id: AgentJobId,
  state: AgentJobState,
  events: z.array(AgentEventSchema).max(MAX_JOB_EVENTS),
  error: z.string().max(4000).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
/** Response of GET /api/agent/jobs (newest first, max 50). */
export const AgentJobListSchema = z.object({ jobs: z.array(AgentJobViewSchema).max(50) }).strict();
/** 200 response of POST /api/agent/generate when the Idempotency-Key was already used (header `Idempotent-Replay: true`). */
export const AgentJobReplaySchema = z.object({ job: AgentJobViewSchema, replayed: z.literal(true) }).strict();
export type AgentJobState = z.infer<typeof AgentJobState>;
export type AgentJobView = z.infer<typeof AgentJobViewSchema>;

/** Header carrying the idempotency key (POST /api/agent/generate today, POST /api/agent/jobs in B). */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** Terminal states: a job in one of these never changes again. */
export const TERMINAL_JOB_STATES = ['succeeded', 'failed', 'cancelled'] as const satisfies readonly AgentJobState[];
/** Error codes the jobs API returns today (JSON body `{ error: code }`). */
export const AgentJobErrorCode = z.enum([
  'unauthenticated',        // 401
  'rate_limit',             // 429
  'invalid_job_id',         // 400
  'job_not_found',          // 404 (foreign ids look identical to missing ones)
  'job_not_cancellable',    // 409 (job already terminal)
  'invalid_idempotency_key',// 400 (malformed Idempotency-Key header)
]);
export type AgentJobErrorCode = z.infer<typeof AgentJobErrorCode>;

/* ---------------- B. Reserved for Agent 1 (NOT implemented yet) ----------------
 * POST /api/agent/jobs
 *   headers: Idempotency-Key (required, IdempotencyKey), CSRF as other POSTs
 *   body:    AgentJobCreateRequestSchema (same body as POST /api/agent/generate)
 *   202:     AgentJobCreatedSchema  (new job enqueued, state 'queued')
 *   200:     AgentJobReplaySchema   (same key already used; header Idempotent-Replay: true)
 *   errors:  AgentJobErrorCode + existing generate/quota codes (bad_request,
 *            secret_in_context, ai_not_configured, quota codes) – unchanged semantics.
 * GET  /api/agent/jobs/:id         -> AgentJobViewSchema (A), later AgentJobDetailSchema (B)
 * POST /api/agent/jobs/:id/cancel  -> AgentJobViewSchema (A), later AgentJobDetailSchema (B)
 * Quota: consumed exactly once, when the job reaches 'succeeded' (ledger, migration 024).
 */
export const AgentJobCreateRequestSchema = GenerateRequestSchema;
export const AgentJobCreatedSchema = z.object({ job: AgentJobViewSchema, replayed: z.literal(false) }).strict();
/** Structured failure detail (no secrets; server must pass it through redactSecrets). */
export const AgentJobErrorPayloadSchema = z.object({
  code: z.string().max(64),
  message: z.string().max(4000),
  retriable: z.boolean(),
}).strict();
/** Files proposed by a succeeded job = payload of its terminal 'stage' event
 *  (same shape as AgentEvent type 'stage'); still subject to client review/approval. */
export const AgentJobResultPatchSchema = z.object({
  files: z.array(GeneratedFileSchema).max(40),
  editMode: z.literal('patch').optional(),
  summary: z.string().max(600).optional(),
}).strict();
/** View extension Agent 1 adds; Agent 2 must accept both A and B shapes. */
export const AgentJobDetailSchema = AgentJobViewSchema.extend({
  tokensUsed: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).strict().nullable(),
  resultPatch: AgentJobResultPatchSchema.nullable(),
  errorPayload: AgentJobErrorPayloadSchema.nullable(),
}).strict();
export type AgentJobCreateRequest = z.infer<typeof AgentJobCreateRequestSchema>;
export type AgentJobCreated = z.infer<typeof AgentJobCreatedSchema>;
export type AgentJobErrorPayload = z.infer<typeof AgentJobErrorPayloadSchema>;
export type AgentJobResultPatch = z.infer<typeof AgentJobResultPatchSchema>;
export type AgentJobDetail = z.infer<typeof AgentJobDetailSchema>;
