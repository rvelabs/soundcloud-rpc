import { connect } from 'cloudflare:sockets';
import { createRelayHandler } from './protocol.mjs';
import { createPublicPlaylistHandler } from './playlist-source.mjs';
const tunnel = createRelayHandler(connect),
    source = createPublicPlaylistHandler();
export default {
    fetch(request, env) {
        return new URL(request.url).pathname === '/playlist-source' ? source(request, env) : tunnel(request, env);
    },
};
