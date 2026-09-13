# Image Target Watcher

Lightweight add-on for DarkNight Home Theater. Admins upload a **target image**;
the bot watches chosen channels and reacts when someone posts a visually similar
image, GIF frame, video frame, custom emoji, or sticker.

This is **not** a full moderation suite — just focused visual matching.

## How matching works

```
IMAGE POSTED
    ↓
Is it image/gif/video/emoji?
   ↙          ↘
 NO           YES
  ↓            ↓
IGNORE      local pHash (dHash + blockHash)
               ↓
         Very obvious match?
          ↙            ↘
        YES            NO (but close)
         ↓              ↓
       MATCH      Jina CLIP embedding
                        ↓
                  cosine similarity
                        ↓
                   MATCH / NO MATCH
```

1. **Local perceptual hash** (always on) — cheap Hamming-distance pre-filter.
   Obvious near-duplicates never call the API.
2. **Jina `jina-clip-v2` embeddings** (optional) — only for the ambiguous band.
   Cosine similarity of L2-normalized vectors, score in `[0, 1]`.

**Similarity score:** cosine similarity after L2-normalization. Default threshold
`0.90` means “vectors are very close,” **not** “90% of pixels are identical.”

Without `JINA_API_KEY`, only the local pHash stage runs (exact / near-exact
duplicates still match).

## Fast setup

1. **Message Content Intent** (required for watching): Discord Developer Portal →
   your app → **Bot** → Privileged Gateway Intents → turn ON **Message Content
   Intent** → Save. Without this, Discord rejects login with `Used disallowed
   intents`. The bot falls back to theater-only mode; image watching stays off
   until the intent is enabled.
2. **Postgres** — Railway → bot service → Variables →
   `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` → redeploy. Tables are created
   on boot.
3. Optional: `JINA_API_KEY` (https://jina.ai/?sui=apikey).
4. Re-register slash commands after deploy:

```bash
npm run register
```

Bot needs in watched channels: **View Channel**, **Read Message History**,
**Manage Messages** (delete), **Send Messages** (warn). Kick/Ban/Moderate
Members only if you pick those actions. The hub only shows permission warnings
when a watched channel is actually missing one of these.

## Commands (hub)

`/image-target` (alias `/imagetrack`) — Manage Guild required.

Opens an ephemeral **Image Target Hub** (no slash subcommand maze):

| Control | What it does |
|---|---|
| **Add image** | Discord file picker modal — attach image/GIF/video |
| **Watch this channel** | Arm live matching in the channel you ran the command in |
| **Unwatch this channel** | Stop watching this channel |
| **Test image** | Dry-run match (no delete / no punish) |
| **Set action** | Pick what happens on a match |
| **Remove target** | Delete a saved target |
| **Refresh** | Reload status + gallery |

Or attach a file on the slash command itself:

```
/image-target image:<file> name:Scam banner
```

That saves the target, **auto-watches the current channel**, prefers
**Delete + warn**, and shows the hub gallery with a preview thumbnail.

### Match actions

`log` · `delete_log` · `delete_warn` (**default**) · `delete_timeout` ·
`delete_kick` · `delete_ban`

Default is **delete + public warn** so matches are visible. Older guilds still
on silent `delete_log` are upgraded when you open the hub or add a target.

Targets are **guild-scoped** — Guild A never affects Guild B.

## Typical flow

```
Admin:  /image-target          (in #general)
Bot:    Hub opens → checklist

Admin:  Add image  (or attach on the slash command)
Bot:    Target saved · gallery shows preview · channel auto-watched

User posts the same image in that channel
Bot:    Deletes message · public warn · logs detection embed
```

**Why test worked but live posts did nothing (before this hub):**

- `/test` never required a watched channel; live matching only runs in channels
  you arm with **Watch this channel** (or auto-watch on add).
- Old default `delete_log` deleted quietly with no public warn; failed deletes
  could look like “success.” Default is now `delete_warn`, and failed deletes
  still warn.

## Modules

| File | Role |
|---|---|
| `phash.js` | dHash + blockHash via `sharp` |
| `providers/types.js` | `ImageSimilarityProvider` interface |
| `providers/jina.js` | Jina CLIP v2 + embedding cache |
| `detector.js` | Two-stage matcher |
| `download.js` | Safe download, SSRF guards, video frame via ffmpeg |
| `store.js` | **Postgres** repository (`DATABASE_URL`) |
| `migrate.js` | Idempotent schema migration on boot |
| `actions.js` | Log / delete / warn / timeout / kick / ban |
| `commands.js` | Slash command → hub |
| `hub.js` | Interactive hub (file upload, gallery, arm channel) |
| `watcher.js` | `messageCreate` / `messageUpdate` listener |
| `../../db/postgres.js` | Shared `pg` pool (Railway TLS) |

## Dev / tests

```bash
IMAGE_TARGET_MEMORY=1 npm run test:image-target
```

In-memory store is for unit tests only. Production uses Postgres.
