import { containsPotentialSecret } from '../security/secrets';
export interface TokenUsage { promptTokens: number; completionTokens: number }
export function safeModel(value: unknown): string | null {
  return typeof value === 'string' && !containsPotentialSecret(value) && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) ? value : null;
}
export function validUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['promptTokens', 'completionTokens'].every(k => typeof v[k] === 'number' && Number.isSafeInteger(v[k]) && (v[k] as number) >= 0 && (v[k] as number) <= 1_000_000_000);
}
