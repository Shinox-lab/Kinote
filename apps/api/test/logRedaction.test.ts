import { describe, expect, test } from 'vitest';
import { buildApiServer } from '../src/server.js';
import { loggableUrl } from '../src/logger.js';

describe('secrets in request URLs never reach the log', () => {
  test('a media link token is replaced', () => {
    expect(loggableUrl('/api/v1/media/eyJ0ZW5hbnQ.c2lnbmF0dXJl')).toBe('/api/v1/media/[redacted]');
    expect(loggableUrl('/api/v1/media/abc.def?x=1')).toBe('/api/v1/media/[redacted]?x=1');
    expect(loggableUrl('/api/v1/files/123')).toBe('/api/v1/files/123');
  });

  test('the request log line of a media request has no token', async () => {
    const lines: string[] = [];
    const app = buildApiServer({ logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } } });
    try {
      await app.inject({ method: 'GET', url: '/api/v1/media/secret-part.secret-signature' });
      const logged = lines.join('\n');
      expect(logged).toContain('/api/v1/media/[redacted]');
      expect(logged).not.toContain('secret-part');
    } finally {
      await app.close();
    }
  });
});
