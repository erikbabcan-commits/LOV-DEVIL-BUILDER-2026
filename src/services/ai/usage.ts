export const AI_QUOTA_CHANGED = 'forge:quota-changed';
/** Refresh from the authenticated server; event data never grants an identity or quota. */
export function notifyAiQuotaChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AI_QUOTA_CHANGED));
}
