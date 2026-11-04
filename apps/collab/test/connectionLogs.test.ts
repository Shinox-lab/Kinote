import { afterEach, describe, expect, test, vi } from 'vitest';
import { logsConnections } from '../src/serverState.js';
import { connectClient, startCollabServer } from './support/wsClient.js';

describe('per-connection log lines', () => {
  afterEach(() => vi.restoreAllMocks());

  test('only LOG_LEVEL debug or trace asks for them', () => {
    expect(['debug', 'trace'].map(logsConnections)).toEqual([true, true]);
    expect(['info', 'warn', 'error', 'fatal', 'silent'].map(logsConnections)).toEqual([false, false, false, false, false]);
  });

  async function linesFor(logConnections: boolean): Promise<string[]> {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      if (String(args[0]).startsWith('[collab] ws')) lines.push(String(args[0]));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'debug').mockImplementation(capture);
    const { server, port } = await startCollabServer(undefined, { logConnections });
    try {
      // A refused token still connects first, which is all this needs.
      await connectClient({ port, documentName: 'tenant/page/x', token: 'not-a-token', timeoutMs: 3000 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await server.server.destroy();
    }
    return lines;
  }

  test('off by default: a connection writes nothing', async () => {
    expect(await linesFor(false)).toEqual([]);
  });

  test('on: connections are logged', async () => {
    const lines = await linesFor(true);
    expect(lines.some((l) => l.startsWith('[collab] ws connect tenant/page/x'))).toBe(true);
  });
});
