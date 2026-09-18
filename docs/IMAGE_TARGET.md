# Image Target Watcher (V2)

Lightweight add-on for DarkNight Home Theater. Admins upload a **target image**;
the bot watches chosen channels and reacts when someone posts a visually similar
image, GIF frame, video frame, custom emoji, or sticker.

This is **not** a full moderation suite — just focused visual matching.

## How matching works (V2)

```
MEDIA POSTED (image / GIF / APNG / video / emoji / sticker / URL)
    ↓
Media sampler (multi-frame for GIF/video; first+last+spaced)
    ↓
Variant normalizer (crop / grayscale / flip / contrast / letterbox)
    ↓
Multi-fingerprint ensemble (dHash + aHash + pHash + blockHash + edge)
    ↓
Local similarity ranking (soft gate — NOT a hard reject)
   ↙                    ↘
obvious local         uncertain / edited
   ↓                       ↓
 MATCH                 Jina CLIP (optional)
                           ↓
                    cosine similarity
                           ↓
                     MATCH / NO MATCH
    ↓
Strongest frame/variant score wins → existing moderation action
```

1. **Multi-frame sampling** — GIFs/APNGs/videos sample across the duration
   (beginning, middle, end). A match on **any** sampled frame counts.
2. **Multi-variant normalization** — center crops, grayscale, flip, mild
   rotation, caption-strip crops improve resistance to borders/captions/edits.
3. **Local hash ensemble** — ranks candidates cheaply. Soft thresholds skip
   clearly unrelated media; edited near-duplicates still reach Jina (or match
   locally when Jina is offline).
4. **Jina `jina-clip-v2` embeddings** (optional) — for the uncertain band.
   Cosine similarity of L2-normalized vectors, score in `[0, 1]`.

**Similarity score:** strongest evidence across frames/variants. Default
embedding threshold `0.90`. Without `JINA_API_KEY`, strong local ensemble hits
still match.

V1 targets (single hash row) keep working via a legacy fingerprint synthesis.

## Fast setup

1. **Message Content Intent** (required for watching): Discord Developer Portal →
   your app → **Bot** → Privileged Gateway Intents → turn ON **Message Content
   Intent** → Save. Without this, Discord rejects login with `Used disallowed
   intents`. The bot falls back to theater-only mode; image watching stays off
   until the intent is enabled.
2. **Postgres** — Railway → bot service → Variables →
   `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` → redeploy. Tables are created
   on boot (including `image_target_fingerprints` for V2).
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
| **Test image** | Dry-run match with V2 score breakdown (no delete / no punish) |
| **Set action** | Pick what happens on a match |
| **Remove target** | Delete a saved target |
| **Refresh** | Reload status + gallery |

Or attach a file on the slash command itself:

```
/image-target image:<file> name:Scam banner
```

That saves the target (with a V2 fingerprint set), **auto-watches the current
channel**, prefers **Delete + warn**, and shows the hub gallery with a preview
thumbnail.

### Match actions

`log` · `delete_log` · `delete_warn` (**default**) · `delete_timeout` ·
`delete_kick` · `delete_ban`

Default is **delete + public warn** so matches are visible. Older guilds still
on silent `delete_log` are upgraded when you open the hub or add a target.

Targets are **guild-scoped** — Guild A never affects Guild B.

## Typical flow

1. `/image-target` → **Add image** (or attach on the slash command).
2. **Watch this channel**.
3. Confirm status shows **ARMED**.
4. Optionally **Test image** to see V2 scores (frame/timestamp/variant/local/Jina).

## Optional V2 env knobs

Safe defaults — usually leave unset:

```
IMAGE_TARGET_MAX_FRAMES=10
IMAGE_TARGET_VIDEO_SAMPLE_COUNT=8
IMAGE_TARGET_MAX_MEDIA_PER_MESSAGE=12
IMAGE_TARGET_MAX_VARIANTS=9
IMAGE_TARGET_ANALYSIS_TIMEOUT_MS=25000
IMAGE_TARGET_FFMPEG_TIMEOUT_MS=15000
IMAGE_TARGET_CONCURRENCY=2
IMAGE_TARGET_EMBEDDING_THRESHOLD=0.9
```

## Tests

```bash
npm run test:image-target
```

## Limits

- Not 100% detection — heavy adversarial edits, tiny crops of a large collage,
  or targets buried in long videos beyond the sample budget can still slip.
- FFmpeg must be available for video (Railway/Nixpacks already installs it).
- Download SSRF protections, size limits, and timeouts still apply.
