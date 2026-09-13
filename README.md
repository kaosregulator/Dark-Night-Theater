# 🎬 DarkNight Home Theater

A **Discord-native social movie theater**. Members join a voice channel, open the
Theater **Activity** (Embedded App SDK), take a seat, grab popcorn, and watch a
movie **together, in sync** — streamed **straight from your own device/files**, no
cloud service required. A host drives play / pause / seek, and those same controls
appear as **live buttons in the Discord text channel** too.

> Built to drop into **Replit** or **Railway**: clone → paste **just your Discord
> token + client id/secret** → `npm run build && npm start`. Add movies from your
> device at `<your-url>/host`. That's it.

---

## How it works (the honest constraints)

Discord has **no** supported way to play a 1‑hour video *inline inside a text
message*, and bots can't stream video into a channel. The **only** supported way
to get real, synced video **inside Discord** is a **Discord Activity** launched in
a **voice channel** — the same mechanism as "Watch Together". So this project uses
**two surfaces that share one state**:

| Surface | Role |
| --- | --- |
| **Text channel** (`/watch`, `/theater`) | Browse the library, launch the party, and **live control buttons** (▶️ ⏸️ ⏪ ⏩ ⏹️ 🔒). Only the host's presses count. |
| **Voice-channel Activity** | The actual theater: the video, seats + Discord avatars, popcorn, synced playback. |

**Where the video comes from:** your own files. You either drop movie files into
the `media/` folder (great when the bot runs on your PC) or **upload them from your
device** at `<your-url>/host` (great on Replit/Railway). The bot serves each file
over HTTP with **range-request** support, so the Theater's HTML5 player streams it
with full **seeking, late-joiner, and 1hr+** support. It's all **same-origin** with
the Activity, so there's no cloud storage, no transcoding service, and no URL
proxying to configure.

**Format note:** browsers play **MP4 (H.264/AAC)** and **WebM**. MKV/AVI won't play
in a browser — remux them to MP4 first. The `/host` page flags non-playable files.

---

## Features

- **`/watch`** — search / browse the library (title, duration, category).
- **In-Discord gamified pre-show** — the `/watch` menu is **private (ephemeral)**,
  but the pre-show is **one public, self-deleting message** the whole channel
  watches: **animated Canvas GIFs** — Box Office → **🎟️ Ticket** (your avatar + seat)
  → **🍿 Popcorn** (random snack) → **🪑 Seat** → **🎬 Enter Theater**, then it vanishes
  as the user drops into the movie. Only the starter can press the buttons.
- **Watch Party (clan)** — synced playback for everyone in the voice channel.
- **Private viewing** — watch on your own, with saved position + resume + history.
- **One host controls** play / pause / seek; **🔒 lock** so only the host drives.
- **Live control panel** posted in the text channel, auto-refreshing.
- **The Theater**: screen, curtains, projector glow, seats with **Discord avatars**,
  join/leave notices, **🍿 popcorn / 🥤 soda / 🍫 candy** social actions.
- **1hr+ videos** via HTTP range streaming from your files.
- **Per-server settings** (`/theater-settings`) — every guild has its own config.
- **Host a movie from your device — temporary, streams as it uploads.** The
  **📤 Host a Movie** button in `/watch` opens a one-tap, pre-authorised uploader
  (no key; knows your server + voice channel). Pick a file → the party **starts
  immediately** and the movie **streams to viewers while it's still uploading**
  (range requests + seeking, 1–3hr+). Your **original file never leaves your
  device**; the server keeps only a **temporary per-party copy that's auto-scrubbed**
  when the party ends, on inactivity, or on restart. **No permanent library.**
- **Responsive** — one build for Desktop, Browser, and Mobile.

---

## Quick start

```bash
git clone <this repo>
cd Dark-Night-Theater
cp .env.example .env         # add DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, PUBLIC_BASE_URL
npm install
npm run build                # builds the Activity frontend
npm run register             # registers slash commands (run once)
npm start
```

Then:
1. Open `<your-url>/host`, enter your admin key, and **drag in a movie** (or drop
   files into the `media/` folder and run `/library sync`).
2. In the Discord Developer Portal, set the Activity **URL mapping**: `/` → your host.
3. Join a voice channel, `/watch`, pick a movie, start the party.
4. Optional: `/emoji` opens the animated-emoji studio (offline MakeEmoji pack —
   fetched on `npm install`; see SETUP.md for Railway notes).

See **[SETUP.md](./SETUP.md)** for the full walkthrough. The app boots even before
secrets are set — visit the URL and it lists what's missing.

### Running on your own PC (optional)
If you'd rather serve big movies straight from your computer, run `npm start`
locally, point `MEDIA_DIR` at a folder of movies, and expose it with a free
temporary tunnel (no signup):

```bash
npx localtunnel --port 3000       # prints an https URL — set it as PUBLIC_BASE_URL
```

As long as your PC is on, it streams. (Your home upload speed limits how many
viewers you can serve smoothly — see SETUP.md.)

---

## ⚖️ Content & liability disclaimer

DarkNight Home Theater is a **player only** — it **owns and stores no third-party
content**. Every movie is served from **the operator's own device/files** that they
add. Whoever supplies content **warrants they purchased and/or fully licensed it**
and is **solely liable** for it. **We do not support pirated, illegal, or
unlicensed content in any form.** Neither this software, its authors, the bot's
operator, nor Discord owns or is responsible for content an operator streams.
Software provided **"AS IS", without warranty**. Full terms:
**[DISCLAIMER.md](./DISCLAIMER.md)**.

---

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/watch [search] [category]` | Everyone | Browse and start a party or private viewing. |
| `/theater` | Everyone | Open the Theater in your voice channel + post live controls. |
| `/library sync` \| `status` | Manage Server / staff | Re-scan the media folder; show where to add movies. |
| `/theater-settings` | Manage Server | Per-server configuration. |
| `/image-target` · `/imagetrack` | Manage Server | Image Target Hub — add images, watch channels, match actions. |

Image-target details (two-stage matching, actions, Jina setup):
**[docs/IMAGE_TARGET.md](./docs/IMAGE_TARGET.md)**.

---

## Security notes

- Movies are served via **short-lived signed `/media` URLs** (HMAC with
  `SESSION_SECRET`) so raw links can't be trivially scraped or shared past a session.
- The `/host` uploader is protected by `HOST_ADMIN_KEY` (falls back to `SESSION_SECRET`).
- API calls are authenticated with the user's Discord token; host-only control is
  enforced **on the server**.

See **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** for a deeper tour.

---

## Add it to an existing bot

Already have a bot? You can bolt this on without overwriting it. If your bot is
**Node.js + discord.js v14**, use the plugin API (`attachTheater` +
`mountTheaterWeb`) to add `/watch`, `/join`, the Activity, and streaming to your
existing client and Express app — your commands keep working. For any other bot
(e.g. discord.py) run it as a companion service. Full guide, examples, and the
honest limits: **[ADDON.md](./ADDON.md)**.
