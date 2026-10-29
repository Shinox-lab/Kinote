import { describe, test, beforeAll, afterAll, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpCollabClient } from '@kinote/shared';

/**
 * R23: the collab internal endpoints answer 204 on success and nothing else.
 * Any other status (a 200 welcome page from something that is not the collab
 * server, a redirect, an error) must fail the call, never pass as stored.
 */
describe('HttpCollabClient success is 204 only', () => {
  let server: http.Server;
  let base: string;
  let status = 204;
  let replyJson: unknown = null;
  const seen: string[] = [];
  const bodies: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        bodies.push(body);
        if (status === 204) {
          res.writeHead(204);
          res.end();
        } else if (replyJson !== null) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(replyJson));
        } else {
          res.writeHead(status, { 'content-type': 'text/plain' });
          res.end('Welcome to Hocuspocus!');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const client = () => new HttpCollabClient(base, 'x'.repeat(40));

  test('applyBlockOps posts the ops; a 404 block_not_found is that error', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const pageId = '00000000-0000-0000-0000-000000000003';
    const actor = { type: 'agent' as const, id: '00000000-0000-0000-0000-000000000004' };
    status = 204;
    await client().applyBlockOps({ tenantId, pageId, actor, source: 'agent', ops: [{ op: 'remove', blockId: 'b' }] });
    expect(seen.at(-1)).toBe('POST /internal/apply-block-ops');
    expect(JSON.parse(bodies.at(-1)!)).toMatchObject({ actor, source: 'agent', ops: [{ op: 'remove', blockId: 'b' }] });

    status = 404;
    replyJson = { error: 'block_not_found' };
    try {
      await expect(
        client().applyBlockOps({ tenantId, pageId, actor, source: 'agent', ops: [{ op: 'remove', blockId: 'b' }] })
      ).rejects.toMatchObject({ code: 'block_not_found' });
      replyJson = { error: 'page_not_found' };
      await expect(
        client().applyBlockOps({ tenantId, pageId, actor, source: 'agent', ops: [{ op: 'remove', blockId: 'b' }] })
      ).rejects.toMatchObject({ code: 'internal_error' });
    } finally {
      replyJson = null;
    }
  });

  test('204 resolves', async () => {
    status = 204;
    await expect(client().flush('t:p')).resolves.toBeUndefined();
    expect(seen.at(-1)).toBe('POST /internal/flush');
  });

  test('revoke posts tenant_id (and user_id when given) to /internal/revoke', async () => {
    status = 204;
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = '00000000-0000-0000-0000-000000000002';
    await expect(client().revoke({ tenantId, userId })).resolves.toBeUndefined();
    expect(seen.at(-1)).toBe('POST /internal/revoke');
    expect(JSON.parse(bodies.at(-1)!)).toEqual({ tenant_id: tenantId, user_id: userId });
    await client().revoke({ tenantId });
    expect(JSON.parse(bodies.at(-1)!)).toEqual({ tenant_id: tenantId });
  });

  test.each([200, 201, 202, 302, 404, 500])('%i is internal_error', async (code) => {
    status = code;
    await expect(client().flush('t:p')).rejects.toMatchObject({ code: 'internal_error' });
    await expect(
      client().replaceBlocks({
        tenantId: '00000000-0000-0000-0000-000000000001',
        pageId: '00000000-0000-0000-0000-000000000002',
        blocks: [],
        title: 'T',
        actor: { type: 'user', id: '00000000-0000-0000-0000-000000000003' },
        source: 'restore',
      })
    ).rejects.toMatchObject({ code: 'internal_error' });
    await expect(
      client().revoke({ tenantId: '00000000-0000-0000-0000-000000000001' })
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
