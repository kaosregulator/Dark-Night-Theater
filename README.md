# 🎬 DarkNight Home Theater

A **Discord-native social movie theater**. Members join a voice channel, open the
Theater **Activity** (Embedded App SDK), take a seat, grab popcorn, and watch a
movie **together, in sync** — streamed straight from your **Cloudflare Stream**
library. A host drives play / pause / seek, and those same controls appear as
**live buttons in the Discord text channel** too.

> Built to drop into **Replit** or **Railway**: clone → paste your secrets →
> `npm run build && npm start`. Nothing is hard-coded; every bot maker uses their
> own Discord app + Cloudflare account.

---

## Why it works this way (the one honest constraint)

Discord has **no** supported way to play a 1‑hour video *inline inside a text
message*, and bots cannot stream video into a channel. The **only** supported way
to get real, synced video **inside Discord** is a **Discord Activity** launched in
a **voice channel** — the same mechanism as "Watch Together / YouTube Together".

So this project uses **two surfaces that share one state**:

| Surface | Role |
| --- | --- |
| **Text channel** (`/watch`, `/theater`) | Browse the library, launch the party, and **live control buttons** (▶️ ⏸️ ⏪ ⏩ ⏹️ 🔒). Only the host's presses count. |
| **Voice-channel Activity** | The actual theater: the Cloudflare HLS video, seats + Discord avatars, popcorn, synced playback. |

Both are keyed by the **voice channel id**, so pressing ▶️ in the channel moves
the video for everyone in the Activity, and vice-versa. That is the closest thing
to "a 1hr movie playing uninterrupted inside a Discord channel, one person in
control" that the platform actually allows — and it genuinely lives in Discord.

---

## Features

- **`/watch`** — search / browse the library (thumbnail, title, duration, category).
- **Watch Party (clan)** — synced playback for everyone in the voice channel.
- **Private viewing** — watch on your own, with saved position + resume + history.
- **One host controls** play / pause / seek; **🔒 lock** so only the host drives.
- **Live control panel** posted in the text channel, auto-refreshing.
- **The Theater**: screen, curtains, projector glow, seats with **Discord avatars**,
  join/leave notices, **🍿 popcorn / 🥤 soda / 🍫 candy** social actions.
- **1hr+ videos** via Cloudflare Stream **HLS** adaptive bitrate.
- **Signed playback** — Cloudflare account id, API token & signing key **never**
  leave the server; the browser only ever gets short-lived signed URLs.
- **Per-server settings** (`/theater-settings`) — every guild has its own config.
- **Admin library sync** (`/library sync`) — pull the whole Cloudflare library.
- **Responsive** — one build for Desktop, Browser, and Mobile.

---

## Quick start

```bash
git clone <this repo>
cd Dark-Night-Theater
cp .env.example .env         # then fill in your secrets
npm install
npm run build                # builds the Activity frontend
npm run register             # registers slash commands (run once)
npm start
```

Then follow **[SETUP.md](./SETUP.md)** to:
1. Create the Discord app + bot and enable the **Activity**.
2. Add your **Cloudflare Stream** account id + API token.
3. Set the **URL Mappings** (root → your host, and Cloudflare → proxied).
4. Deploy on **Replit** or **Railway**.

The app boots even before secrets are set — visit the URL and it shows a setup
page listing exactly what's still missing.

---

## Architecture

```
Discord client ──(voice channel)──► Activity iframe (client/)
      │  slash cmds / buttons              │  Embedded App SDK + hls.js
      ▼                                     ▼
┌──────────────────────────── one Node process (src/) ───────────────────────────┐
│  Discord bot (discord.js)     Express API + static      WebSocket sync hub       │
│  /watch /theater /settings    /api/token /library ...   rooms keyed by channelId │
│         │                          │                          │                  │
│         └──────────► shared session state (services/sessions.js) ◄───────────────┘
│                                    │
│                     Cloudflare Stream client (server-side secrets only)
└─────────────────────────────────────────────────────────────────────────────────┘
```

- `src/` — backend: bot, web server, WebSocket sync, Cloudflare client, stores.
- `client/` — the Discord Activity (Vite → `dist/public`, served by the server).
- `data/` — runtime JSON (per-guild settings, cached library, watch history).

See **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** for a deeper tour.

---

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/watch [search] [category]` | Everyone | Browse and start a party or private viewing. |
| `/theater` | Everyone | Open the Theater in your voice channel + post the control panel. |
| `/library sync` \| `status` | Manage Server / staff | Re-pull the Cloudflare library. |
| `/theater-settings` | Manage Server | Per-server configuration. |

---

## Security notes

- Cloudflare **Account ID, API token, and signing key stay server-side.** The
  browser only receives short-lived **signed playback URLs**.
- API calls are authenticated with the user's Discord token (verified against
  Discord), so clients can't spoof another user.
- Host-only control is enforced **on the server** (`services/sessions.js`), not
  just hidden in the UI.

---

## Roadmap / not yet built

These are intentionally left as clear extension points (documented in
`docs/ARCHITECTURE.md`): avatars physically walking to seats, App Directory
publishing/discovery, a database backend (swap `services/json-store.js`), and
richer social cosmetics. The current build is a complete, runnable v1.
