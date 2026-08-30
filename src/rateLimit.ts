export type FailureLimiter = {
  isLimited(key: string): boolean;
  recordFailure(key: string): void;
  clear(key: string): void;
};

export function createFailureLimiter(options: { max: number; windowMs: number }): FailureLimiter {
  const hits = new Map<string, number[]>();

  function prune(now: number, timestamps: number[]): number[] {
    return timestamps.filter((time) => now - time < options.windowMs);
  }

  return {
    isLimited(key: string): boolean {
      const now = Date.now();
      const kept = prune(now, hits.get(key) ?? []);
      hits.set(key, kept);
      return kept.length >= options.max;
    },
    recordFailure(key: string): void {
      const now = Date.now();
      const kept = prune(now, hits.get(key) ?? []);
      kept.push(now);
      hits.set(key, kept);
    },
    clear(key: string): void {
      hits.delete(key);
    },
  };
}
