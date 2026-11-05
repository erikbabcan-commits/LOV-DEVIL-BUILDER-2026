/* WS-1 per-user rate limiter: Redis (INCR + EXPIRE) s in-memory fallbackom.
   Async rozhranie — agent/autofix ho awaitujú; memory varianta odpovedá okamžite. */

export interface AsyncRateLimiter {
  (key: string): Promise<boolean>;
}

export function makeInMemoryRateLimiter(maxPerMin: number): AsyncRateLimiter {
  const hits = new Map<string, number[]>();
  return async (key: string): Promise<boolean> => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter(t => now - t < 60_000);
    if (list.length >= maxPerMin) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}

interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export function makeRedisRateLimiter(redis: RedisLike, maxPerMin: number): AsyncRateLimiter {
  return async (key: string): Promise<boolean> => {
    const full = `rl:${Math.floor(Date.now() / 60_000)}:${key}`;
    try {
      const count = await redis.incr(full);
      if (count === 1) await redis.expire(full, 90);
      return count <= maxPerMin;
    } catch {
      return true; /* fail-open — dostupnosť > strict limit; kvóty sú v Postgres */
    }
  };
}

/** Lazy ioredis loader — vracia null keď modul/URL chýba (fallback memory). */
export async function loadRedis(redisUrl: string | undefined): Promise<RedisLike | null> {
  if (!redisUrl) return null;
  try {
    const modName = 'ioredis';
    const mod = (await import(/* @vite-ignore */ modName)) as unknown as { default: new (url: string, opts?: unknown) => RedisLike };
    return new mod.default(redisUrl, { maxRetriesPerRequest: 1 });
  } catch {
    return null;
  }
}
