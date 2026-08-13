# Architecture

A single Node process runs three things that share one in-memory state layer:

1. **Discord bot** (`src/bot/`) — slash commands + buttons.
2. **Web server** (`src/web/`) — REST API + serves the built Activity + WebSocket.
3. **Sync state** (`src/services/sessions.js`) — rooms, playback, presence.

```
src/
├─ index.js              Entry: boots web server + bot, warms library cache.
├─ config.js             Loads/validates env; readiness flags; missing-secret report.
├─ logger.js             Tiny leveled logger.
├─ media/
│  ├─ store.js           Local movie host: registry + folder scan + signed /media URLs.
│  └─ token.js           HMAC signer/verifier for short-lived playback URLs.
├─ services/
│  ├─ json-store.js      Debounced JSON persistence (swap for a DB later).
│  ├─ settings-store.js  Per-guild settings (defaults + overrides).
│  ├─ library-store.js   Thin wrapper over media/store (search/categories/scan).
│  └─ sessions.js        Rooms (clan playback anchor + presence) + private history.
├─ util/auth.js          Verify Discord tokens; OAuth code exchange; requireUser mw.
├─ web/
│  ├─ server.js          Express + static + setup page + /host page + WS attach.
│  ├─ ws.js              WebSocket sync hub (per voice channel room).
│  └─ routes/
│     ├─ api.js          /token /config /library /playback /session /private /settings.
│     ├─ media.js        GET/HEAD /media/:id — HTTP range streaming of local files.
│     └─ host.js         /host uploader page + /api/host/* (list/upload/delete).
└─ bot/
   ├─ client.js          discord.js client + interaction wiring.
   ├─ commands.js        Slash command definitions.
   ├─ register-commands.js
   ├─ permissions.js     canHost / canManage per guild.
   └─ handlers/          watch, theater (control panel), settings, library, format, router.

client/                  The Discord Activity (Vite → dist/public).
├─ src/discord.js        Embedded App SDK handshake (identify + voice channel).
├─ src/sync.js           WebSocket client (auto-reconnect).
├─ src/player.js         hls.js wrapper; drift-corrected sync to the shared anchor.
├─ src/theater.js        DOM theater: screen, seats+avatars, controls, lobby, social.
└─ src/main.js           Wires SDK ↔ sync ↔ player ↔ UI.
```

## The sync model

Playback is stored as an **anchor**, not a ticking clock:

```
{ positionAtUpdate, updatedAt, playing, rate }
livePosition = playing ? positionAtUpdate + (now - updatedAt) * rate : positionAtUpdate
```

Any control action (from the text-channel buttons **or** the Activity) snapshots
the current live position, mutates the anchor, and broadcasts. Clients compute
their target position from the anchor + elapsed time and correct drift:
> 2s → hard seek, > 0.4s → brief `playbackRate` nudge. This keeps a 1hr+ movie in
sync with only occasional messages and survives reconnects.

**Rooms are keyed by voice channel id**, which is why the two surfaces share one
state. Host-only control is enforced in `sessions.control()` (server-side), not
just in the UI.

## Two viewing modes

- **Clan / Watch Party** — one shared room; host drives; everyone follows.
- **Private** — the client plays a personal signed URL locally, no room sync;
  progress is saved to `data/history.json` for resume + history.

## Movie source

Movies are local files under `MEDIA_DIR`. `media/store.js` keeps a small JSON
registry (added via folder scan or the `/host` uploader). `media.js` streams a
file with HTTP **range** support (206 Partial Content), which is what makes
seeking, late joiners, and 1hr+ playback work. Everything is **same-origin** with
the Activity, so there's no external host to proxy or map.

## Security boundary

Playback URLs are short-lived, HMAC-signed (`media/token.js`, keyed by
`SESSION_SECRET`) and verified by the range route, so raw `/media` links can't be
trivially scraped or reused past a session. The `/host` uploader is gated by
`HOST_ADMIN_KEY`. User identity on every API/WS call is verified by asking Discord
who the presented access token belongs to (`util/auth.js`), so a client can't
impersonate another user or become host.

## Extension points (not yet built)

- **Avatars walking to seats** — `theater.js` renders seats declaratively; add a
  CSS transition keyed on seat change.
- **Database** — replace `services/json-store.js` with Redis/Postgres; the store
  interfaces (`settings-store`, `library-store`, `sessions` history) are small.
- **App Directory / discovery** — a Discord review process; the Activity is
  already structured to qualify (responsive, OAuth, URL-mapped).
- **More cosmetics** — extend the `ITEMS` list in `client/src/theater.js` and the
  `giveItem` path; it's already generic.
