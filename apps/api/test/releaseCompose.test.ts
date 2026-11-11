import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

// deploy/docker-compose.release.yml is docker-compose.yml with published images in place of builds (what
// Kinote-SaaS deploys on dedicated instances). This keeps the two from drifting apart.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
type Service = Record<string, unknown> & { environment?: Record<string, unknown> };
type Compose = { services: Record<string, Service>; networks?: unknown; volumes?: unknown };
const read = (file: string) => parse(fs.readFileSync(path.join(root, file), 'utf8'), { merge: true }) as Compose;
const source = read('docker-compose.yml');
const release = read('deploy/docker-compose.release.yml');

/** The published image of each built service. */
const IMAGES: Record<string, string> = {
  postgres: 'postgres',
  migrate: 'migrate',
  api: 'api',
  collab: 'collab',
  worker: 'worker',
  extractor: 'extractor',
  gridcraft: 'gridcraft',
  web: 'web',
};
const imageOf = (name: string) => `ghcr.io/shinox-lab/kinote-${IMAGES[name]}:\${KINOTE_VERSION:?set KINOTE_VERSION}`;
const isApp = (s: Service) => s.environment !== undefined && 'DATABASE_URL' in s.environment;

describe('deploy/docker-compose.release.yml', () => {
  test('has every service of docker-compose.yml', () => {
    expect(Object.keys(release.services).sort()).toEqual(Object.keys(source.services).sort());
  });

  test('every built service uses its published image instead', () => {
    const built = Object.keys(source.services).filter((n) => source.services[n]!.build !== undefined);
    expect(built.sort()).toEqual(Object.keys(IMAGES).sort());
    for (const name of built) {
      expect(release.services[name]!.build, name).toBeUndefined();
      expect(release.services[name]!.image, name).toBe(imageOf(name));
    }
    expect(release.services.minio!.image).toBe(source.services.minio!.image);
  });

  test('maps no host ports', () => {
    for (const [name, s] of Object.entries(release.services)) expect(s.ports, name).toBeUndefined();
  });

  test('gives Coolify a domain for web and for api', () => {
    expect(release.services.web!.environment).toHaveProperty('SERVICE_URL_WEB_80');
    expect(release.services.api!.environment).toHaveProperty('SERVICE_URL_API_8787');
  });

  test('passes the same environment, plus KINOTE_VERSION to the app services', () => {
    for (const [name, s] of Object.entries(source.services)) {
      const expected = Object.keys(s.environment ?? {});
      if (isApp(s)) expected.push('KINOTE_VERSION');
      if (name === 'api') expected.push('SERVICE_URL_API_8787');
      expect(Object.keys(release.services[name]!.environment ?? {}).sort(), name).toEqual(expected.sort());
    }
    expect(release.services.api!.environment!.KINOTE_VERSION).toBe('${KINOTE_VERSION:?set KINOTE_VERSION}');
  });

  test('everything else about each service is the same', () => {
    const rest = ({ build: _b, image: _i, ports: _p, environment: _e, ...other }: Service) => other;
    for (const [name, s] of Object.entries(source.services)) expect(rest(release.services[name]!), name).toEqual(rest(s));
    expect(release.networks).toEqual(source.networks);
    expect(release.volumes).toEqual(source.volumes);
  });
});
