export type FailureLimiter = {
  isLimited(key: string): boolean;
  recordFailure(key: string): void;
  clear(key: string): void;
};

const DEFAULT_MAX_ENTRIES = 4096;

export function createFailureLimiter(options: {
  max: number;
  windowMs: number;
  maxEntries?: number;
}): FailureLimiter {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const hits = new Map<string, number[]>();

  function prune(now: number, timestamps: number[]): number[] {
    return timestamps.filter((time) => now - time < options.windowMs);
  }

  function sweepExpired(now: number): void {
    for (const [key, timestamps] of hits) {
      const kept = prune(now, timestamps);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }

  function evictOldest(): void {
    while (hits.size > maxEntries) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) return;
      hits.delete(oldest);
    }
  }

  function remember(key: string, timestamps: number[]): void {
    if (timestamps.length === 0) {
      hits.delete(key);
      return;
    }
    hits.set(key, timestamps);
    if (hits.size > maxEntries) {
      sweepExpired(Date.now());
      evictOldest();
    }
  }

  const sweepMs = Math.min(options.windowMs, 60_000);
  const sweep = setInterval(() => {
    sweepExpired(Date.now());
  }, sweepMs);
  sweep.unref();

  return {
    isLimited(key: string): boolean {
      const now = Date.now();
      const kept = prune(now, hits.get(key) ?? []);
      remember(key, kept);
      return kept.length >= options.max;
    },
    recordFailure(key: string): void {
      const now = Date.now();
      const kept = prune(now, hits.get(key) ?? []);
      kept.push(now);
      remember(key, kept);
    },
    clear(key: string): void {
      hits.delete(key);
    },
  };
}
