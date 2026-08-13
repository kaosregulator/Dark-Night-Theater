# 🛠️ Setup Guide — DarkNight Home Theater

This walks you from an empty Discord app + Cloudflare account to a running
theater. Everything is driven by secrets you paste in — no code changes needed.

- [1. Create the Discord application](#1-create-the-discord-application)
- [2. Enable the Activity](#2-enable-the-activity)
- [3. Cloudflare Stream](#3-cloudflare-stream)
- [4. Fill in your secrets](#4-fill-in-your-secrets)
- [5. Deploy (Replit or Railway)](#5-deploy)
- [6. URL Mappings (important for video)](#6-url-mappings)
- [7. Register commands & test](#7-register-commands--test)
- [Troubleshooting](#troubleshooting)

---

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **General Information** → copy the **Application ID** → this is `DISCORD_CLIENT_ID`.
3. **OAuth2** → copy the **Client Secret** → `DISCORD_CLIENT_SECRET`.
   (Reset it if it was never shown.)
4. **Bot** (left sidebar) → **Reset Token** → copy → `DISCORD_BOT_TOKEN`.
5. Still on **Bot**, scroll to **Privileged Gateway Intents**. You do **not** need
   Message Content. Leave defaults; the bot uses Guilds + Voice States only.
6. **Installation** (or **OAuth2 → URL Generator**) → scopes `bot` and
   `applications.commands`. Bot permissions needed:
   - **Create Instant Invite** (required — this is how the bot launches the Activity)
   - **Send Messages**, **Embed Links**, **Use Application Commands**
   Invite the bot to your server with the generated URL.

---

## 2. Enable the Activity

1. In your app, open **Activities → Settings** (or **App Settings → Activities**).
2. Turn **Enable Activities** on.
3. You'll set the **URL Mappings** in [step 6](#6-url-mappings) once you know your
   public URL. The root mapping `/` must point to **your deployment's host**.

> The Activity is the in-Discord video surface. It only appears once URL mappings
> point at a reachable HTTPS host (your Replit/Railway URL).

---

## 3. Cloudflare Stream

1. In the Cloudflare dashboard, open **Stream**.
2. **Account ID** — shown in the Stream sidebar → `CLOUDFLARE_ACCOUNT_ID`.
3. **API token** — **My Profile → API Tokens → Create Token**. Use the
   *"Read and write Cloudflare Stream"* template (Read is enough to play; Edit is
   needed if you want `/library` to write categories later). Copy → `CLOUDFLARE_STREAM_API_TOKEN`.
4. Upload some videos to Stream (any length — 1hr+ is fine; HLS handles it).
5. **Categories & titles**: the app reads each video's metadata:
   - **Title** ← the video's `meta.name`.
   - **Category** ← a custom metadata field named `category`. Set it in the Stream
     dashboard on a video (**Settings → Metadata**), or via the API. Videos with
     none show as `Uncategorized`.
6. **Private videos** (optional): toggle **Require signed URLs** on a video to keep
   it protected. Playback then needs a signed token — handled automatically:
   - **Default (no extra secret):** leave the signing-key vars blank; the server
     mints a token via the Cloudflare API using your API token.
   - **Faster (optional):** **Stream → Settings → Create signing key**, then set
     `CLOUDFLARE_STREAM_SIGNING_KEY_ID` and `CLOUDFLARE_STREAM_SIGNING_KEY_PEM`
     (the `pem` value). For multi-line PEM, base64-encode it and set
     `CLOUDFLARE_STREAM_SIGNING_KEY_B64=1`.

---

## 4. Fill in your secrets

Copy `.env.example` → `.env` (local) or add each as a **Secret/Variable** on your
host. Minimum to go live:

```
DISCORD_BOT_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_STREAM_API_TOKEN=...
PUBLIC_BASE_URL=https://your-app.up.railway.app   # or your repl URL
SESSION_SECRET=<any long random string>
ADMIN_USER_IDS=<your Discord user id>
```

---

## 5. Deploy

### Replit
1. Import this repo into Replit.
2. Add the secrets above in the **Secrets** panel (lock icon).
3. Replit uses `.replit` → runs `npm run build && npm start` automatically.
4. Copy the public URL (e.g. `https://dark-night-theater.<you>.repl.co`) into
   `PUBLIC_BASE_URL`, then restart.

### Railway
1. **New Project → Deploy from GitHub** → this repo.
2. Add the secrets as **Variables**.
3. `nixpacks.toml` builds (`npm run build`) and starts (`npm start`) for you.
4. Under **Settings → Networking**, generate a domain, put it in `PUBLIC_BASE_URL`,
   redeploy.

Either way: open the URL. If something's missing you'll see a setup page listing
it. `GET /api/status` returns machine-readable readiness.

---

## 6. URL Mappings

In **Discord Developer Portal → your app → Activities → URL Mappings**:

| Prefix | Target |
| --- | --- |
| `/` | your host, e.g. `your-app.up.railway.app` (no `https://`) |
| `/stream0` | your Cloudflare host, e.g. `customer-<code>.cloudflarestream.com` |
| `/stream1` | `videodelivery.net` |

- Find `customer-<code>.cloudflarestream.com` in any video's playback URL in the
  Stream dashboard (or call `GET /api/config` on your deployment — it lists the
  `streamTargets` the client will proxy).
- The client calls `patchUrlMappings` with these same targets so hls.js requests
  are routed through Discord's proxy — **without these mappings, video won't load
  inside the Activity** even though everything else works.

> If you add videos from a new Cloudflare host later, add a matching `/streamN`
> mapping. `GET /api/config` always shows the current list.

---

## 7. Register commands & test

```bash
npm run register     # one-time (re-run after changing commands)
```
- Set `DISCORD_DEV_GUILD_ID` to your test server id for **instant** command
  registration while developing. Leave it blank in production (global commands
  can take up to ~1h to appear).

Then in Discord:
1. `/library sync` — pulls your Cloudflare videos (staff only).
2. Join a **voice channel**.
3. `/watch` → pick a movie → **Start Watch Party**. A control panel appears in the
   channel; open the **Theater** from the voice channel to watch.
4. Press ▶️ — everyone in the Activity plays in sync.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Setup page instead of the theater | Run `npm run build`; check `/api/status` for missing secrets. |
| Slash commands don't appear | Run `npm run register`; set `DISCORD_DEV_GUILD_ID` for instant dev registration. |
| "Start Watch Party" says it can't launch | Give the bot **Create Instant Invite** permission in that channel. |
| Activity opens but video is black | Add the **`/stream*` URL Mappings** (step 6) for your Cloudflare host(s). |
| Private video won't play | Ensure the API token has Stream read; or set a signing key. Token TTL must exceed movie length (`STREAM_TOKEN_TTL_SECONDS`, default 6h). |
| Library empty | Run `/library sync`; confirm `CLOUDFLARE_ACCOUNT_ID` + token and that videos are **Ready**. |
| Autoplay blocked on mobile | The Theater shows **▶ Tap to start** — that first tap satisfies the browser gesture requirement. |
