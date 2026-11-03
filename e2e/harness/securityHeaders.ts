// The browser security headers the production nginx sends (apps/web/security-headers.conf
// and the /gridcraft/ location in apps/web/nginx.conf), read from those files so the local
// e2e console (vite preview) runs the specs under the same Content-Security-Policy.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const REPORT_PATH = '/__csp-report';
const ADD_HEADER = /^\s*add_header\s+([A-Za-z-]+)\s+"([^"]*)"\s+always;/gm;

/** `add_header Name "value" always;` lines; headers whose value is an nginx variable are skipped. */
export function parseAddHeaders(conf: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [, name, value] of conf.matchAll(ADD_HEADER)) headers[name!] = value!;
  return headers;
}

/** The body of `location <prefix> { ... }` (no nested blocks in it). */
function locationBlock(conf: string, prefix: string): string {
  const start = conf.indexOf(`location ${prefix} {`);
  if (start < 0) throw new Error(`nginx.conf has no location ${prefix}`);
  return conf.slice(start, conf.indexOf('\n  }', start));
}

export function securityHeadersPlugin(webRoot: string): Plugin {
  const consoleHeaders = parseAddHeaders(fs.readFileSync(path.join(webRoot, 'security-headers.conf'), 'utf8'));
  const gridcraft = parseAddHeaders(locationBlock(fs.readFileSync(path.join(webRoot, 'nginx.conf'), 'utf8'), '^~ /gridcraft/'));
  if (!consoleHeaders['Content-Security-Policy'] || !gridcraft['Content-Security-Policy']) {
    throw new Error('security headers not found in apps/web/security-headers.conf or nginx.conf');
  }
  // Every violation in any spec is reported here and printed, so a blocked
  // resource shows up in the run's output even when the spec still passes.
  consoleHeaders['Content-Security-Policy'] += `; report-uri ${REPORT_PATH}`;
  return {
    name: 'kinote-e2e-security-headers',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (url === REPORT_PATH && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
          req.on('end', () => {
            try {
              const report = JSON.parse(body)['csp-report'] ?? {};
              console.error(`[csp] blocked ${report['blocked-uri']} (${report['violated-directive']}) on ${report['document-uri']}`);
            } catch {
              console.error(`[csp] unreadable report: ${body.slice(0, 200)}`);
            }
            res.statusCode = 204;
            res.end();
          });
          return;
        }
        // The api sets its own headers; the websocket is not a page.
        if (url.startsWith('/api/') || url.startsWith('/mcp') || url.startsWith('/collab')) return next();
        const headers = url.startsWith('/gridcraft/') ? gridcraft : consoleHeaders;
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        next();
      });
    },
  };
}
