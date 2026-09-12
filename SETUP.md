# 🛠️ Setup Guide — DarkNight Home Theater

From an empty Discord app to a running theater. Movies come from **your own
files** — there's no cloud service to configure.

- [1. Create the Discord application](#1-create-the-discord-application)
- [2. Enable the Activity](#2-enable-the-activity)
- [3. Fill in your secrets](#3-fill-in-your-secrets)
- [4. Deploy (Replit or Railway)](#4-deploy)
- [5. URL Mapping](#5-url-mapping)
- [6. Add movies](#6-add-movies)
- [7. Register commands & watch](#7-register-commands--watch)
- [Running from your own PC + free tunnel](#running-from-your-own-pc)
- [Troubleshooting](#troubleshooting)

---

## 1. Create the Discord application

1. <https://discord.com/developers/applications> → **New Application**.
2. **General Information** → copy **Application ID** → `DISCORD_CLIENT_ID`.
3. **OAuth2** → copy **Client Secret** → `DISCORD_CLIENT_SECRET`.
4. **Bot** → **Reset Token** → copy → `DISCORD_BOT_TOKEN`.
5. **Installation** (or **OAuth2 → URL Generator**): scopes `bot` +
   `applications.commands`. Bot permissions:
   - **Create Instant Invite** (required — this launches the Activity)
   - **Send Messages**, **Embed Links**, **Attach Files**, **Use Application Commands**
   Invite the bot to your server with the generated URL.

---

## 2. Enable the Activity

1. In your app → **Activities → Settings** → turn **Enable Activities** on.
2. Under **Supported Platforms**, check **Web**, **iOS**, and **Android**.
   - If iOS/Android are unchecked, phones show: **“This Activity is not currently available on this OS”** — that message comes from Discord, not this app.
3. You'll set the URL mapping in [step 5](#5-url-mapping) once you have a public URL.

---

## 3. Fill in your secrets

Copy `.env.example` → `.env` (local) or add each as a **Secret/Variable** on your
host. The whole required set is just:

```
DISCORD_BOT_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
PUBLIC_BASE_URL=https://your-app.up.railway.app   # or your repl URL
SESSION_SECRET=<any long random string>
HOST_ADMIN_KEY=<a password for the /host uploader>   # optional; defaults to SESSION_SECRET
ADMIN_USER_IDS=<your Discord user id>
```

That's it — no Cloudflare, no storage keys.

---

## 4. Deploy

### Replit
1. Import this repo. Add the secrets above in the **Secrets** panel.
2. `.replit` runs `npm run build && npm start` automatically.
3. Copy the public URL into `PUBLIC_BASE_URL`, restart.

### Railway
1. **New Project → Deploy from GitHub** → this repo. Add the secrets as **Variables**.
2. `nixpacks.toml` builds and starts it.
3. **Settings → Networking** → generate a domain → put it in `PUBLIC_BASE_URL`, redeploy.

Open the URL. Missing something? The page (and `GET /api/status`) tells you.

> **Disk note:** uploaded movies live on the server's disk. Replit/Railway
> containers have limited, **ephemeral** disk — big libraries may exceed it and
> reset on redeploy. For a large permanent library, run from a machine with real
> disk (see [Running from your own PC](#running-from-your-own-pc)).

---

## 5. URL Mapping

In **Developer Portal → your app → Activities → URL Mappings**, add **one** row:

| Prefix | Target |
| --- | --- |
| `/` | your host, e.g. `your-app.up.railway.app` (no `https://`) |

That's all — movies are served from the same host, so there's nothing else to map.

---

## 6. Add movies

Three ways, use whichever:

- **From inside `/watch` (easiest, temporary):** run `/watch` in a voice channel
  and tap **📤 Host a Movie (from my device)**. It opens a one-tap uploader (no
  key — it already knows your server + voice channel); pick a file and the party
  **starts immediately and streams while it uploads**. The server copy is
  **temporary** and auto-deleted when the party ends. **Keep the host tab open**
  while watching — it's feeding the stream. For smooth *watch-while-uploading*,
  use **WebM** or **faststart MP4** (moov atom at the front); a normal MP4 still
  plays but may need more of the file before it starts. Shown to hosts/admins.
- **Upload page directly:** open `https://<PUBLIC_BASE_URL>/host`, enter your
  admin key, and **drag in** a movie. It appears in `/watch` right away.
- **Drop files in the folder:** put files in the `media/` folder (or wherever
  `MEDIA_DIR` points), then run **`/library sync`** in Discord.

**Format:** use **MP4 (H.264/AAC)** or **WebM**. MKV/AVI won't play in browsers —
remux to MP4 first (e.g. `ffmpeg -i in.mkv -c copy out.mp4` if the codecs are
already H.264/AAC, otherwise transcode). The `/host` page flags non-playable files.

---

## 7. Register commands & watch

```bash
npm run register     # one-time (re-run after changing commands)
```
Set `DISCORD_DEV_GUILD_ID` to your test server id for **instant** registration
while developing (global commands can take up to ~1h).

Then in Discord:
1. `/library sync` (or upload at `/host`) so movies show up.
2. Join a **voice channel**.
3. `/watch` → pick a movie → walk the pre-show → **Enter Theater**. Everyone in the
   Activity plays in sync; the host drives ▶️/⏸️/⏪/⏩.

---

## Running from your own PC

Great for big libraries / serving straight off your drive:

1. `npm install && npm run build`
2. Point `MEDIA_DIR` at your movies folder (or drop files into `media/`).
3. Expose it with a **free, temporary tunnel** (no signup):
   ```bash
   npx localtunnel --port 3000
   ```
   It prints an `https://…loca.lt` URL — set that as `PUBLIC_BASE_URL`, and use it
   for the Activity URL mapping. (Cloudflare Tunnel `cloudflared` works too.)
4. `npm start`. As long as your PC is on, it streams.

**Reality check:** your **home upload speed** is the ceiling — ~5–8 Mbps per 1080p
viewer, so most connections comfortably serve a handful of friends, not a crowd.
The laptop must stay awake/online for the whole movie.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Setup page instead of the theater | Run `npm run build`; check `/api/status` for missing secrets. |
| Slash commands don't appear | `npm run register`; set `DISCORD_DEV_GUILD_ID` for instant dev registration. |
| "Start Watch Party" can't launch | Give the bot **Create Instant Invite** permission in that channel. |
| Library empty | Upload at `/host` or drop files in `media/`, then `/library sync`. |
| Video is black / won't play | Discord only paints **H.264 + AAC**. MovieBox/HEVC files auto-convert after upload (wait for “Converting…” to finish), or re-encode with HandBrake **Fast 1080p30**. |
| “▶ Tap to start” does nothing | Tap again after convert finishes; keep the host upload tab open. |
| “not currently available on this OS” | Developer Portal → Activities → Settings → enable **iOS** and **Android**. |
| `/host` says "Bad admin key" | Use `HOST_ADMIN_KEY` (or `SESSION_SECRET` if you left it blank). |
| Buffering with several viewers | You're limited by the host's upload bandwidth — fewer viewers or a bigger pipe. |
| Autoplay blocked on mobile | The Theater shows **▶ Tap to start** — that first tap satisfies the browser. |
