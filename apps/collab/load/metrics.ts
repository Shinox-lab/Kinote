/** Nearest-rank percentile of `samples` (0 when there are none). */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!;
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const MAX_SAMPLES = 10_000;

/** A rolling window of latency samples, so a long soak does not grow memory without bound. */
export class LatencyMeter {
  private samples: number[] = [];
  private cursor = 0;

  add(ms: number): void {
    if (this.samples.length < MAX_SAMPLES) {
      this.samples.push(ms);
      return;
    }
    this.samples[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % MAX_SAMPLES;
  }

  stats(): LatencyStats {
    return {
      count: this.samples.length,
      p50: percentile(this.samples, 0.5),
      p95: percentile(this.samples, 0.95),
      p99: percentile(this.samples, 0.99),
      max: this.samples.reduce((max, value) => Math.max(max, value), 0),
    };
  }
}
