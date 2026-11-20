# Listen Together

Optional playback synchronization for the Windows SoundCloud client. The host enables it in F1; it stays disconnected otherwise.

## Components

- `worker.mjs`: HTTPS room creation and Durable Object WebSockets.
- `native/src/together.rs`: room lifecycle, heartbeat, reconnect, private host credential.
- `native/frontend/togetherPlayer.ts`: the existing SoundCloud player, explicit pause/play, seek and queue cancellation.
- `docs/join/`: invitation landing page and `scwave://join` handoff.
- `docs/listen-together.json`: compiled service configuration; no secrets.

The host's Discord activity adds a URL button. Its custom label is shared by all viewers; Discord RPC does not supply the viewer's locale. The landing page selects Russian, English or Brazilian Portuguese from the browser language.

## Protocol and privacy

`POST /v1/rooms` returns an opaque room ID, a private host key and a separate read-only invite. WebSockets authenticate with an Authorization header. Neither credential goes in request URLs. The public landing page keeps the read-only invitation in its URL fragment and contains no analytics or third-party requests.

Only track permalink, title, artist, duration, position and play/pause state are broadcast. Each participant obtains audio through their own SoundCloud access. Account tokens, cookies, Discord IDs and audio are never sent to this service.

The host key stays in Rust process memory and never enters RPC, the invitation, settings IPC or disk. Anyone with the invitation can join until the host ends the room or it expires. Closing the app ends its hosted room; an abrupt crash leaves an inactive room until expiry. Invitations are not persistent across client restarts.

Rooms expire after six hours and allow up to 25 connections including the host. Creation is limited to eight rooms per minute per hashed connecting IP. Payloads and message frequency are bounded. No playback history is written to Durable Object storage; the latest state lives in hibernating WebSocket attachments. Ending a room closes its connections and removes its metadata.

## Playback behavior

Guests stop My Wave, disable local autoplay temporarily and follow host changes. Manual playback controls leave the session; volume and likes remain local. Small drift under 1.6 seconds is left alone to avoid constant seeks. Track preparation is cancellable. Unavailable tracks get a bounded retry, while a new host track is accepted immediately. Ads and disconnected hosts pause synchronization. Reconnecting a host preserves its invite. If a player cannot seek, it pauses and displays an explanation instead of playing out of sync.

## Development

`npm run test:together` uses Miniflare and tests two WebSocket peers, host reconnect, invitation parsing and role enforcement. Run frontend checks with `npm run native:test:frontend`.

The ignored Rust integration test `together::tests::two_native_clients_share_live_playback` requires `SC_TOGETHER_TEST_URL`. It creates and ends its own room, without SoundCloud or Discord account changes.

Deploy with Wrangler using `cloudflare/listen-together/wrangler.toml`. Deployment requires Workers Scripts Write and Account Read permissions. Commit the invitation page to the GitHub Pages source at `main:/docs` separately from the app's signed public release.
