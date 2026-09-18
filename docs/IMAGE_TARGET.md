# Image Target Watcher (V2.1)

Lightweight add-on for DarkNight Home Theater. Admins upload a **target image**;
the bot watches chosen channels and reacts when someone posts a visually similar
image, GIF frame, video frame, custom emoji, or sticker.

This is **not** a full moderation suite — just focused visual matching.

## How matching works (V2.1 Adaptive Deep Detection)

```
MEDIA POSTED (image / GIF / APNG / video / emoji / sticker / URL)
    ↓
Quick scan (bounded frames + variants + multi-hash ensemble)
   ↙                    ↘                    ↘
obvious local         clearly unrelated      uncertain / suspicious
   ↓                       ↓                       ↓
 MATCH                 NO MATCH              DEEP SCAN
                                               ↓
                                    denser GIF/video sampling
                                    deep variants (screenshot /
                                    caption / recolor / crop…)
                                    multi-candidate Jina (optional)
                                               ↓
                                         MATCH / NO MATCH
    ↓
Strongest frame/variant score wins → existing moderation action
```

1. **Quick scan first** — Normal uploads stay fast. Bounded frame sampling,
   a small variant set, and the local hash ensemble decide obvious matches and
   clear misses without deep work.
2. **Adaptive deep scan** — Only when the quick pass is uncertain or
   preliminary relevance still looks suspicious (heavily edited / screenshot /
   mid-GIF / between video samples). Deep scan raises frame/variant budgets,
   densifies GIF/video sampling, and may call Jina on several strongest
   candidates.
3. **Multi-frame sampling** — GIFs/APNGs/videos sample across the duration.
   Deep pass prioritizes first/mid/last + evenly spaced frames, dedupes near-
   identical frames, and keeps the strongest match index/timestamp.
4. **Edit / screenshot resistance** — Deep variants cover borders, letterbox,
   captions, recompression, grayscale, brightness, mirror, crops, mild blur /
   rotate — capped by `IMAGE_TARGET_DEEP_MAX_VARIANTS` (no combinatorial blow-up).
5. **Soft local gates** — Low perceptual-hash scores do **not** hard-reject.
   “Clearly unrelated” vs “heavily edited” are distinguished; Jina can still
   run after an inexpensive relevance check.
6. **Jina `jina-clip-v2`** (optional) — Multi-candidate embeddings during deep
   scan, cached by content hash, capped per media item, early-stop when
   conclusive.
7. **Magic-byte fallbacks** — Missing/misleading MIME or extension is sniffed
   from container bytes; decode failures log and fail safe (watcher does not crash).

**Similarity score:** strongest evidence across frames/variants. Default
embedding threshold `0.90`. Without `JINA_API_KEY`, strong local ensemble hits
(and deep-scan core-hash hits) still match.

V1 targets (single hash row) keep working via a legacy fingerprint synthesis.
Guild isolation is unchanged.

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
| **Test image** | Dry-run match with V2.1 diagnostics (no delete / no punish) |
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
4. Optionally **Test image** to see V2.1 diagnostics: media type, final score,
   decision, method, matching frame/timestamp/variant, local + Jina scores,
   deep scan YES/NO, frames/variants analyzed, Jina calls, escalation reason.

## Optional env knobs

Safe defaults — usually leave unset. Quick path stays fast; deep budgets apply
only on escalation:

```
IMAGE_TARGET_MAX_FRAMES=10
IMAGE_TARGET_DEEP_MAX_FRAMES=18
IMAGE_TARGET_VIDEO_SAMPLE_COUNT=8
IMAGE_TARGET_MAX_MEDIA_PER_MESSAGE=12
IMAGE_TARGET_MAX_VARIANTS=9
IMAGE_TARGET_DEEP_MAX_VARIANTS=14
IMAGE_TARGET_MAX_JINA_CALLS=6
IMAGE_TARGET_ANALYSIS_TIMEOUT_MS=25000
IMAGE_TARGET_DEEP_ANALYSIS_TIMEOUT_MS=35000
IMAGE_TARGET_FFMPEG_TIMEOUT_MS=15000
IMAGE_TARGET_CONCURRENCY=2
IMAGE_TARGET_EMBEDDING_THRESHOLD=0.9
```

## Tests

```bash
npm run test:image-target
```

Covers V1 hub/SSRF/guild isolation, V2 multi-frame/edit paths, and V2.1
adaptive deep scan (mid/late GIF, interstitial video, screenshot/caption/
mirror/recompress edits, MIME fallbacks, budgets, Jina-unavailable, etc.).

## Limits / known limitations

- Not 100% detection — extreme adversarial edits, tiny crops of a large collage,
  or targets buried outside deep-sample budgets can still slip.
- Deep scan improves common Discord evasion (screenshot + border + caption +
  JPEG recompress) but stays bounded; it will not explode CPU/API spend.
- FFmpeg must be available for video (Railway/Nixpacks already installs it).
- Download SSRF protections, size limits, redirects, and timeouts still apply.
