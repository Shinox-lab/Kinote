import { collabServerDeps, type CollabServer } from '../../../collab/src/server.js';
import { HttpCollabClient } from '@kinote/shared';

/**
 * The collab client tests hand to the API: the real HTTP transport, looped
 * back to a collab server running in the test process on its ephemeral port,
 * authenticated with that server's internal secret.
 */
export class InProcessCollabClient extends HttpCollabClient {
  constructor(server: CollabServer) {
    super(`http://127.0.0.1:${server.server.address.port}`, collabServerDeps(server).internalSecret);
  }
}
