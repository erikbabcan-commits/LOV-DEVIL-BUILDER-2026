/* Zdieľané typy AI agenta (zrkadlia server/agent/schemas.ts — klient neimportuje server kód) */

export interface PlanStep { id: string; title: string; detail?: string }
export interface Plan { summary: string; steps: PlanStep[]; filesPlanned: string[] }
export interface GeneratedFile { path: string; content: string; action: 'create' | 'modify' | 'delete' }
export interface ValidationError { path: string; message: string; code: string }
export interface ValidationResult { ok: boolean; errors: ValidationError[] }

export type AgentEvent =
  | { type: 'run_started'; runId: string; model: string }
  | { type: 'plan'; plan: Plan }
  | { type: 'plan_step'; stepId: string; state: 'running' | 'done' }
  | { type: 'file_started'; path: string; action: GeneratedFile['action'] }
  | { type: 'file_done'; path: string; bytes: number; action: GeneratedFile['action'] }
  | { type: 'text_delta'; delta: string }
  | { type: 'validation'; result: ValidationResult }
  | { type: 'stage'; files: GeneratedFile[] }
  | { type: 'done'; runId: string; summary: string }
  | { type: 'error'; code: string; message: string; retriable: boolean }
  | { type: 'cancelled'; runId: string };
