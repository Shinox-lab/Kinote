import { describe, expect, it } from 'vitest';
import { framesAt } from './timeline';

// Times are epoch milliseconds and fps is frames per second: 2 s at 10 fps is 20 frames.
const frames = [{ file: 'a', t: 0 }, { file: 'b', t: 1000 }];
describe('framesAt', () => {
  it('samples the latest frame at each tick', () => {
    expect(framesAt(frames, { start: 0, end: 2000, cuts: [] }, 10)).toEqual([...Array(10).fill('a'), ...Array(10).fill('b')]);
  });
  it('skips cut time', () => {
    expect(framesAt(frames, { start: 0, end: 2000, cuts: [[500, 1500]] }, 10)).toEqual([...Array(5).fill('a'), ...Array(5).fill('b')]);
  });
  it('uses the first frame before any frame exists', () => {
    expect(framesAt([{ file: 'x', t: 5000 }], { start: 0, end: 1000, cuts: [] }, 10)).toEqual(Array(10).fill('x'));
  });
  it('is empty when end is not after start', () => expect(framesAt(frames, { start: 1000, end: 1000, cuts: [] }, 10)).toEqual([]));
});
