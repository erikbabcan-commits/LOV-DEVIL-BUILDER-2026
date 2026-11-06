/* Zdieľané typy AI agenta (zrkadlia server/agent/schemas.ts — klient neimportuje server kód) */

export interface PlanStep { id: string; title: string; detail?: string }
export interface Plan { summary: string; steps: PlanStep[]; filesPlanned: string[] }
export interface GeneratedFile { path: string; content: string; action: 'create' | 'modify' | 'delete' }
export interface ValidationError { path: string; message: string; code: string }
export interface ValidationResult { ok: boolean; errors: ValidationError[] }

export type AgentEvent =
  | { type: 'run_started'; runId: string; model: string }
  | { type:'provider_update';reason:'retry'|'fallback';provider:string;model:string;attempt:number;maxAttempts:number;message:string }
  | {type:'context_update';state:'summarizing'|'ready';summarizedTurns:number;summaryCalls:number}
  | {type:'intent_selected';intent:'create'|'iterate'|'fix'|'explain'}
  | { type: 'plan'; plan: Plan }
  | { type: 'plan_step'; stepId: string; state: 'running' | 'done' }
  | { type: 'file_started'; path: string; action: GeneratedFile['action'] }
  | { type: 'file_done'; path: string; bytes: number; action: GeneratedFile['action'] }
  | { type: 'text_delta'; delta: string }
  | { type: 'validation'; result: ValidationResult }
  | { type: 'stage'; files: GeneratedFile[];editMode?:'patch';summary?:string }
  | { type: 'done'; runId: string; summary: string }
  | { type: 'error'; code: string; message: string; retriable: boolean }
  | { type: 'cancelled'; runId: string };
