export interface Frame {
  file: string;
  /** Epoch milliseconds. */
  t: number;
}

export interface Timeline {
  start: number;
  end: number;
  /** Real-time intervals left out of the clip. */
  cuts: Array<[number, number]>;
}

/**
 * One frame file per output frame at `fps`. Output time runs from `start` to `end` with the cut intervals skipped; each
 * output frame shows the latest captured frame at or before that real time, or the first frame before there is one.
 */
export function framesAt(frames: Frame[], tl: Timeline, fps: number): string[] {
  if (frames.length === 0 || tl.end <= tl.start) return [];
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  const cuts = tl.cuts
    .map(([a, b]) => [Math.max(a, tl.start), Math.min(b, tl.end)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const step = 1000 / fps;
  const out: string[] = [];
  let i = 0;
  for (let t = tl.start; t < tl.end - 1e-9; t += step) {
    const cut = cuts.find(([a, b]) => t >= a && t < b);
    if (cut) {
      t = cut[1] - step; // the next tick lands on the cut's end
      continue;
    }
    while (i + 1 < sorted.length && sorted[i + 1].t <= t) i++;
    out.push(sorted[i].file);
  }
  return out;
}
