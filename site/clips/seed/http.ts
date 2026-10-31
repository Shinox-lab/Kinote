import type { APIRequestContext } from '@playwright/test';
import type { DemoHttp } from '../../../packages/core/src/demo/seed';
import { call } from '../../../e2e/support';

/** The demo's api access over a Playwright request context (a stack running at its baseURL). */
export function playwrightHttp(request: APIRequestContext): DemoHttp {
  return {
    json: (path, o = {}) => call(request, path, o),
    async upload({ account, tenantId, spaceId, file }) {
      const res = await request.fetch('/api/v1/files', {
        method: 'POST',
        headers: { authorization: `Bearer ${account.token}`, 'x-tenant-id': tenantId },
        multipart: { space_id: spaceId, file: { name: file.name, mimeType: file.mimeType, buffer: file.buffer } },
      });
      const text = await res.text();
      if (!res.ok()) throw new Error(`upload ${file.name} -> ${res.status()} ${text}`);
      return (JSON.parse(text) as { document: { id: string } }).document.id;
    },
  };
}
