import { describe, expect, test } from 'vitest';
import { devTargets } from '../dev-targets.js';

describe('devTargets: where the dev console proxies the api and the collab server', () => {
  test('defaults to the stack\'s usual host ports', () => {
    expect(devTargets({})).toEqual({ apiUrl: 'http://127.0.0.1:8787', collabUrl: 'http://127.0.0.1:1234' });
  });

  test('follows the host ports the stack was started with (API_HOST_PORT, COLLAB_HOST_PORT)', () => {
    expect(devTargets({ API_HOST_PORT: '8788', COLLAB_HOST_PORT: '1235' })).toEqual({
      apiUrl: 'http://127.0.0.1:8788',
      collabUrl: 'http://127.0.0.1:1235',
    });
  });

  test('an explicit API_URL or COLLAB_URL wins over the ports', () => {
    expect(devTargets({ API_URL: 'http://10.0.0.5:9000', API_HOST_PORT: '8788', COLLAB_URL: 'http://10.0.0.5:9001' })).toEqual({
      apiUrl: 'http://10.0.0.5:9000',
      collabUrl: 'http://10.0.0.5:9001',
    });
  });

  test('a port that is not a port number is ignored, not proxied to', () => {
    for (const bad of ['', 'abc', '0', '65536', '-1', '80.5', ' 8788']) {
      expect(devTargets({ API_HOST_PORT: bad, COLLAB_HOST_PORT: bad }), `port ${JSON.stringify(bad)}`).toEqual({
        apiUrl: 'http://127.0.0.1:8787',
        collabUrl: 'http://127.0.0.1:1234',
      });
    }
  });
});
