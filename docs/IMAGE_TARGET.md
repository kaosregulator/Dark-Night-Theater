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

## Setup

1. Enable **Message Content Intent** in the Discord Developer Portal
   (Bot → Privileged Gateway Intents).
2. Optional: set `JINA_API_KEY` in `.env` (free key: https://jina.ai/?sui=apikey).
3. Restart the bot and re-register slash commands:

```bash
npm run register
npm start
```

Bot needs permissions in watched channels: **View Channel**, **Read Message
History**, **Manage Messages** (to delete), plus Kick/Ban/Moderate Members if
you enable those actions.

## Commands

`/image-target` (alias `/imagetrack`) — Manage Guild required.

| Subcommand | Purpose |
|---|---|
| `add` | Upload image/GIF/video → save as target |
| `list` | List targets for this server |
| `remove` | Remove by name or ID |
| `enable` / `disable` | Toggle a target |
| `test` | Dry-run match (no delete / no punish) |
| `channel` | Add / remove / list watched channels |
| `threshold` | Set cosine similarity threshold |
| `action` | `log` · `delete_log` (default) · `delete_warn` · `delete_timeout` · `delete_kick` · `delete_ban` |
| `log-channel` | Where detection embeds are posted |
| `escalation` | Optional strike ladder: warn → timeout → kick → ban |
| `status` | Overview for this server |

Targets are **guild-scoped** — Guild A never affects Guild B.

## Typical flow

```
Admin:  /image-target add  (+ attach scam.png)  name: Scam Image
Bot:    ✅ Target Scam Image saved.

Admin:  /image-target channel action:add channel:#image-check
Bot:    ✅ Now watching #image-check

User posts the same image (any filename) in #image-check
Bot:    🚨 Target image detected — 97.4% · deletes message · logs
```

## Modules

| File | Role |
|---|---|
| `phash.js` | dHash + blockHash via `sharp` |
| `providers/types.js` | `ImageSimilarityProvider` interface |
| `providers/jina.js` | Jina CLIP v2 + embedding cache |
| `detector.js` | Two-stage matcher |
| `download.js` | Safe download, SSRF guards, video frame via ffmpeg |
| `store.js` | JSON store (`data/image-targets.json`) |
| `actions.js` | Log / delete / warn / timeout / kick / ban |
| `commands.js` | Slash command handlers |
| `watcher.js` | `messageCreate` / `messageUpdate` listener |

## Security

- File extensions are not trusted — content is validated with `sharp`.
- Downloads: size cap (8 MB), timeout, redirect limit, private/link-local SSRF block.
- No dependence on Discord attachment URLs for matching — only visual content.

## Tests

```bash
node --test src/bot/image-target/__tests__/image-target.test.js
```
