import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { CollabServer } from '../src/server.js';
import { startCollabServer } from './support/wsClient.js';

/** Opens a raw socket, sends one binary frame of `bytes`, and resolves the close code (-1: still open after 1 s). */
function sendFrame(port: number, bytes: number): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
    socket.on('error', () => {});
    socket.on('open', () => socket.send(Buffer.alloc(bytes)));
    socket.on('close', (code) => resolve(code));
    setTimeout(() => {
      socket.terminate();
      resolve(-1);
    }, 1_000);
  });
}

describe('live-editing message size limit', () => {
  const limit = 64 * 1024;
  let server: CollabServer;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startCollabServer(undefined, { maxMessageBytes: limit }));
  });

  afterAll(async () => {
    await server.server.destroy();
  });

  test('a frame over the limit closes the socket with 1009 before authentication', async () => {
    expect(await sendFrame(port, limit + 1)).toBe(1009);
  });

  test('a frame within the limit is not refused for its size', async () => {
    // Not a valid Hocuspocus message, so the server may close it, but never as too big.
    expect(await sendFrame(port, limit)).not.toBe(1009);
  });
});
