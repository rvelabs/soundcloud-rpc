import { connect } from 'cloudflare:sockets';
import { createRelayHandler } from './protocol.mjs';
export default { fetch: createRelayHandler(connect) };
