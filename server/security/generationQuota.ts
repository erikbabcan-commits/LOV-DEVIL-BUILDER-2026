import { GenerationQuotaSchema } from '../../shared/generationQuota';
import type { QuotaSnapshot, QuotaStore } from './quotaStore';

export class QuotaAdmissionError extends Error {
  readonly status: 429 | 503;
  constructor(readonly code: 'quota_exceeded' | 'quota_unavailable', readonly quota?: QuotaSnapshot) {
    super(code === 'quota_exceeded' ? 'Vyčerpal si mesačný limit AI generovaní. Lokálna práca a export zostávajú dostupné.' : 'Spotrebu AI sa nepodarilo overiť. Skús to znova o chvíľu.');
    this.status = code === 'quota_exceeded' ? 429 : 503;
  }
}

export async function consumeGenerationQuota(store: QuotaStore, userId: string, consume = () => store.consume(userId)): Promise<QuotaSnapshot> {
  let result: Awaited<ReturnType<QuotaStore['consume']>>;
  try { result = await consume(); } catch { throw new QuotaAdmissionError('quota_unavailable'); }
  const quota = GenerationQuotaSchema.safeParse(result.snapshot);
  if (!quota.success || typeof result.ok !== 'boolean' || (result.ok && quota.data.used < 1)) throw new QuotaAdmissionError('quota_unavailable');
  if (!result.ok) throw new QuotaAdmissionError('quota_exceeded', quota.data);
  return quota.data;
}
