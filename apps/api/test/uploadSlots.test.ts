import { describe, expect, test } from 'vitest';
import type { FastifyReply } from 'fastify';
import { uploadSlots } from '../src/usageLimits.js';

function reply() {
  const headers: Record<string, unknown> = {};
  return { headers, reply: { header: (k: string, v: unknown) => void (headers[k] = v) } as unknown as FastifyReply };
}

describe('uploads read at once', () => {
  test('past the limit an upload is refused with a short Retry-After, and a freed slot is usable again', () => {
    const slots = uploadSlots(2);
    const first = slots.take(reply().reply);
    slots.take(reply().reply);
    const busy = reply();
    expect(() => slots.take(busy.reply)).toThrow(/uploads are in progress/);
    expect(busy.headers['retry-after']).toBe(5);

    first();
    first(); // giving a slot back twice frees it once
    expect(slots.inUse).toBe(1);
    expect(() => slots.take(reply().reply)).not.toThrow();
    expect(slots.inUse).toBe(2);
  });
});
