import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';

// docker-compose.yml (also the Coolify deployment) lists the services' environment one
// variable at a time: a setting missing there never reaches the api or worker, silently.
const compose = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docker-compose.yml'),
  'utf8'
);
/**
 * Read only by `pnpm db:migrate`, never by a service; or baked into release
 * images (KINOTE_VERSION: passing it here would hide the baked value).
 */
const NOT_A_SERVICE_SETTING = new Set(['DATABASE_MIGRATE_URL', 'KINOTE_VERSION']);

describe('docker-compose.yml', () => {
  it('passes every service setting to the containers', () => {
    const keys = Object.keys(ConfigSchema.innerType().shape).filter((k) => !NOT_A_SERVICE_SETTING.has(k));
    const missing = keys.filter((k) => !new RegExp(`^  ${k}:`, 'm').test(compose));
    expect(missing).toEqual([]);
  });
});
